/**
 * Pipeline de voz del spike: STT → LLM → TTS, con barge-in.
 *
 * El orden de una llamada:
 *
 *   navegador ─PCM─► STT (Deepgram, parciales + final)
 *                      │
 *                      ├─ parcial durante la locución ─► barge-in: se corta el TTS
 *                      │
 *                      └─ final ─► LLM (Workers AI vía `redactMessage`) ─► TTS (Aura) ─► navegador
 *
 * Decisiones que importan:
 *
 * · El LLM es `redactMessage` de `src/ai/agent.ts`, **sin modificarlo**: en
 *   "modo lectura" el bot redacta el aviso de cobranza y lo dice en voz alta.
 *   No es un agente conversacional (eso es Sprint 6, con prompts de voz
 *   propios): aquí lo que se mide es la latencia de la cadena.
 * · El barge-in se decide con el STT: si llega un parcial mientras el TTS
 *   habla, el usuario interrumpió. Se corta el TTS en el acto y se anota la
 *   latencia de interrupción.
 * · Cada turno deja un registro de métricas (`MetricasTurno`) que el
 *   `CallSessionDO` acumula. Aquí no se guarda ni audio ni transcripción: el
 *   spike no guarda la voz del deudor (ver `docs/spike-voz.md`).
 */

import { redactMessage, type RedactParams } from '../ai/agent';
import { createLoggerWithTrace } from '../lib/logger';
import type { ScoreBand } from '../lib/score';
import type { Env } from '../types/env';
import { crearStt, type EventosStt, type SttLike } from '../voice/stt';
import { crearTts, type TtsLike } from '../voice/tts';

/** Datos del deudor que necesita el LLM para redactar el aviso. */
export interface ClienteVoz {
  nombre: string;
  montoCents: number;
  /** Fecha de vencimiento en ISO corto (`YYYY-MM-DD`). */
  fechaVencimiento: string;
  diasRetraso: number;
  band: ScoreBand;
  nombreLegal?: string;
  condusef?: string;
}

/** Métricas de un turno completo (una intervención del usuario + su respuesta). */
export interface MetricasTurno {
  /** Primer parcial del STT, desde el inicio del turno del usuario. */
  stt_partial_ms: number | null;
  /** Transcripción final del STT, desde el inicio del turno del usuario. */
  stt_final_ms: number | null;
  /** Primer token observable del LLM. */
  llm_first_token_ms: number | null;
  /** LLM completo. */
  llm_total_ms: number | null;
  /** Primer fragmento de audio del TTS, desde el inicio de la locución. */
  tts_first_chunk_ms: number | null;
  /** Usuario termina de hablar → primer audio de la respuesta. */
  round_trip_ms: number | null;
  /** Interrupción detectada → TTS cortado. */
  barge_in_latency_ms: number | null;
}

/** Eventos que el pipeline emite hacia el Durable Object. */
export type EventoVoz =
  | { tipo: 'parcial'; texto: string; momentoMs: number }
  | { tipo: 'final'; texto: string; momentoMs: number }
  | { tipo: 'tts_chunk'; bytes: number }
  | { tipo: 'barge_in'; momentoMs: number }
  | { tipo: 'fin_turno'; metricas: MetricasTurno }
  | { tipo: 'error'; mensaje: string };

/** Fábrica de STT: recibe los eventos y devuelve el cliente (o `null`). */
export type FabricaStt = (eventos: EventosStt) => SttLike | null;

/** Fábrica de TTS: recibe el audio y el aviso del primer fragmento. */
export type FabricaTts = (
  alRecibir: (chunk: ArrayBuffer) => void,
  onPrimerChunk: (momentoMs: number) => void
) => TtsLike | null;

export interface OpcionesPipeline {
  env: Env;
  callId: string;
  tenantId: string;
  traceId: string;
  cliente: ClienteVoz;
  alEvento: (evento: EventoVoz) => void;
  /** Fábricas de STT y TTS: el pipeline es siempre quien las arma y las conecta. */
  crearStt?: FabricaStt;
  crearTts?: FabricaTts;
  /** Redactor (por defecto, `redactMessage` de `src/ai/agent.ts`). */
  redactar?: (env: Env, params: RedactParams) => Promise<{ body: string; source: string }>;
  /** Reloj inyectable (milisegundos). */
  ahora?: () => number;
}

/** Contrato del pipeline: lo que el DO necesita saber. */
export interface PipelineVoz {
  /** Recibe audio PCM del navegador (16 kHz, mono, 16 bits). */
  recibirAudio(chunk: ArrayBuffer): void;
  /** Corta la locución en curso (barge-in). */
  cortarLocucion(): void;
  /** Cierra todo (fin de llamada). */
  cerrar(): void;
  /** ¿Hay una locución en curso? */
  locutando(): boolean;
}

