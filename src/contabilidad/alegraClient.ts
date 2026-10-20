/**
 * Cliente MCP de Alegra (transporte HTTP / JSON-RPC 2.0).
 *
 * El Worker no puede lanzar un servidor MCP por stdio, así que el MCP de Alegra
 * se expone por HTTP y se consume con el protocolo JSON-RPC 2.0:
 *
 *   initialize            → handshake (protocolVersion + capabilities)
 *   tools/call            → alegra.list_accounts | alegra.create_journal_entry
 *                          | alegra.list_journal_entries
 *
 * El transporte responde en `application/json` o en `text/event-stream`
 * (Streamable HTTP); ambos formatos se normalizan aquí.
 *
 * La forma exacta de los argumentos depende del servidor MCP de Alegra: se
 * concentra en `buildJournalEntryArgs` para poder ajustarla sin tocar el
 * transporte.
 */

import { logger } from '../lib/logger';
import type { AccountingPayload, AsientoContable } from './schemas';

export const TOOL_LIST_ACCOUNTS = 'alegra.list_accounts';
export const TOOL_CREATE_JOURNAL_ENTRY = 'alegra.create_journal_entry';
export const TOOL_LIST_JOURNAL_ENTRIES = 'alegra.list_journal_entries';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Clave KV donde se cachea la sesión MCP (1 h). */
export const KV_SESION_MCP = 'alegra:mcp:session';
export const TTL_SESION_MCP = 3600;

/**
 * Mapa de errores JSON-RPC a decisión operativa.
 * `retry` → reencolar con backoff; `fail` → marcar el corte como fallido.
 */
export const MCP_ERROR_MAP: Record<number, 'retry' | 'fail'> = {
  [-32600]: 'fail', // Invalid Request
  [-32601]: 'fail', // Method not found
  [-32602]: 'fail', // Invalid params
  [-32603]: 'retry', // Internal error
  [-32000]: 'retry', // Server error (Alegra)
  [-32001]: 'retry', // Alegra: temporalmente no disponible
};

export class AlegraError extends Error {
  constructor(
    message: string,
    public readonly detalle?: unknown,
    public readonly codigo?: number
  ) {
    super(message);
    this.name = 'AlegraError';
  }

  /** `retry` si el error es transitorio; `fail` si no tiene sentido reintentar. */
  get reintentable(): boolean {
    if (this.codigo === undefined) return true;
    return (MCP_ERROR_MAP[this.codigo] ?? 'retry') === 'retry';
  }
}

export interface AlegraCuenta {
  codigo: string;
  nombre: string;
}

export interface JournalEntryResult {
  id: string;
  raw: unknown;
}

/** Asiento ya existente en Alegra (para la reconciliación). */
export interface JournalEntryExistente {
  id: string;
  referencia?: string;
}

export interface AlegraClientOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
  retries?: number;
  /** Namespace KV para cachear la sesión MCP. */
  kv?: KVNamespace;
  /** Nombre del tool de listado de cuentas (por si el servidor lo expone distinto). */
  toolListAccounts?: string;
  toolCreateJournalEntry?: string;
  toolListJournalEntries?: string;
}

