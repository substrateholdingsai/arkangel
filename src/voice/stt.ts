/**
 * Cliente de transcripción en streaming (Deepgram Nova-3 en Workers AI).
 *
 * El spike habla con Workers AI por WebSocket: se abre una conexión con el
 * modelo en español, se empujan tramas de PCM y Deepgram devuelve parciales
 * mientras el usuario habla y un final cuando cierra el turno.
 *
 * Por qué Workers AI y no la API de Deepgram: el mismo modelo de Deepgram
 * (`nova-3`) está en el catálogo de Workers AI y habla por WebSocket, así que
 * el spike no necesita una cuenta nueva de Deepgram. Es una decisión de
 * proveedor, documentada en `docs/spike-voz.md`.
 *
 * Por qué esto y no el REST: el barge-in necesita saber *mientras* el usuario
 * habla que está hablando. Con REST sólo se sabría al terminar la frase, y el
 * TTS seguiría sonando medio segundo de más.
 *
 * Por qué `fetch` con `Upgrade` y no `new WebSocket(url, { headers })`: en el
 * runtime de Cloudflare el segundo argumento del constructor de `WebSocket` es
 * la lista de subprotocolos, no las cabeceras, así que un `Authorization`
 * enviado así nunca llega al servidor. La forma de mandarlo es una petición
 * con `Upgrade: websocket`.
 */

import { logger } from '../lib/logger';

/** Modelo de transcripción (Deepgram Nova-3 en Workers AI). */
export const STT_MODELO_DEFECTO = '@cf/deepgram/nova-3';
/** Idioma de la transcripción: español. */
export const STT_IDIOMA_DEFECTO = 'es';
/** Frecuencia de muestreo del PCM que se envía (el navegador remuestrea a 16 kHz). */
export const STT_SAMPLE_RATE = 16_000;

/**
 * Abre un WebSocket autenticado contra un servicio de Cloudflare.
 *
 * En el runtime de Cloudflare el handshake se hace con una petición que
 * lleva `Upgrade: websocket` y se espera un 101: `fetch` no acepta el
 * esquema `wss:`, así que la URL se pasa a `https:` (el resultado es el mismo
 * socket). Por eso la URL se construye como `wss://` y se traduce aquí.
 */
export async function conectaWebSocket(
  url: string,
  cabeceras: Record<string, string>
): Promise<WebSocket> {
  const respuesta = await fetch(url.replace(/^wss:/, 'https:'), {
    headers: { ...cabeceras, Upgrade: 'websocket' },
  });
  const socket = respuesta.webSocket;
  if (!socket) {
    const detalle = await respuesta.text().catch(() => '');
    throw new Error(
      `El servidor no aceptó el WebSocket (HTTP ${respuesta.status})${detalle ? `: ${detalle}` : ''}`
    );
  }
  // Las tramas binarias llegan como `Blob` desde la fecha de compatibilidad
  // 2026-03-17: se pide `ArrayBuffer` explícitamente (hay que hacerlo antes
  // de `accept()`).
  socket.binaryType = 'arraybuffer';
  socket.accept();
  return socket;
}

/**
 * URL del endpoint de escucha en streaming de Workers AI.
 *
 * El modelo va en la ruta tal cual (codificarlo rompe el enrutado) y los
 * parámetros de audio viajan en la query, como espera el modelo.
 */
export function urlSttWorkersAi(
  accountId: string,
  modelo: string,
  idioma: string,
  sampleRate: number
): string {
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    language: idioma,
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });
  return `wss://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelo}?${params.toString()}`;
}

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
  /** Token de API de Cloudflare con permiso `Workers AI: Read`. */
  apiToken: string;
  /** Cuenta de Cloudflare donde vive el modelo. */
  accountId: string;
  modelo?: string;
  idioma?: string;
  sampleRate?: number;
  /** Reloj inyectable para las pruebas (milisegundos). */
  ahora?: () => number;
}