/** Métricas vacías (todas pendientes). */
export function metricasVacias(): MetricasTurno {
  return {
    stt_partial_ms: null,
    stt_final_ms: null,
    llm_first_token_ms: null,
    llm_total_ms: null,
    tts_first_chunk_ms: null,
    round_trip_ms: null,
    barge_in_latency_ms: null,
  };
}

/**
 * Pipeline de voz del spike.
 *
 * La clase se construye con las piezas ya resueltas (STT, TTS y la función de
 * redacción): en producción las arma `crearPipelineVoz` con Deepgram y
 * Workers AI; en las pruebas se inyectan dobles.
 */
export class PipelineVozImpl implements PipelineVoz {
  private readonly ahora: () => number;
  private readonly log;
  private readonly stt: SttLike | null;
  private readonly tts: TtsLike | null;

  /** Inicio del turno de audio del usuario (para medir STT parcial/final). */
  private turnoInicioMs = 0;
  /** Momento del final de la transcripción (base del round-trip). */
  private finalMs = 0;
  /** Momento en que arrancó la locución. */
  private locucionInicioMs = 0;
  private enLocucion = false;
  private cerrado = false;

  /** Métricas del turno en curso. */
  private metricas: MetricasTurno = metricasVacias();

  constructor(private readonly opciones: OpcionesPipeline) {
    this.ahora = opciones.ahora ?? (() => Date.now());
    this.log = createLoggerWithTrace('spike-voz', {
      traceId: opciones.traceId,
      spanId: 'spik-voz',
      sampled: true,
    });

    const eventos: EventosStt = {
      onParcial: (texto, momento) => this.onParcial(texto, momento),
      onFinal: (texto, momento) => {
        void this.onFinal(texto, momento);
      },
      onError: (error) => this.opciones.alEvento({ tipo: 'error', mensaje: error.message }),
      onAbierto: () => {
        this.log.info('STT abierto', { callId: opciones.callId });
      },
    };

    this.stt = opciones.crearStt?.(eventos) ?? null;
    this.tts =
      opciones.crearTts?.(
        (chunk) => this.opciones.alEvento({ tipo: 'tts_chunk', bytes: chunk.byteLength }),
        (momento) => this.onPrimerChunkTts(momento)
      ) ?? null;
  }

  /** ¿Hay una locución en curso? */
  locutando(): boolean {
    return this.enLocucion;
  }

  /** Abre el STT si hace falta (la fábrica puede devolver `null`). */
  abrir(): void {
    this.stt?.abrir();
  }

  /** Recibe audio PCM del navegador. */
  recibirAudio(chunk: ArrayBuffer): void {
    if (this.cerrado) return;
    if (!this.turnoInicioMs) this.turnoInicioMs = this.ahora();
    this.stt?.enviar(new Uint8Array(chunk));
  }

  /**
   * Transcripción parcial: el usuario sigue hablando.
   *
   * Si el bot está hablando, esto es una interrupción: se corta el TTS.
   */
  onParcial(texto: string, momentoMs: number): void {
    if (this.cerrado) return;
    if (this.enLocucion) {
      this.cortarLocucion();
      this.metricas.barge_in_latency_ms = Math.max(0, this.ahora() - momentoMs);
      this.log.info('Barge-in: se corta la locución', { texto });
      this.opciones.alEvento({ tipo: 'barge_in', momentoMs });
      return;
    }
    // El primer parcial del turno marca cuándo el STT empezó a devolver texto.
    if (this.metricas.stt_partial_ms === null) {
      this.metricas.stt_partial_ms = Math.max(0, momentoMs - this.turnoInicioMs);
    }
    this.opciones.alEvento({ tipo: 'parcial', texto, momentoMs });
  }

