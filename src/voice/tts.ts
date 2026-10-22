/**
 * Cliente de síntesis de voz en streaming (Deepgram Aura en Workers AI).
 *
 * Se abre un WebSocket por frase, se manda el texto y Aura devuelve el audio
 * en trozos. Importa que el primer trozo llegue rápido: es lo que se mide
 * como `tts_first_chunk_ms` y es lo que decide si la respuesta "suena"
 * inmediata o si el usuario oye un hueco.
 *
 * El protocolo de Aura por WebSocket es de dos pasos: se manda `Speak` con el
 * texto y luego `Flush`, que es lo que le dice al modelo "ya no esperes más,
 * sintetiza". El audio llega en trozos binarios y el cierre se avisa con un
 * mensaje de control `Flushed`.
 *
 * Voz: `aura-2-es` con el hablante `estrella` (español de México).
 * Configurable con `SPIKE_TTS_MODEL` / `SPIKE_TTS_VOICE`.
 */

import { logger } from '../lib/logger';
import { conectaWebSocket } from './stt';

/** Modelo de TTS por defecto (Deepgram Aura en español). */
export const TTS_MODELO_DEFECTO = '@cf/deepgram/aura-2-es';
/** Hablante por defecto: español de México. */
export const TTS_VOZ_DEFECTO = 'estrella';
/** Frecuencia de salida del audio sintetizado. */
export const TTS_SAMPLE_RATE = 24_000;

export interface OpcionesTts {
  /** Token de API de Cloudflare con permiso `Workers AI: Edit`. */
  apiToken: string;
  /** Cuenta de Cloudflare donde vive el modelo. */
  accountId: string;
  modelo?: string;
  voz?: string;
  sampleRate?: number;
  /** Reloj inyectable para las pruebas (milisegundos). */
  ahora?: () => number;
}

/**
 * URL del endpoint de síntesis en streaming de Workers AI.
 *
 * El modelo va en la ruta tal cual (codificarlo rompe el enrutado). `speaker`
 * es el hablante de Aura: `estrella` es el de español de México.
 */
export function urlTtsWorkersAi(accountId: string, modelo: string, voz: string): string {
  const params = new URLSearchParams({
    encoding: 'linear16',
    container: 'none',
    speaker: voz,
  });
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelo}?${params.toString()}`;
}

/**
 * Contrato mínimo que consume el orquestador (facilita el doble de prueba).
 *
 * `hablar()` resuelve cuando Aura terminó de mandar audio (o cuando se
 * canceló); `cancelar()` corta la reproducción en curso: es lo que hace el
 * barge-in cuando el usuario interrumpe.
 */
export interface TtsLike {
  hablar(texto: string): Promise<void>;
  cancelar(): void;
  cerrar(): void;
}

/** Mensaje de control que cierra la locución. */
interface ControlTts {
  type?: string;
}

/**
 * Cliente de TTS de Aura (Workers AI) por WebSocket.
 */
export class WorkersAiTts implements TtsLike {
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
    return urlTtsWorkersAi(this.opciones.accountId, this.modelo, this.voz);
  }

  async hablar(texto: string): Promise<void> {
    this.cancelar();
    const promesa = new Promise<void>((resolve) => {
      this.resolverActual = resolve;
      void this.sintetiza(texto, resolve);
    });
    this.actual = promesa;
    return promesa;
  }

  /** Abre el socket, pide la síntesis y va soltando el audio en trozos. */
  private async sintetiza(texto: string, resuelve: () => void): Promise<void> {
    let socket: WebSocket;
    try {
      socket = await conectaWebSocket(this.url(), {
        Authorization: `Bearer ${this.opciones.apiToken}`,
      });
    } catch (error) {
      logger.warn('Spike de voz: no se pudo abrir el WebSocket de TTS', {
        error: error instanceof Error ? error.message : String(error),
      });
      resuelve();
      return;
    }
    this.ws = socket;

    let primerChunk = true;
    socket.addEventListener('message', (evento) => {
      if (typeof evento.data === 'string') {
        // Control: `Flushed` avisa que ya no hay más audio.
        try {
          const control = JSON.parse(evento.data) as ControlTts;
          if (control.type === 'Flushed') resuelve();
        } catch {
          // Control ilegible: se ignora.
        }
        return;
      }
      if (primerChunk) {
        primerChunk = false;
        this.onPrimerChunk?.(this.ahora());
      }
      void this.entregaAudio(evento.data);
    });
    socket.addEventListener('close', () => {
      this.ws = null;
      resuelve();
    });
    socket.addEventListener('error', () => {
      this.ws = null;
      resuelve();
    });

    try {
      socket.send(JSON.stringify({ type: 'Speak', text: texto }));
      socket.send(JSON.stringify({ type: 'Flush' }));
    } catch {
      resuelve();
    }
  }

  /**
   * Entrega el audio al pipeline.
   *
   * Las tramas binarias llegan como `Blob` desde la fecha de compatibilidad
   * 2026-03-17 (antes `ArrayBuffer`): se acepta cualquiera de las dos.
   */
  private async entregaAudio(datos: ArrayBuffer | Blob | ArrayBufferView): Promise<void> {
    if (datos instanceof Blob) {
      this.alRecibir(await datos.arrayBuffer());
      return;
    }
    if (ArrayBuffer.isView(datos)) {
      this.alRecibir(
        datos.buffer.slice(datos.byteOffset, datos.byteOffset + datos.byteLength) as ArrayBuffer
      );
      return;
    }
    this.alRecibir(datos);
  }

  /** Corta la locución en curso (barge-in). */
  cancelar(): void {
    try {
      this.ws?.close();
    } catch {
      // Si la conexión ya estaba cerrada, no hay nada que cortar.
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
 * Sin token de Workers AI no hay cliente: se devuelve `null` y quien llama
 * falla de forma explícita. Nunca se sintetiza audio falso.
 */
export function crearTts(
  env: {
    CF_AI_API_TOKEN?: string;
    CF_AI_ACCOUNT_ID?: string;
    SPIKE_TTS_MODEL?: string;
    SPIKE_TTS_VOICE?: string;
  },
  alRecibir: (chunk: ArrayBuffer) => void,
  onPrimerChunk?: (momentoMs: number) => void,
  ahora?: () => number
): WorkersAiTts | null {
  if (!env.CF_AI_API_TOKEN || !env.CF_AI_ACCOUNT_ID) {
    logger.warn(
      'Spike de voz: falta CF_AI_API_TOKEN o CF_AI_ACCOUNT_ID, la locución no puede arrancar'
    );
    return null;
  }
  return new WorkersAiTts(
    {
      apiToken: env.CF_AI_API_TOKEN,
      accountId: env.CF_AI_ACCOUNT_ID,
      modelo: env.SPIKE_TTS_MODEL ?? TTS_MODELO_DEFECTO,
      voz: env.SPIKE_TTS_VOICE ?? TTS_VOZ_DEFECTO,
      ahora,
    },
    alRecibir,
    onPrimerChunk
  );
}
