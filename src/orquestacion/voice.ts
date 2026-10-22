/**
 * Pipeline de voz del spike: STT → LLM → TTS, con barge-in.
 *
 * El orden de una llamada:
 *
 *   navegador ─PCM─► STT (Workers AI · Nova-3, parciales + final)
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

import {
  redactMessage,
  redactMessageVozStream,
  type RedactParams,
  type RedactVozParams,
} from '../ai/agent';
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
  /** Redactor en streaming para voz (emite chunks de texto conforme llegan). */
  redactarStream?: (env: Env, params: RedactVozParams) => AsyncGenerator<string, void, unknown>;
  /** Reloj inyectable (milisegundos). */
  ahora?: () => number;
}

/** Contrato del pipeline: lo que el DO necesita saber. */
export interface PipelineVoz {
  /**
   * Abre el STT y **resuelve cuando ya está conectado**.
   *
   * El socket del STT vive en el contexto de la petición que lo abre, así que
   * hay que abrirlo *antes* de responder al cliente: si se abre después, el
   * runtime lo cierra y la transcripción no llega.
   */
  abrir(): Promise<void>;
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
 * Estado de un turno: sus métricas y sus marcas de tiempo.
 *
 * Vive dentro del turno, no en la instancia: así dos turnos que se pisan (el
 * usuario habla otra vez antes de que el bot termine) no se arruinan entre sí.
 */
interface TurnoVoz {
  metricas: MetricasTurno;
  /** Inicio del audio del usuario (para medir STT parcial/final). */
  turnoInicioMs: number;
  /** Momento del final de la transcripción (base del round-trip). */
  finalMs: number;
  /** Momento en que arrancó la locución. */
  locucionInicioMs: number;
}

/**
 * Pipeline de voz del spike.
 *
 * La clase se construye con las piezas ya resueltas (STT, TTS y la función de
 * redacción): en producción las arma `crearPipelineVoz` con Workers AI
 * (Nova-3 para el STT y Aura para el TTS); en las pruebas se inyectan dobles.
 */
export class PipelineVozImpl implements PipelineVoz {
  private readonly ahora: () => number;
  private readonly log;
  private readonly stt: SttLike | null;
  private readonly tts: TtsLike | null;

  private enLocucion = false;
  private cerrado = false;

  /**
   * Turno en curso.
   *
   * Cada turno lleva **sus propias** métricas y marcas de tiempo. Antes eran
   * campos de la instancia y eso corrompía las cifras: si el usuario volvía a
   * hablar antes de que el bot terminara, el `fin_turno` del turno anterior
   * borraba las marcas del nuevo y la latencia medida salía absurda.
   */
  private turno: TurnoVoz | null = null;

  /** Cola de turnos: se procesan de uno en uno, en orden. */
  private cola: Promise<void> = Promise.resolve();

  /** Inicio del audio del usuario en curso (para medir STT parcial/final). */
  private inicioAudioMs = 0;
  /** Latencia del primer parcial de la utterance en curso. */
  private sttPartialMs: number | null = null;
  /** Latencia del barge-in de la utterance en curso. */
  private bargeInMs: number | null = null;

  /**
   * Turno al que pertenece la locución en curso.
   *
   * El TTS avisa del primer fragmento por un callback que comparte toda la
   * vida del cliente, así que sin esto un fragmento que llega tarde (por
   * ejemplo, de una locución ya cortada) se le atribuye al turno que toque y
   * se MIXTURA con sus marcas de tiempo.
   */
  private turnoDeLocucion: TurnoVoz | null = null;

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

  /**
   * Abre el STT si hace falta (la fábrica puede devolver `null`).
   *
   * Es asíncrono a propósito: el socket del STT tiene que quedar **establecido**
   * dentro del contexto de la petición que lo abre. Si se abre "en volando"
   * (después de que la petición ya respondió), el runtime lo cierra al terminar
   * el contexto y la transcripción nunca llega.
   */
  async abrir(): Promise<void> {
    await this.stt?.abrir();
  }

