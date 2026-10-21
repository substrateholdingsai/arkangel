/**
 * Durable Object de sesión de llamada (spike de voz).
 *
 * Un DO por llamada: es el patrón que ya usa `src/durable/call-lock.ts` (una
 * clase con `fetch`, sin heredar de `DurableObject`), y así el estado de la
 * llamada se puede probar en vitest sin el runtime de Workerd.
 *
 * Qué guarda:
 * · El estado de la llamada: `idle → ringing → active → ended`.
 * · El `traceId` de la llamada, para correlacionar logs y métricas.
 * · Las muestras de latencia de cada turno (nada de audio ni transcripciones).
 * · El canal de signaling: el WebSocket por el que entra el audio del
 *   navegador y por el que sale el audio del bot.
 *
 * Lo que **no** hace: no toca el ledger legal, no llama a `agent.ts` para
 * decidir y no escribe mensajes. El spike sólo mide.
 */

import { createLoggerWithTrace } from '../lib/logger';
import { resumenMetricas, type ResumenMetricas } from '../lib/medidas';
import {
  crearPipelineVoz,
  metricasVacias,
  type ClienteVoz,
  type EventoVoz,
  type MetricasTurno,
  type PipelineVoz,
} from '../orquestacion/voice';
import type { Env } from '../types/env';

/** Estados posibles de una llamada. */
export type EstadoLlamada = 'idle' | 'ringing' | 'active' | 'ended';

/** Nombres de las métricas que se acumulan por llamada. */
export const METRICAS_VOZ = [
  'stt_partial_ms',
  'stt_final_ms',
  'llm_first_token_ms',
  'llm_total_ms',
  'tts_first_chunk_ms',
  'round_trip_ms',
  'barge_in_latency_ms',
] as const;

export type NombreMetrica = (typeof METRICAS_VOZ)[number];

/** Muestras acumuladas de una llamada. */
export type MuestrasMetricas = Record<NombreMetrica, number[]>;

/** Estado completo de una llamada. */
export interface EstadoSesion {
  callId: string;
  tenantId: string;
  estado: EstadoLlamada;
  traceId: string;
  iniciadaEn: number;
  terminadaEn?: number;
  turnos: number;
  interrumpidas: number;
  metricas: MuestrasMetricas;
  ultimoParcial?: string;
  ultimoFinal?: string;
  /** Motivo de cierre, si se cerró con error. */
  error?: string;
}

/** Almacenamiento mínimo del DO (en producción, `ctx.storage`). */
export interface AlmacenamientoSesion {
  get<T>(clave: string): Promise<T | undefined>;
  put<T>(clave: string, valor: T): Promise<void>;
}

/** Implementación en memoria (pruebas y despliegues sin storage). */
export class AlmacenamientoMemoria implements AlmacenamientoSesion {
  private readonly datos = new Map<string, unknown>();

  async get<T>(clave: string): Promise<T | undefined> {
    return this.datos.get(clave) as T | undefined;
  }

  async put<T>(clave: string, valor: T): Promise<void> {
    this.datos.set(clave, valor);
  }
}

/** Contexto del DO. En producción es el `DurableObjectState` del runtime. */
export interface ContextoSesion {
  storage: AlmacenamientoSesion;
}

export function muestrasVacias(): MuestrasMetricas {
  const muestras = {} as MuestrasMetricas;
  for (const nombre of METRICAS_VOZ) muestras[nombre] = [];
  return muestras;
}

/**
 * DO de la llamada.
 *
 * Endpoints (todos por `fetch`, igual que `CallLockDO`):
 * · `POST /iniciar` → crea la llamada (`idle` → `ringing`).
 * · `GET /estado` → estado + métricas + resumen p50/p95.
 * · `POST /turno` → suma las métricas de un turno.
 * · `POST /cortar` → barge-in manual desde el cliente.
 * · `POST /colgar` → `ended`.
 * · `GET /audio` (WebSocket) → canal de audio y signaling.
 */
export class CallSessionDO {
  private estado: EstadoSesion | null = null;
  private pipeline: PipelineVoz | null = null;
  private socket: WebSocket | null = null;

  constructor(
    private readonly ctx: ContextoSesion,
    private readonly env: Env
  ) {}

  /** Lee el estado persistido (si lo hay). */
  private async carga(): Promise<EstadoSesion | null> {
    if (this.estado) return this.estado;
    this.estado = (await this.ctx.storage.get<EstadoSesion>('estado')) ?? null;
    return this.estado;
  }