/** Superficie mínima que necesita el módulo contable (fácil de simular en tests). */
export interface AlegraApi {
  listAccounts(): Promise<AlegraCuenta[]>;
  createJournalEntry(
    asiento: AsientoContable,
    payload: AccountingPayload
  ): Promise<JournalEntryResult>;
  /** Lista los asientos ya existentes en Alegra para una idempotency key. */
  listJournalEntries?(idempotencyKey: string): Promise<JournalEntryExistente[]>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: {
    content?: { type?: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code?: number; message?: string; data?: unknown };
}

/** Normaliza la respuesta de un tool call a JSON plano. */
function extraerContenido(resultado: JsonRpcResponse['result']): unknown {
  if (!resultado) return null;
  if (resultado.structuredContent !== undefined) return resultado.structuredContent;

  const textos = (resultado.content ?? [])
    .filter((parte) => parte.type === 'text' || typeof parte.text === 'string')
    .map((parte) => parte.text ?? '')
    .join('\n')
    .trim();

  if (!textos) return null;
  try {
    return JSON.parse(textos);
  } catch {
    return textos;
  }
}

/** Detecta el arreglo de cuentas en la respuesta de `alegra.list_accounts`. */
function normalizarCuentas(payload: unknown): AlegraCuenta[] {
  if (Array.isArray(payload)) return payload.map(normalizarCuenta).filter(isCuenta);
  if (payload && typeof payload === 'object') {
    const objeto = payload as Record<string, unknown>;
    for (const clave of ['accounts', 'cuentas', 'data', 'items', 'results']) {
      const valor = objeto[clave];
      if (Array.isArray(valor)) return valor.map(normalizarCuenta).filter(isCuenta);
    }
  }
  return [];
}

function isCuenta(cuenta: AlegraCuenta | null): cuenta is AlegraCuenta {
  return cuenta !== null;
}

function normalizarCuenta(cuenta: unknown): AlegraCuenta | null {
  if (!cuenta || typeof cuenta !== 'object') return null;
  const objeto = cuenta as Record<string, unknown>;
  const codigo =
    objeto.codigo ?? objeto.code ?? objeto.cuenta ?? objeto.numero ?? objeto.id ?? null;
  if (codigo === null || codigo === undefined) return null;
  const nombre =
    objeto.nombre ?? objeto.name ?? objeto.descripcion ?? objeto.description ?? String(codigo);
  return { codigo: String(codigo), nombre: String(nombre) };
}

/** Normaliza la lista de asientos existentes (reconciliación). */
function normalizarAsientos(payload: unknown): JournalEntryExistente[] {
  const lista = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (['journal_entries', 'asientos', 'entries', 'data', 'items', 'results'] as const)
          .map((clave) => (payload as Record<string, unknown>)[clave])
          .find((valor): valor is unknown[] => Array.isArray(valor))
      : undefined;
  if (!lista) return [];

  const resultado: JournalEntryExistente[] = [];
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const objeto = item as Record<string, unknown>;
    const id = objeto.id ?? objeto.journal_entry_id ?? objeto.asiento_id ?? null;
    if (id === null || id === undefined) continue;
    const referencia = objeto.referencia ?? objeto.reference ?? objeto.metadata ?? null;
    resultado.push({
      id: String(id),
      referencia:
        typeof referencia === 'string'
          ? referencia
          : referencia && typeof referencia === 'object'
            ? String((referencia as Record<string, unknown>).idempotency_key ?? '')
            : undefined,
    });
  }
  return resultado;
}