  /** Recibe audio PCM del navegador. */
  recibirAudio(chunk: ArrayBuffer): void {
    if (this.cerrado) return;
    if (!this.inicioAudioMs) this.inicioAudioMs = this.ahora();
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
      this.bargeInMs = Math.max(0, this.ahora() - momentoMs);
      if (this.turno) this.turno.metricas.barge_in_latency_ms = this.bargeInMs;
      this.log.info('Barge-in: se corta la locución', { texto });
      this.opciones.alEvento({ tipo: 'barge_in', momentoMs });
      return;
    }
    // El primer parcial de la utterance marca cuándo el STT empezó a devolver
    // texto. Se guarda fuera del turno: el parcial llega antes del final, que
    // es lo que abre el turno.
    if (this.sttPartialMs === null) {
      this.sttPartialMs = Math.max(0, momentoMs - (this.inicioAudioMs || momentoMs));
    }
    this.opciones.alEvento({ tipo: 'parcial', texto, momentoMs });
  }

  /**
   * Transcripción final: terminó el turno del usuario.
   *
   * Los turnos se procesan **de uno en uno**: si el usuario vuelve a hablar
   * mientras el bot contesta, el turno nuevo espera a que termine el otro.
   * Sin esto, los dos turnos comparten estado y las métricas salen mezcladas.
   */
  onFinal(texto: string, momentoMs: number): Promise<void> {
    this.cola = this.cola.then(() => this.procesaTurno(texto, momentoMs));
    return this.cola;
  }