/** Contrato mínimo que consume el orquestador (facilita el doble de prueba). */
export interface SttLike {
  /**
   * Abre el socket y **resuelve cuando ya está establecido**.
   *
   * La espera importa: el socket vive en el contexto de la petición que lo
   * abre, así que si se abre después de que la petición respondió, el runtime
   * lo cierra y la transcripción no llega nunca.
   */
  abrir(): Promise<void>;
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
 * Cliente de STT de Deepgram (Workers AI) por WebSocket.
 *
 * Cada instancia es una llamada: una conexión, un turno de audio, un cierre.
 */
export class WorkersAiStt implements SttLike {
  private ws: WebSocket | null = null;
  private conectando = false;
  private cerrado = false;
  /** Audio que llegó antes de que el socket estuviera listo. */
  private readonly pendiente: Uint8Array[] = [];
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
    return urlSttWorkersAi(this.opciones.accountId, this.modelo, this.idioma, this.sampleRate);
  }

  async abrir(): Promise<void> {
    if (this.ws || this.conectando || this.cerrado) return;
    this.conectando = true;
    try {
      await this.conecta();
    } finally {
      this.conectando = false;
    }
  }

  /** Abre el socket y deja pasar el audio que se acumuló mientras tanto. */
  private async conecta(): Promise<void> {
    try {
      const socket = await conectaWebSocket(this.url(), {
        Authorization: `Bearer ${this.opciones.apiToken}`,
      });
      if (this.cerrado) {
        socket.close();
        return;
      }
      this.ws = socket;
      socket.addEventListener('message', (evento) => this.manejaMensaje(evento));
      socket.addEventListener('error', (evento) => {
        const detalle = 'message' in evento ? String(evento.message) : '';
        this.eventos.onError?.(
          new Error(`STT de Workers AI: error de WebSocket${detalle ? ` (${detalle})` : ''}`)
        );
      });
      socket.addEventListener('close', (evento) => {
        this.ws = null;
        logger.warn('STT de Workers AI: el socket se cerró', {
          code: evento.code,
          motivo: evento.reason,
        });
        this.eventos.onError?.(
          new Error(
            `STT de Workers AI: cerrado (${evento.code}${evento.reason ? `: ${evento.reason}` : ''})`
          )
        );
      });
      this.eventos.onAbierto?.();
      for (const pcm of this.pendiente) socket.send(pcm as unknown as ArrayBuffer);
      this.pendiente.length = 0;
    } catch (error) {
      this.eventos.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
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
    if (this.cerrado) return;
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(pcm as unknown as ArrayBuffer);
      return;
    }
    // El socket todavía no está listo: el audio no se pierde, se guarda.
    this.pendiente.push(pcm);
  }

  cerrar(): void {
    this.cerrado = true;
    this.pendiente.length = 0;
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
 * Sin token de Workers AI no hay cliente: se devuelve `null` y quien llama
 * falla de forma explícita. Nunca se simula una transcripción.
 */
export function crearStt(
  env: {
    CF_AI_API_TOKEN?: string;
    CF_AI_ACCOUNT_ID?: string;
    SPIKE_STT_MODEL?: string;
  },
  eventos: EventosStt,
  ahora?: () => number
): WorkersAiStt | null {
  if (!env.CF_AI_API_TOKEN || !env.CF_AI_ACCOUNT_ID) {
    logger.warn(
      'Spike de voz: falta CF_AI_API_TOKEN o CF_AI_ACCOUNT_ID, la transcripción no arranca'
    );
    return null;
  }
  return new WorkersAiStt(
    {
      apiToken: env.CF_AI_API_TOKEN,
      accountId: env.CF_AI_ACCOUNT_ID,
      modelo: env.SPIKE_STT_MODEL ?? STT_MODELO_DEFECTO,
      ahora,
    },
    eventos
  );
}