/** Extrae el identificador del asiento creado en Alegra. */
function extraerJournalId(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const objeto = payload as Record<string, unknown>;
  for (const clave of [
    'id',
    'journal_entry_id',
    'journalEntryId',
    'asiento_id',
    'asientoId',
    'uuid',
  ]) {
    const valor = objeto[clave];
    if (typeof valor === 'string' && valor.length > 0) return valor;
    if (typeof valor === 'number') return String(valor);
  }
  for (const clave of ['data', 'journal_entry', 'entry', 'asiento']) {
    const anidado = objeto[clave];
    if (anidado && typeof anidado === 'object') {
      const id = extraerJournalId(anidado);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Argumentos del tool `alegra.create_journal_entry`.
 * Cada asiento es una partida doble: una cuenta al debe y otra al haber.
 */
export function buildJournalEntryArgs(
  asiento: AsientoContable,
  payload: AccountingPayload
): Record<string, unknown> {
  return {
    fecha: payload.fecha_corte,
    periodo: payload.periodo,
    concepto: asiento.concepto,
    tipo: asiento.tipo_asiento,
    moneda: 'MXN',
    monto: asiento.monto,
    partidas: [
      { cuenta: asiento.cuenta_debito, debe: asiento.monto, haber: 0 },
      { cuenta: asiento.cuenta_credito, debe: 0, haber: asiento.monto },
    ],
    referencia: `legal_audit:${asiento.legal_audit_id} | ledger:${asiento.referencia_ledger}`,
    metadata: {
      idempotency_key: payload.idempotency_key,
      legal_audit_id: asiento.legal_audit_id,
      referencia_ledger: asiento.referencia_ledger,
      regla_id: asiento.regla_id,
      ley: asiento.ley,
      articulo: asiento.articulo,
      castigo: asiento.castigo,
      cfdi_relacionado: asiento.cfdi_relacionado,
      fecha_corte: payload.fecha_corte,
    },
  };
}

/**
 * Lee la respuesta del MCP: `application/json` o `text/event-stream`
 * (Streamable HTTP). En SSE se consume el stream y se toma el primer
 * mensaje JSON-RPC con `result` o `error`.
 */
export async function leerRespuestaMcp(res: Response): Promise<JsonRpcResponse | null> {
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const lector = res.body?.getReader();
    if (!lector) return null;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lineas = buffer.split('\n');
      buffer = lineas.pop() ?? '';
      for (const linea of lineas) {
        const mensaje = mensajeSse(linea);
        if (mensaje) return mensaje;
      }
    }

    const ultimo = mensajeSse(buffer);
    return ultimo;
  }

  const texto = await res.text();
  if (!texto.trim()) return null;
  try {
    return JSON.parse(texto) as JsonRpcResponse;
  } catch {
    return null;
  }
}

/** Convierte una línea `data: {...}` de SSE en un mensaje JSON-RPC. */
function mensajeSse(linea: string): JsonRpcResponse | null {
  const limpia = linea.trim();
  if (!limpia.startsWith('data:')) return null;
  const cuerpo = limpia.slice(5).trim();
  if (!cuerpo) return null;
  try {
    const parsed = JSON.parse(cuerpo) as JsonRpcResponse;
    if (parsed.result || parsed.error) return parsed;
    return null;
  } catch {
    return null;
  }
}

export class AlegraMcpClient implements AlegraApi {
  private requestId = 0;
  private sessionId: string | null = null;
  private inicializado = false;

  constructor(private readonly options: AlegraClientOptions) {}

  /** Lista las cuentas contables disponibles en Alegra. */
  async listAccounts(): Promise<AlegraCuenta[]> {
    const payload = await this.callTool(this.options.toolListAccounts ?? TOOL_LIST_ACCOUNTS, {});
    return normalizarCuentas(payload);
  }

  /** Crea un asiento contable en Alegra. */
  async createJournalEntry(
    asiento: AsientoContable,
    payload: AccountingPayload
  ): Promise<JournalEntryResult> {
    const argumentos = buildJournalEntryArgs(asiento, payload);
    const resultado = await this.callTool(
      this.options.toolCreateJournalEntry ?? TOOL_CREATE_JOURNAL_ENTRY,
      argumentos
    );
    const id = extraerJournalId(resultado);
    if (!id) {
      throw new AlegraError('Alegra no devolvió el identificador del asiento', resultado);
    }
    return { id, raw: resultado };
  }

  /** Lista los asientos ya existentes en Alegra para una idempotency key. */
  async listJournalEntries(idempotencyKey: string): Promise<JournalEntryExistente[]> {
    const resultado = await this.callTool(
      this.options.toolListJournalEntries ?? TOOL_LIST_JOURNAL_ENTRIES,
      { idempotency_key: idempotencyKey }
    );
    return normalizarAsientos(resultado);
  }

  /** Invoca un tool del MCP de Alegra. */
  async callTool(nombre: string, argumentos: Record<string, unknown>): Promise<unknown> {
    await this.inicializar();

    const respuesta = await this.enviar('tools/call', {
      name: nombre,
      arguments: argumentos,
    });

    if (respuesta.error) {
      throw new AlegraError(
        `Alegra rechazó ${nombre}: ${respuesta.error.message ?? 'error desconocido'}`,
        respuesta.error.data,
        respuesta.error.code
      );
    }

    const resultado = respuesta.result;
    if (resultado?.isError) {
      throw new AlegraError(`Alegra devolvió error en ${nombre}`, extraerContenido(resultado));
    }

    return extraerContenido(resultado);
  }

  /**
   * Handshake MCP. El `session_id` se cachea en KV (1 h) para no reinicializar
   * en cada `tools/call`.
   */
  private async inicializar(): Promise<void> {
    if (this.inicializado) return;

    const cacheada = await this.options.kv?.get(KV_SESION_MCP);
    if (cacheada) {
      this.sessionId = cacheada;
      this.inicializado = true;
      return;
    }

    const respuesta = await this.enviar('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'arkangel-contabilidad', version: '1.0.0' },
    });
    if (respuesta.error) {
      throw new AlegraError(
        `No se pudo inicializar el MCP de Alegra: ${respuesta.error.message ?? 'error desconocido'}`,
        respuesta.error.data,
        respuesta.error.code
      );
    }
    this.inicializado = true;
    if (this.sessionId && this.options.kv) {
      await this.options.kv.put(KV_SESION_MCP, this.sessionId, { expirationTtl: TTL_SESION_MCP });
    }
  }

  private async enviar(
    metodo: string,
    parametros: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const url = this.options.url;
    if (!url) throw new AlegraError('Falta la URL del MCP de Alegra (ALEGRA_MCP_URL)');

    this.requestId += 1;
    const cuerpo = JSON.stringify({
      jsonrpc: '2.0',
      id: this.requestId,
      method: metodo,
      params: parametros,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const timeoutMs = this.options.timeoutMs ?? 20000;
    const reintentos = this.options.retries ?? 2;
    let ultimoError: unknown;

    for (let intento = 0; intento <= reintentos; intento++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: cuerpo,
          signal: controller.signal,
        });

        const session = response.headers.get('mcp-session-id');
        if (session) this.sessionId = session;

        if (!response.ok) {
          const texto = await response.text();
          throw new AlegraError(
            `MCP de Alegra respondió ${response.status}: ${texto.slice(0, 300)}`
          );
        }

        const cuerpoRespuesta = await leerRespuestaMcp(response);
        if (!cuerpoRespuesta) {
          throw new AlegraError('MCP de Alegra devolvió una respuesta vacía o ilegible');
        }
        return cuerpoRespuesta;
      } catch (error) {
        ultimoError = error;
        const reintentable =
          !(error instanceof AlegraError) ||
          error.reintentable ||
          /timeout|abort|network|fetch/i.test(error.message);
        if (!reintentable || intento === reintentos) break;
        logger.warn('Reintentando llamada al MCP de Alegra', {
          metodo,
          intento: intento + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** intento));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new AlegraError(
      `Fallo la llamada al MCP de Alegra (${metodo}): ${
        ultimoError instanceof Error ? ultimoError.message : String(ultimoError)
      }`,
      ultimoError,
      ultimoError instanceof AlegraError ? ultimoError.codigo : undefined
    );
  }
}

/** Construye el cliente a partir de las variables del Worker. */
export function crearClienteAlegra(env: {
  ALEGRA_MCP_URL?: string;
  ALEGRA_MCP_TOKEN?: string;
  ALEGRA_MCP_TIMEOUT_MS?: string;
  KV?: KVNamespace;
}): AlegraMcpClient {
  return new AlegraMcpClient({
    url: env.ALEGRA_MCP_URL ?? '',
    token: env.ALEGRA_MCP_TOKEN,
    timeoutMs: Number(env.ALEGRA_MCP_TIMEOUT_MS ?? 20000),
    kv: env.KV,
  });
}