  /**
   * Procesa un turno: LLM (streaming) y TTS.
   *
   * El round-trip se mide desde el final de la transcripción hasta el primer
   * fragmento de audio. Con streaming, el TTS empieza con la primera frase.
   */
  private async procesaTurno(texto: string, momentoMs: number): Promise<void> {
    if (this.cerrado) return;

    const turno: TurnoVoz = {
      metricas: metricasVacias(),
      turnoInicioMs: this.inicioAudioMs || momentoMs,
      finalMs: momentoMs,
      locucionInicioMs: 0,
    };
    this.turno = turno;

    turno.metricas.stt_partial_ms = this.sttPartialMs ?? momentoMs - turno.turnoInicioMs;
    turno.metricas.stt_final_ms = momentoMs - turno.turnoInicioMs;
    turno.metricas.barge_in_latency_ms = this.bargeInMs;
    this.opciones.alEvento({ tipo: 'final', texto, momentoMs });

    // ── LLM (streaming para voz) ──
    const inicioLlm = this.ahora();
    let primerTokenRegistrado = false;
    let cuerpoCompleto = '';
    let primeraFraseEnviada = false;

    try {
      const redactarStream = this.opciones.redactarStream;
      if (redactarStream) {
        // Modo streaming: enviamos la primera frase al TTS apenas la tengamos
        for await (const chunk of redactarStream(this.opciones.env, {
          clientName: this.opciones.cliente.nombre,
          amountCents: this.opciones.cliente.montoCents,
          dueDate: this.opciones.cliente.fechaVencimiento,
          diasRetraso: this.opciones.cliente.diasRetraso,
          band: this.opciones.cliente.band,
          nombreLegal: this.opciones.cliente.nombreLegal,
          condusef: this.opciones.cliente.condusef,
        })) {
          if (!primerTokenRegistrado) {
            turno.metricas.llm_first_token_ms = this.ahora() - inicioLlm;
            primerTokenRegistrado = true;
          }
          cuerpoCompleto += chunk;

          // Detectar fin de frase (. ? !) para enviar al TTS
          if (!primeraFraseEnviada) {
            const match = cuerpoCompleto.match(/^[^.!?]*[.!?]/);
            if (match) {
              const primeraFrase = match[0].trim();
              if (primeraFrase && this.tts) {
                primeraFraseEnviada = true;
                const inicioTts = this.ahora();
                turno.locucionInicioMs = inicioTts;
                this.enLocucion = true;
                this.turnoDeLocucion = turno;
                // No esperamos: lanzamos el TTS en background
                void this.tts.hablar(primeraFrase);
              }
            }
          }
        }
        // Si no hubo streaming (fallback), usamos el redactar síncrono
        if (!primerTokenRegistrado) {
          throw new Error('Streaming vacío, fallback a síncrono');
        }
      } else {
        // Fallback síncrono (compatibilidad con WhatsApp/SMS)
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
        cuerpoCompleto = resultado.body;
      }
    } catch (error) {
      this.log.error('El LLM falló en el spike de voz', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.opciones.alEvento({
        tipo: 'error',
        mensaje: error instanceof Error ? error.message : String(error),
      });
      this.cierraTurno(turno);
      return;
    }

    turno.metricas.llm_total_ms = this.ahora() - inicioLlm;
    if (!primerTokenRegistrado) {
      turno.metricas.llm_first_token_ms = turno.metricas.llm_total_ms;
    }

    // ── TTS ──
    // Si ya enviamos la primera frase en streaming, esperamos a que termine el TTS actual
    // Si no hubo streaming, enviamos el cuerpo completo ahora
    if (!cuerpoCompleto && !primeraFraseEnviada) {
      this.opciones.alEvento({ tipo: 'fin_turno', metricas: turno.metricas });
      this.cierraTurno(turno);
      return;
    }

    if (!primeraFraseEnviada && this.tts && cuerpoCompleto) {
      // Modo síncrono: enviamos todo el texto
      const inicioTts = this.ahora();
      turno.locucionInicioMs = inicioTts;
      this.enLocucion = true;
      this.turnoDeLocucion = turno;
      await this.tts.hablar(cuerpoCompleto);
      this.enLocucion = false;
      this.turnoDeLocucion = null;

      turno.metricas.tts_first_chunk_ms =
        turno.metricas.tts_first_chunk_ms ?? Math.max(0, this.ahora() - inicioTts);
      turno.metricas.round_trip_ms =
        turno.metricas.round_trip_ms ?? Math.max(0, turno.locucionInicioMs - turno.finalMs);
    } else if (primeraFraseEnviada) {
      // Modo streaming: esperamos a que el TTS de la primera frase termine
      // El callback onPrimerChunkTts ya registró tts_first_chunk_ms y round_trip_ms
      // Esperamos a que enLocucion sea false (el TTS terminó o fue cortado)
      while (this.enLocucion && !this.cerrado) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    this.opciones.alEvento({ tipo: 'fin_turno', metricas: turno.metricas });
    this.cierraTurno(turno);
  }

  /**
   * Primer fragmento de audio del TTS.
   *
   * Se atribuye al turno que pidió la locución: si el fragmento llega tarde
   * (locución ya cortada) se descarta, porque si no las marcas se mezclan y
   * la latencia sale con valores absurdos.
   */
  private onPrimerChunkTts(momentoMs: number): void {
    const turno = this.turnoDeLocucion;
    if (!turno || !turno.locucionInicioMs) return;
    turno.metricas.tts_first_chunk_ms = Math.max(0, momentoMs - turno.locucionInicioMs);
    turno.metricas.round_trip_ms = Math.max(0, momentoMs - turno.finalMs);
  }

  /**
   * Cierra el turno: deja el contador de audio en cero para que el siguiente
   * turno mida desde su propio audio, y suelta el turno en curso.
   */
  private cierraTurno(turno: TurnoVoz): void {
    if (this.turno === turno) this.turno = null;
    this.inicioAudioMs = 0;
    this.sttPartialMs = null;
    this.bargeInMs = null;
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
 * Arma el pipeline real: Workers AI (Deepgram Nova-3 y Aura) para STT/TTS y
 * Workers AI para el LLM (streaming, modelo chico, prompt de voz).
 *
 * Si falta el token de Workers AI devuelve `null`: el spike **no** simula voz.
 * Quien llama decide qué hacer con la llamada (en la ruta, responder 503).
 */
export function crearPipelineVoz(opciones: OpcionesPipeline): PipelineVozImpl | null {
  const { env } = opciones;
  if (!env.CF_AI_API_TOKEN || !env.CF_AI_ACCOUNT_ID) {
    opciones.alEvento({
      tipo: 'error',
      mensaje:
        'Faltan CF_AI_API_TOKEN o CF_AI_ACCOUNT_ID: el spike no puede transcribir ni locutar.',
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
    redactarStream: (env: Env, params: RedactVozParams) => redactMessageVozStream(env, params),
  });
  pipeline.abrir();
  log.info('Pipeline de voz del spike listo (streaming + modelo voz)', { callId: opciones.callId });

  return pipeline;
}