  private async guarda(): Promise<void> {
    if (this.estado) await this.ctx.storage.put('estado', this.estado);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const accion = url.pathname;

    if (accion === '/audio') return this.manejaAudio(request);
    if (accion === '/iniciar' && request.method === 'POST') return this.inicia(request);
    if (accion === '/estado') return this.estadoResponse();
    if (accion === '/turno' && request.method === 'POST') return this.registraTurno(request);
    if (accion === '/cortar' && request.method === 'POST') return this.corta(request);
    if (accion === '/colgar' && request.method === 'POST') return this.colga();

    return new Response(JSON.stringify({ error: 'ruta_desconocida' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Crea la llamada: `idle → ringing`. */
  private async inicia(request: Request): Promise<Response> {
    const cuerpo = (await request.json().catch(() => null)) as {
      callId?: string;
      tenantId?: string;
      traceId?: string;
    } | null;

    const callId = cuerpo?.callId;
    const tenantId = cuerpo?.tenantId;
    if (!callId || !tenantId) {
      return new Response(JSON.stringify({ error: 'callId y tenantId son obligatorios' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.estado = {
      callId,
      tenantId,
      estado: 'ringing',
      traceId: cuerpo?.traceId ?? 'sin-trace',
      iniciadaEn: Date.now(),
      turnos: 0,
      interrumpidas: 0,
      metricas: muestrasVacias(),
    };
    await this.guarda();

    return new Response(JSON.stringify({ ok: true, estado: this.estado.estado }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Estado + métricas + resumen. */
  private async estadoResponse(): Promise<Response> {
    const estado = await this.carga();
    if (!estado) {
      return new Response(JSON.stringify({ error: 'llamada_no_iniciada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        ...estado,
        resumen: resumenMetricas(estado.metricas),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  /** Suma las métricas de un turno. */
  private async registraTurno(request: Request): Promise<Response> {
    const estado = await this.carga();
    if (!estado) {
      return new Response(JSON.stringify({ error: 'llamada_no_iniciada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const cuerpo = (await request.json().catch(() => null)) as {
      metricas?: Partial<MetricasTurno>;
    } | null;
    if (!cuerpo?.metricas) {
      return new Response(JSON.stringify({ error: 'metricas_requeridas' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    for (const nombre of METRICAS_VOZ) {
      const valor = cuerpo.metricas[nombre];
      if (typeof valor === 'number' && Number.isFinite(valor)) {
        estado.metricas[nombre].push(valor);
      }
    }
    estado.turnos += 1;
    if (estado.estado === 'ringing') estado.estado = 'active';
    await this.guarda();

    return new Response(JSON.stringify({ ok: true, turnos: estado.turnos }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Barge-in manual (el cliente lo pide si detecta voz con su propio VAD). */
  private async corta(request: Request): Promise<Response> {
    const estado = await this.carga();
    if (!estado) {
      return new Response(JSON.stringify({ error: 'llamada_no_iniciada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const cuerpo = (await request.json().catch(() => null)) as { bargeInLatencyMs?: number } | null;
    const latencia = cuerpo?.bargeInLatencyMs;
    if (typeof latencia === 'number' && Number.isFinite(latencia)) {
      estado.metricas.barge_in_latency_ms.push(latencia);
    }
    estado.interrumpidas += 1;
    this.pipeline?.cortarLocucion();
    await this.guarda();

    return new Response(JSON.stringify({ ok: true, interrumpidas: estado.interrumpidas }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Cierra la llamada. */
  private async colga(): Promise<Response> {
    const estado = await this.carga();
    if (!estado) {
      return new Response(JSON.stringify({ error: 'llamada_no_iniciada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    estado.estado = 'ended';
    estado.terminadaEn = Date.now();
    this.pipeline?.cerrar();
    this.pipeline = null;
    try {
      this.socket?.close();
    } catch {
      // Si el socket ya estaba cerrado, no hay nada que hacer.
    }
    this.socket = null;
    await this.guarda();

    return new Response(JSON.stringify({ ok: true, estado: estado.estado }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Canal de audio y signaling.
   *
   * Entra el PCM del navegador (tramas binarias), salen el audio del bot y
   * los eventos del pipeline (JSON). El pipeline se arma aquí, con las
   * credenciales del entorno: si faltan, el DO lo dice y no inventa voz.
   */
  private async manejaAudio(request: Request): Promise<Response> {
    const estado = await this.carga();
    if (!estado) {
      return new Response(JSON.stringify({ error: 'llamada_no_iniciada' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({ error: 'se_requiere_websocket' }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { response, client } = crearParWebSocket();
    this.socket = client;

    const cliente = await this.clienteDeLlamada(estado);
    const log = createLoggerWithTrace('spike-voz-do', {
      traceId: estado.traceId,
      spanId: 'spik-do',
      sampled: true,
    });

    const emite = (evento: EventoVoz) => {
      try {
        client.send(JSON.stringify(evento));
      } catch {
        // El navegador se fue: no hay a quién avisar.
      }
    };

    this.pipeline = crearPipelineVoz({
      env: this.env,
      callId: estado.callId,
      tenantId: estado.tenantId,
      traceId: estado.traceId,
      cliente,
      alEvento: (evento) => {
        if (evento.tipo === 'fin_turno') {
          void this.acumulaTurno(evento.metricas);
        }
        emite(evento);
      },
    });

    if (!this.pipeline) {
      log.warn('El pipeline de voz no pudo arrancar', { callId: estado.callId });
    }

    client.addEventListener('message', (evento) => {
      if (typeof evento.data === 'string') {
        // Signaling: el cliente avisa de que habló (barge-in desde el navegador).
        try {
          const mensaje = JSON.parse(evento.data) as { tipo?: string; bargeInLatencyMs?: number };
          if (mensaje.tipo === 'barge_in') void this.cortaLocucionRemota(mensaje.bargeInLatencyMs);
        } catch {
          // Mensaje ilegible: se ignora (no es un camino de decisión legal).
        }
        return;
      }
      this.pipeline?.recibirAudio(evento.data as ArrayBuffer);
    });

    client.addEventListener('close', () => {
      this.pipeline?.cerrar();
      this.pipeline = null;
      this.socket = null;
    });

    return response;
  }

  /** Suma las métricas de un turno terminado. */
  private async acumulaTurno(metricas: MetricasTurno): Promise<void> {
    const estado = await this.carga();
    if (!estado) return;
    for (const nombre of METRICAS_VOZ) {
      const valor = metricas[nombre];
      if (typeof valor === 'number' && Number.isFinite(valor)) {
        estado.metricas[nombre].push(valor);
      }
    }
    estado.turnos += 1;
    if (estado.estado === 'ringing') estado.estado = 'active';
    await this.guarda();
  }

  /** Barge-in pedido por el navegador. */
  private async cortaLocucionRemota(latencia?: number): Promise<void> {
    const estado = await this.carga();
    if (!estado) return;
    if (typeof latencia === 'number' && Number.isFinite(latencia)) {
      estado.metricas.barge_in_latency_ms.push(latencia);
    }
    estado.interrumpidas += 1;
    this.pipeline?.cortarLocucion();
    await this.guarda();
  }

  /**
   * Datos del deudor para el LLM.
   *
   * El spike no busca clientes en la cartera: usa un deudor de mentira con
   * datos fijos y bien marcados. Es una medición de latencia, no un envío.
   */
  private async clienteDeLlamada(estado: EstadoSesion): Promise<ClienteVoz> {
    const nombre = `Cliente de prueba ${estado.callId.slice(0, 6)}`;
    return {
      nombre,
      montoCents: 125_000,
      fechaVencimiento: '2026-10-01',
      diasRetraso: 20,
      band: 'medio',
      nombreLegal: 'Spike Arkangel (prueba)',
      condusef: '000000',
    };
  }
}

/**
 * Crea un par de WebSockets.
 *
 * En el runtime de Cloudflare existe `WebSocketPair`; en vitest (node) no, así
 * que aquí se usa un doble mínimo con la misma forma: `server` (la respuesta
 * 101) y `client` (el socket del Worker).
 */
export function crearParWebSocket(): { response: Response; client: WebSocket } {
  const globalAny = globalThis as unknown as {
    WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket };
  };
  if (typeof globalAny.WebSocketPair === 'function') {
    const pair = new globalAny.WebSocketPair();
    return { response: new Response(null, { status: 101, webSocket: pair[0] }), client: pair[1] };
  }
  return { response: new Response(null, { status: 426 }), client: new WebSocketDouble() as never };
}

/** Doble de WebSocket para las pruebas. */
export class WebSocketDouble {
  private readonly listeners = new Map<string, Array<(evento: unknown) => void>>();

  readyState = 1;

  addEventListener(tipo: string, fn: (evento: unknown) => void): void {
    const lista = this.listeners.get(tipo) ?? [];
    lista.push(fn);
    this.listeners.set(tipo, lista);
  }

  removeEventListener(tipo: string, fn: (evento: unknown) => void): void {
    const lista = (this.listeners.get(tipo) ?? []).filter((f) => f !== fn);
    this.listeners.set(tipo, lista);
  }

  emit(tipo: string, evento: unknown): void {
    for (const fn of this.listeners.get(tipo) ?? []) fn(evento);
  }

  send(datos: unknown): void {
    this.emit('message', { data: datos });
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
}

/** Estado vacío de métricas (utilidad para las pruebas). */
export function estadoVacio(callId: string, tenantId: string, traceId: string): EstadoSesion {
  return {
    callId,
    tenantId,
    estado: 'idle',
    traceId,
    iniciadaEn: Date.now(),
    turnos: 0,
    interrumpidas: 0,
    metricas: metricasVacias() as never,
  };
}

export type { ResumenMetricas };