  /**
   * Transcripción final: terminó el turno del usuario.
   *
   * Aquí arranca la respuesta: LLM y después TTS. El round-trip se mide
   * desde este instante hasta el primer fragmento de audio.
   */
  async onFinal(texto: string, momentoMs: number): Promise<void> {
    if (this.cerrado) return;
    this.finalMs = momentoMs;
    if (!this.turnoInicioMs) this.turnoInicioMs = momentoMs;

    this.metricas.stt_partial_ms =
      this.metricas.stt_partial_ms ?? this.finalMs - this.turnoInicioMs;
    this.metricas.stt_final_ms = this.finalMs - this.turnoInicioMs;
    this.opciones.alEvento({ tipo: 'final', texto, momentoMs });

    // ── LLM (Workers AI vía redactMessage, sólo lectura) ──
    const inicioLlm = this.ahora();
    let cuerpo = '';
    try {
      const redactar =
        opcionesRedactar(this.opciones.redactar) ??
        ((env: Env, params: RedactParams) => redactMessage(env, params));
      const resultado = await redactar(this.opciones.env, {
        channel: 'sms',
        clientName: this.opciones.cliente.nombre,
        amountCents: this.opciones.cliente.montoCents,
        dueDate: this.opciones.cliente.fechaVencimiento,
        diasRetraso: this.opciones.cliente.diasRetraso,
        band: this.opciones.cliente.band,
        nombreLegal: this.opciones.cliente.nombreLegal,
        condusef: this.opciones.cliente.condusef,
      });
      cuerpo = resultado.body;
    } catch (error) {
      this.log.error('El LLM falló en el spike de voz', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.opciones.alEvento({
        tipo: 'error',
        mensaje: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.metricas.llm_total_ms = this.ahora() - inicioLlm;
    // `redactMessage` usa la llamada sin streaming de Workers AI: el primer
    // token observable llega junto con la respuesta completa. Se registra
    // igual para tener la serie, y queda anotado como deuda (Sprint 6:
    // variante streaming del agente).
    this.metricas.llm_first_token_ms = this.metricas.llm_total_ms;

    // ── TTS ──
    if (!cuerpo || !this.tts) {
      this.opciones.alEvento({ tipo: 'fin_turno', metricas: this.metricas });
      this.cierraTurno();
      return;
    }

    const inicioTts = this.ahora();
    this.locucionInicioMs = inicioTts;
    this.enLocucion = true;
    this.ttsPrimerChunkMs = null;
    await this.tts.hablar(cuerpo);
    this.enLocucion = false;

    this.metricas.tts_first_chunk_ms =
      this.metricas.tts_first_chunk_ms ?? Math.max(0, this.ahora() - inicioTts);
    this.metricas.round_trip_ms =
      this.metricas.round_trip_ms ?? Math.max(0, this.locucionInicioMs - this.finalMs);

    this.opciones.alEvento({ tipo: 'fin_turno', metricas: this.metricas });
    this.cierraTurno();
  }

  /** Momento del primer fragmento de audio del TTS. */
  private ttsPrimerChunkMs: number | null = null;

  private onPrimerChunkTts(momentoMs: number): void {
    this.ttsPrimerChunkMs = momentoMs;
    this.metricas.tts_first_chunk_ms = Math.max(0, momentoMs - this.locucionInicioMs);
    this.metricas.round_trip_ms = Math.max(0, momentoMs - this.finalMs);
  }

  /** Reinicia el contador del turno. */
  private cierraTurno(): void {
    this.metricas = metricasVacias();
    this.turnoInicioMs = 0;
    this.finalMs = 0;
    this.ttsPrimerChunkMs = null;
  }

  /** Corta la locución en curso (interrupción). */
  cortarLocucion(): void {
    if (!this.enLocucion) return;
    this.tts?.cancelar();
    this.enLocucion = false;
  }

  /** Cierra el pipeline. */
  cerrar(): void {
    this.cerrado = true;
    try {
      this.stt?.cerrar();
      this.tts?.cerrar();
    } catch {
      // Cerrar dos veces no es un error que valga la pena propagar.
    }
  }
}

/** El redactor por defecto es `redactMessage` de `src/ai/agent.ts`. */
function opcionesRedactar(
  inyectado?: (env: Env, params: RedactParams) => Promise<{ body: string; source: string }>
): ((env: Env, params: RedactParams) => Promise<{ body: string; source: string }>) | null {
  return inyectado ?? null;
}

/**
 * Arma el pipeline real: Deepgram para STT/TTS y Workers AI para el LLM.
 *
 * Si falta la clave de Deepgram devuelve `null`: el spike **no** simula voz.
 * Quien llama decide qué hacer con la llamada (en la ruta, responder 503).
 */
export function crearPipelineVoz(opciones: OpcionesPipeline): PipelineVozImpl | null {
  const { env } = opciones;
  if (!env.DEEPGRAM_API_KEY) {
    opciones.alEvento({
      tipo: 'error',
      mensaje: 'Falta DEEPGRAM_API_KEY: el spike no puede transcribir ni locutar.',
    });
    return null;
  }

  const log = createLoggerWithTrace('spike-voz', {
    traceId: opciones.traceId,
    spanId: 'spik-voz',
    sampled: true,
  });

  const pipeline = new PipelineVozImpl({
    ...opciones,
    crearStt: (eventos) => crearStt(env, eventos, opciones.ahora),
    crearTts: (alRecibir, onPrimerChunk) => crearTts(env, alRecibir, onPrimerChunk, opciones.ahora),
  });
  pipeline.abrir();
  log.info('Pipeline de voz del spike listo', { callId: opciones.callId });

  return pipeline;
}
