/**
 * Cliente de síntesis de voz en streaming (Deepgram Aura).
 *
 * Se abre un WebSocket por frase, se manda el texto y Deepgram devuelve el
 * audio en trozos. Importa que el primer trozo llegue rápido: es lo que se
 * mide como `tts_first_chunk_ms` y lo que decide si la respuesta "suena"
 * inmediata o si el usuario oye un hueco.
 *
 * Voz: `aura-2-estrella-es` (español de México). Configurable con
 * `SPIKE_TTS_MODEL` / `SPIKE_TTS_VOICE`.
 */

import { logger } from '../lib/logger';
import { abreWebSocket } from './stt';

/** Modelo de TTS por defecto (Deepgram Aura). */
export const TTS_MODELO_DEFECTO = 'aura-2';
/** Voz por defecto: español de México. */
export const TTS_VOZ_DEFECTO = 'estrella-es';
/** Frecuencia de salida del audio sintetizado. */
export const TTS_SAMPLE_RATE = 24_000;

export interface OpcionesTts {
  apiKey: string;
  modelo?: string;
  voz?: string;
  sampleRate?: number;
  /** Reloj inyectable para las pruebas (milisegundos). */
  ahora?: () => number;
}

/** Contrato mínimo que consume el orquestador (facilita el doble de prueba). */
export interface TtsLike {
  hablar(texto: string): Promise<void>;
  cancelar(): void;
  cerrar(): void;
}

/**
 * Cliente de TTS de Deepgram por WebSocket.
 *
 * `hablar()` resuelve cuando Deepgram terminó de mandar audio (o cuando se
 * canceló); `cancelar()` corta la reproducción en curso: es lo que hace el
 * barge-in cuando el usuario interrumpe.
 */
export class DeepgramTts implements TtsLike {
  private ws: WebSocket | null = null;
  private actual: Promise<void> | null = null;
  private resolverActual: (() => void) | null = null;
  private readonly modelo: string;
  private readonly voz: string;
  private readonly sampleRate: number;
  private readonly ahora: () => number;

  constructor(
    private readonly opciones: OpcionesTts,
    private readonly alRecibir: (chunk: ArrayBuffer) => void,
    private readonly onPrimerChunk?: (momentoMs: number) => void
  ) {
    this.modelo = opciones.modelo ?? TTS_MODELO_DEFECTO;
    this.voz = opciones.voz ?? TTS_VOZ_DEFECTO;
    this.sampleRate = opciones.sampleRate ?? TTS_SAMPLE_RATE;
    this.ahora = opciones.ahora ?? (() => Date.now());
  }

  private url(): string {
    const params = new URLSearchParams({
      model: this.modelo,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
    });
    return `wss://api.deepgram.com/v1/speak?${params.toString()}`;
  }

  private headers(): Record<string, string> {
    const cabeceras: Record<string, string> = {
      Authorization: `Token ${this.opciones.apiKey}`,
      'Content-Type': 'text/plain',
    };
    // La voz va en el cuerpo (Deepgram TTS la acepta ahí), pero se manda
    // también como cabecera para los despliegues que lo exigen.
    cabeceras['X-DG-Voice'] = this.voz;
    return cabeceras;
  }

  hablar(texto: string): Promise<void> {
    this.cancelar();
    const promesa = new Promise<void>((resolve) => {
      this.resolverActual = resolve;
      this.conecta(texto, resolve);
    });
    this.actual = promesa;
    return promesa;
  }

  private conecta(texto: string, resuelve: () => void): void {
    let ws: WebSocket;
    try {
      ws = abreWebSocket(this.url(), this.headers());
    } catch (error) {
      logger.warn('Spike de voz: no se pudo abrir el WebSocket de TTS', {
        error: error instanceof Error ? error.message : String(error),
      });
      resuelve();
      return;
    }
    this.ws = ws;

    let primerChunk = true;
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ text: texto, voice: this.voz }));
      } catch {
        resuelve();
      }
    });
    ws.addEventListener('message', (evento) => {
      if (typeof evento.data === 'string') {
        // Metadata de cierre: Deepgram manda un JSON final antes de cerrar.
        resuelve();
        return;
      }
      if (primerChunk) {
        primerChunk = false;
        this.onPrimerChunk?.(this.ahora());
      }
      this.alRecibir(evento.data as ArrayBuffer);
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      resuelve();
    });
    ws.addEventListener('error', () => {
      this.ws = null;
      resuelve();
    });
  }

  /** Corta la locución en curso (barge-in). */
  cancelar(): void {
    try {
      this.ws?.close();
    } catch {
      // Si ya estaba cerrada, no hay nada que cortar.
    }
    this.ws = null;
    this.resolverActual?.();
    this.resolverActual = null;
  }

  cerrar(): void {
    this.cancelar();
    this.actual = null;
  }
}

/**
 * Crea el cliente de TTS con la configuración del entorno.
 *
 * Sin `DEEPGRAM_API_KEY` no hay cliente: se devuelve `null` y quien llama
 * falla de forma explícita. Nunca se sintetiza audio falso.
 */
export function crearTts(
  env: { DEEPGRAM_API_KEY?: string; SPIKE_TTS_MODEL?: string; SPIKE_TTS_VOICE?: string },
  alRecibir: (chunk: ArrayBuffer) => void,
  onPrimerChunk?: (momentoMs: number) => void,
  ahora?: () => number
): DeepgramTts | null {
  if (!env.DEEPGRAM_API_KEY) {
    logger.warn('Spike de voz: falta DEEPGRAM_API_KEY, la locución no puede arrancar');
    return null;
  }
  return new DeepgramTts(
    {
      apiKey: env.DEEPGRAM_API_KEY,
      modelo: env.SPIKE_TTS_MODEL ?? TTS_MODELO_DEFECTO,
      voz: env.SPIKE_TTS_VOICE ?? TTS_VOZ_DEFECTO,
      ahora,
    },
    alRecibir,
    onPrimerChunk
  );
}
