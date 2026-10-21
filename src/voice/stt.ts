/**
 * Cliente de transcripción en streaming (Deepgram).
 *
 * El spike habla con la API de Deepgram por WebSocket: se abre una conexión
 * con el modelo en español, se empujan tramas de PCM y Deepgram devuelve
 * parciales mientras el usuario habla y un final cuando cierra el turno.
 *
 * Por qué esto y no el REST: el barge-in necesita saber *mientras* el usuario
 * habla que está hablando. Con REST sólo se sabría al terminar la frase, y
 * el TTS seguiría sonando medio segundo de más.
 *
 * Idioma y modelo: `nova-2` en español (`es`), que es la decisión del spike.
 * El modelo se puede cambiar por `SPIKE_STT_MODEL` sin tocar el código.
 */

import { logger } from '../lib/logger';

/** Modelo de transcripción (Deepgram). */
export const STT_MODELO_DEFECTO = 'nova-2';
/** Idioma de la transcripción: español. */
export const STT_IDIOMA_DEFECTO = 'es';
/** Frecuencia de muestreo del PCM que se envía (el navegador remuestrea a 16 kHz). */
export const STT_SAMPLE_RATE = 16_000;

/** Eventos que emite el cliente de transcripción. */
export interface EventosStt {
  /** Transcripción parcial (el usuario sigue hablando). */
  onParcial?: (texto: string, momentoMs: number) => void;
  /** Transcripción final (el turno del usuario terminó). */
  onFinal?: (texto: string, momentoMs: number) => void;
  /** Error de transporte o de proveedor. */
  onError?: (error: Error) => void;
  /** La conexión quedó abierta y lista para audio. */
  onAbierto?: () => void;
}

export interface OpcionesStt {
  apiKey: string;
  modelo?: string;
  idioma?: string;
  sampleRate?: number;
  /** Reloj inyectable para las pruebas (milisegundos). */
  ahora?: () => number;
}

/**
 * Abre un WebSocket con cabeceras.
 *
 * En el runtime de Cloudflare el constructor acepta `{ headers }`; el tipo
 * que trae `lib.dom` no lo conoce, así que se tipa aquí el constructor real.
 */
export function abreWebSocket(url: string, cabeceras: Record<string, string>): WebSocket {
  const ctor = globalThis.WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> }
  ) => WebSocket;
  return new ctor(url, { headers: cabeceras });
}

/** Contrato mínimo que consume el orquestador (facilita el doble de prueba). */
export interface SttLike {
  abrir(): void;
  enviar(pcm: Uint8Array): void;
  cerrar(): void;
}

interface RespuestaDeepgram {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
}

/**
 * Cliente de STT de Deepgram por WebSocket.
 *
 * Cada instancia es una llamada: una conexión, un turno de audio, un cierre.
 */
export class DeepgramStt implements SttLike {
  private ws: WebSocket | null = null;
  private cerrado = false;
  private readonly modelo: string;
  private readonly idioma: string;
  private readonly sampleRate: number;
  private readonly ahora: () => number;

  constructor(
    private readonly opciones: OpcionesStt,
    private readonly eventos: EventosStt
  ) {
    this.modelo = opciones.modelo ?? STT_MODELO_DEFECTO;
    this.idioma = opciones.idioma ?? STT_IDIOMA_DEFECTO;
    this.sampleRate = opciones.sampleRate ?? STT_SAMPLE_RATE;
    this.ahora = opciones.ahora ?? (() => Date.now());
  }

  /** URL del endpoint de escucha en streaming. */
  private url(): string {
    const params = new URLSearchParams({
      model: this.modelo,
      language: this.idioma,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      vad_events: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  abrir(): void {
    if (this.ws) return;
    try {
      this.ws = abreWebSocket(this.url(), { Authorization: `Token ${this.opciones.apiKey}` });
    } catch (error) {
      this.eventos.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.ws.addEventListener('open', () => this.eventos.onAbierto?.());
    this.ws.addEventListener('message', (evento) => this.manejaMensaje(evento));
    this.ws.addEventListener('error', () => {
      this.eventos.onError?.(new Error('Deepgram STT: error de WebSocket'));
    });
    this.ws.addEventListener('close', () => {
      this.ws = null;
    });
  }

  private manejaMensaje(evento: MessageEvent): void {
    if (typeof evento.data !== 'string') return;
    let cuerpo: RespuestaDeepgram;
    try {
      cuerpo = JSON.parse(evento.data) as RespuestaDeepgram;
    } catch {
      return;
    }
    if (cuerpo.type !== 'Results') return;

    const texto = cuerpo.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
    if (!texto) return;

    const momento = this.ahora();
    if (cuerpo.is_final) {
      this.eventos.onFinal?.(texto, momento);
    } else {
      this.eventos.onParcial?.(texto, momento);
    }
  }

  enviar(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1 || this.cerrado) return;
    this.ws.send(pcm as unknown as ArrayBuffer);
  }

  cerrar(): void {
    this.cerrado = true;
    try {
      this.ws?.close();
    } catch {
      // Si la conexión ya estaba caída, no hay nada que cerrar.
    }
    this.ws = null;
  }
}

/**
 * Crea el cliente de STT con la configuración del entorno.
 *
 * Sin `DEEPGRAM_API_KEY` no hay cliente: se devuelve `null` y quien llama
 * falla de forma explícita. Nunca se simula una transcripción.
 */
export function crearStt(
  env: { DEEPGRAM_API_KEY?: string; SPIKE_STT_MODEL?: string },
  eventos: EventosStt,
  ahora?: () => number
): DeepgramStt | null {
  if (!env.DEEPGRAM_API_KEY) {
    logger.warn('Spike de voz: falta DEEPGRAM_API_KEY, la transcripción no puede arrancar');
    return null;
  }
  return new DeepgramStt(
    {
      apiKey: env.DEEPGRAM_API_KEY,
      modelo: env.SPIKE_STT_MODEL ?? STT_MODELO_DEFECTO,
      ahora,
    },
    eventos
  );
}
