/**
 * Módulo contable — envío del payload a Alegra vía MCP.
 *
 * Idempotencia: la fila en `alegra_sync` manda. Si el `idempotency_key` ya está
 * en `sent`, no se manda nada (aunque el cron corra dos veces el mismo día).
 *
 * Trazabilidad: `legal_audit.id` → `alegra_journal_lines.alegra_journal_id` →
 * `alegra_sync.alegra_journal_id` → asiento en Alegra. Cada asiento lleva en su
 * referencia el `legal_audit.id` y el hash del ledger.
 *
 * Fail-closed: si el ledger no verifica, no se manda nada y se alerta al humano.
 */

import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import { logEvent } from '../services/eventos';
import { logger } from '../lib/logger';
import { newId } from '../services/db';
import {
  CUENTA_CONTINGENCIA_DEFAULT,
  CUENTA_PROVISION_CREDITO_DEFAULT,
  type AccountingPayload,
  type AsientoContable,
} from './schemas';
import { AlegraError, crearClienteAlegra, type AlegraApi, type AlegraCuenta } from './alegraClient';

/** Backoff de reintentos en segundos: 2 h, 4 h, 8 h. */
export const BACKOFF_REINTENTOS_SEG = [7200, 14400, 28800];
export const MAX_INTENTOS = 3;

export const R2_PREFIX = 'contabilidad';

export type EstadoSync = 'sent' | 'failed' | 'skipped' | 'reconciled';

export interface SendResult {
  ok: boolean;
  estado: EstadoSync | 'omitido';
  motivo?: string;
  journalId?: string;
  asientosEnviados: number;
  reintentoProgramado?: boolean;
}

export interface SyncRow {
  id: string;
  tenant_id: string;
  fecha_corte: string;
  idempotency_key: string;
  status: string;
  payload_r2_key: string;
  alegra_journal_id: string | null;
  error_message: string | null;
}

/** Línea de trazabilidad de un asiento (escrita ANTES del UPDATE del sync). */
export interface LineaRow {
  alegra_sync_id: string;
  linea_numero: number;
  idempotency_key: string;
  legal_audit_id: string;
  alegra_journal_id: string;
}

const SQL_LEER_SYNC = `SELECT id, tenant_id, fecha_corte, idempotency_key, status, payload_r2_key, alegra_journal_id, error_message
  FROM alegra_sync
  WHERE tenant_id = ? AND idempotency_key = ?
  LIMIT 1`;

const SQL_LISTAR_SYNC_PENDIENTES = `SELECT id, tenant_id, fecha_corte, idempotency_key, status, payload_r2_key, alegra_journal_id, error_message
  FROM alegra_sync
  WHERE tenant_id = ? AND status IN ('pending', 'failed')
  ORDER BY created_at ASC
  LIMIT 50`;

const SQL_LEER_LINEAS = `SELECT legal_audit_id, alegra_journal_id
  FROM alegra_journal_lines
  WHERE tenant_id = ? AND idempotency_key = ?
  LIMIT 1`;

const SQL_LISTAR_LINEAS = `SELECT alegra_sync_id, linea_numero, idempotency_key, legal_audit_id, alegra_journal_id
  FROM alegra_journal_lines
  WHERE tenant_id = ? AND idempotency_key = ?
  ORDER BY linea_numero ASC`;

const SQL_UPSERT_SYNC = `INSERT INTO alegra_sync (id, tenant_id, fecha_corte, idempotency_key, status, payload_r2_key, alegra_journal_id, error_message, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, datetime('now'), datetime('now'))
  ON CONFLICT(tenant_id, idempotency_key) DO UPDATE SET
    status = 'pending',
    payload_r2_key = excluded.payload_r2_key,
    error_message = NULL,
    updated_at = datetime('now')`;

const SQL_ACTUALIZAR_SYNC = `UPDATE alegra_sync
  SET status = ?, alegra_journal_id = COALESCE(?, alegra_journal_id), error_message = ?, updated_at = datetime('now')
  WHERE tenant_id = ? AND idempotency_key = ?`;

const SQL_INSERTAR_LINEA = `INSERT OR IGNORE INTO alegra_journal_lines (alegra_sync_id, tenant_id, linea_numero, idempotency_key, legal_audit_id, alegra_journal_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`;

/** Clave KV del catálogo de cuentas del día (TTL 24 h). */
export const KV_CUENTAS_ALEGRA = 'alegra:accounts';
export const TTL_CUENTAS_ALEGRA = 86400;

// ────────────────────────────── R2 ──────────────────────────────

/** Ruta canónica del payload en R2 (con tenant scope). */
export function claveR2(ctx: TenantContext, fecha: string): string {
  return `${R2_PREFIX}/${ctx.tenantId}/${fecha}.json`;
}

/** Guarda el payload normalizado en R2 (auditoría + fuente del reintento). */
export async function guardarPayloadEnR2(
  ctx: TenantContext,
  fecha: string,
  payload: AccountingPayload
): Promise<string> {
  const key = claveR2(ctx, fecha);
  await ctx.env.R2.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  return key;
}

/** Lee el payload de un corte desde R2. */
export async function leerPayloadDesdeR2(
  ctx: TenantContext,
  fecha: string
): Promise<AccountingPayload | null> {
  const objeto = await ctx.env.R2.get(claveR2(ctx, fecha));
  if (!objeto) return null;
  try {
    return JSON.parse(await objeto.text()) as AccountingPayload;
  } catch (error) {
    logger.error('Payload contable ilegible en R2', {
      fecha,
      tenantId: ctx.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Último corte publicado (el más reciente en R2). El cron publica con un día
 * de rezago (T+1), así que "hoy" todavía no existe como payload.
 */
export async function leerUltimoPayload(
  ctx: TenantContext
): Promise<{ fecha: string; payload: AccountingPayload } | null> {
  const listado = await ctx.env.R2.list({ prefix: `${R2_PREFIX}/${ctx.tenantId}/`, limit: 100 });
  const claves = (listado.objects ?? [])
    .map((objeto) => objeto.key)
    .filter((clave) => clave.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));

  for (const clave of claves) {
    const objeto = await ctx.env.R2.get(clave);
    if (!objeto) continue;
    try {
      const payload = JSON.parse(await objeto.text()) as AccountingPayload;
      return { fecha: payload.fecha_corte ?? clave, payload };
    } catch {
      continue;
    }
  }
  return null;
}

// ────────────────────────────── persistencia ──────────────────────────────

async function leerSync(ctx: TenantContext, idempotencyKey: string): Promise<SyncRow | null> {
  const fila = await ctx.env.DB.prepare(SQL_LEER_SYNC).bind(ctx.tenantId, idempotencyKey).first<SyncRow>();
  return fila ?? null;
}

export async function actualizarSync(
  ctx: TenantContext,
  idempotencyKey: string,
  status: EstadoSync,
  journalId: string | null,
  errorMessage: string | null
): Promise<void> {
  await ctx.env.DB.prepare(SQL_ACTUALIZAR_SYNC)
    .bind(status, journalId, errorMessage, ctx.tenantId, idempotencyKey)
    .run();
}

async function journalIdDeLinea(
  ctx: TenantContext,
  idempotencyKey: string,
  legalAuditId: string
): Promise<string | null> {
  const fila = await ctx.env.DB.prepare(SQL_LEER_LINEAS)
    .bind(ctx.tenantId, idempotencyKey, legalAuditId)
    .first<{ legal_audit_id: string; alegra_journal_id: string }>();
  return fila?.alegra_journal_id ?? null;
}

async function registrarLinea(
  ctx: TenantContext,
  syncId: string,
  lineaNumero: number,
  idempotencyKey: string,
  legalAuditId: string,
  journalId: string
): Promise<void> {
  await ctx.env.DB.prepare(SQL_INSERTAR_LINEA)
    .bind(syncId, ctx.tenantId, lineaNumero, idempotencyKey, legalAuditId, journalId)
    .run();
}

/** Líneas de trazabilidad de un corte (para la reconciliación). */
export async function listarLineas(ctx: TenantContext, idempotencyKey: string): Promise<LineaRow[]> {
  const result = await ctx.env.DB.prepare(SQL_LISTAR_LINEAS).bind(ctx.tenantId, idempotencyKey).all<LineaRow>();
  return result.results ?? [];
}

/** Cortes que quedaron a medio camino (pendientes o fallidos). */
export async function listarSyncPendientes(ctx: TenantContext): Promise<SyncRow[]> {
  const result = await ctx.env.DB.prepare(SQL_LISTAR_SYNC_PENDIENTES).bind(ctx.tenantId).all<SyncRow>();
  return result.results ?? [];
}

/**
 * Catálogo de cuentas de Alegra con cache de 24 h en KV: `list_accounts` se
 * consulta una vez al día, no una vez por asiento.
 */
export async function listarCuentasConCache(
  ctx: TenantContext,
  cliente: AlegraApi,
  fechaCorte: string
): Promise<{ cuentas: AlegraCuenta[]; desdeCache: boolean }> {
  const clave = `${KV_CUENTAS_ALEGRA}:${ctx.tenantId}:${fechaCorte}`;
  const enCache = await ctx.env.KV.get(clave, 'json');
  if (enCache && Array.isArray(enCache)) {
    return { cuentas: enCache as AlegraCuenta[], desdeCache: true };
  }

  const cuentas = await cliente.listAccounts();
  await ctx.env.KV.put(clave, JSON.stringify(cuentas), { expirationTtl: TTL_CUENTAS_ALEGRA });
  return { cuentas, desdeCache: false };
}

// ────────────────────────────── cuentas ──────────────────────────────

function cuentaContingenciaPorDefecto(ctx: TenantContext): string {
  return ctx.env.ALEGRA_CUENTA_CONTINGENCIA ?? CUENTA_CONTINGENCIA_DEFAULT;
}

function cuentaProvisionPorDefecto(ctx: TenantContext): string {
  return ctx.env.ALEGRA_CUENTA_CONTINGENCIA_CREDITO ?? CUENTA_PROVISION_CREDITO_DEFAULT;
}

/** Sustitución de una cuenta inexistente en Alegra (queda accionable en events). */
export interface SustitucionCuenta {
  legal_audit_id: string;
  regla_id: string;
  cuenta_esperada: string;
  cuenta_usada: string;
  lado: 'debito' | 'credito';
}

/**
 * Valida las cuentas del payload contra el catálogo de Alegra. Las que no
 * existen se sustituyen por la cuenta de "Provisión por Contingencia Legal"
 * y se deja un warning accionable en `events`.
 */
export function validarCuentas(
  ctx: TenantContext,
  asientos: AsientoContable[],
  cuentas: AlegraCuenta[]
): { asientos: AsientoContable[]; sustituciones: SustitucionCuenta[] } {
  const sustituciones: SustitucionCuenta[] = [];
  if (cuentas.length === 0) return { asientos, sustituciones };

  const existentes = new Set(cuentas.map((cuenta) => cuenta.codigo));
  const ajuste = asientos.map((asiento) => {
    const faltaDebito = !existentes.has(asiento.cuenta_debito);
    const faltaCredito = !existentes.has(asiento.cuenta_credito);
    if (!faltaDebito && !faltaCredito) return asiento;

    if (faltaDebito) {
      sustituciones.push({
        legal_audit_id: asiento.legal_audit_id,
        regla_id: asiento.regla_id,
        cuenta_esperada: asiento.cuenta_debito,
        cuenta_usada: cuentaContingenciaPorDefecto(ctx),
        lado: 'debito',
      });
    }
    if (faltaCredito) {
      sustituciones.push({
        legal_audit_id: asiento.legal_audit_id,
        regla_id: asiento.regla_id,
        cuenta_esperada: asiento.cuenta_credito,
        cuenta_usada: cuentaProvisionPorDefecto(ctx),
        lado: 'credito',
      });
    }

    return {
      ...asiento,
      cuenta_debito: faltaDebito ? cuentaContingenciaPorDefecto(ctx) : asiento.cuenta_debito,
      cuenta_credito: faltaCredito ? cuentaProvisionPorDefecto(ctx) : asiento.cuenta_credito,
    };
  });

  return { asientos: ajuste, sustituciones };
}

// ────────────────────────────── envío ──────────────────────────────

/**
 * Si Alegra rechaza el asiento por una cuenta inexistente, se devuelve el mismo
 * asiento con la cuenta de *Provisión por Contingencia Legal*. Si el error es
 * otro (timeout, red), se devuelve `null` y el flujo reintenta el corte entero.
 */
export function reemplazoPorCuentaInvalida(
  ctx: TenantContext,
  asiento: AsientoContable,
  mensajeError: string
): AsientoContable | null {
  if (!/cuenta|account|chart/i.test(mensajeError)) return null;
  const debe = cuentaContingenciaPorDefecto(ctx);
  const haber = cuentaProvisionPorDefecto(ctx);
  if (asiento.cuenta_debito === debe && asiento.cuenta_credito === haber) return null;
  return { ...asiento, cuenta_debito: debe, cuenta_credito: haber };
}

export interface SendOptions {
  /** Número de intento (1 = primer envío). Define el backoff del reintento. */
  intento?: number;
  /** Cliente MCP inyectable (pruebas). */
  cliente?: AlegraApi;
  /** Clave en R2 del payload (por defecto `contabilidad/{tenantId}/{fecha}.json`). */
  payloadR2Key?: string;
}

/**
 * Envía el payload a Alegra. Devuelve el resultado sin lanzar: los errores se
 * registran en `events` y se programan reintentos con backoff.
 */
export async function sendToAlegra(
  payload: AccountingPayload,
  ctx: TenantContext,
  opciones: SendOptions = {}
): Promise<SendResult> {
  const intento = opciones.intento ?? 1;
  const payloadR2Key = opciones.payloadR2Key ?? claveR2(ctx, payload.fecha_corte);

  // ── Fail-closed: ledger roto → no se manda nada ──
  if (!payload.ledger_integrity.verificado) {
    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        idempotency_key: payload.idempotency_key,
        status: 'skipped',
        motivo: 'ledger_broken',
      },
    });
    logger.error('No se envía a Alegra: el ledger no verifica', {
      fecha_corte: payload.fecha_corte,
      tenantId: ctx.tenantId,
    });
    return { ok: false, estado: 'skipped', motivo: 'ledger_broken', asientosEnviados: 0 };
  }

  // ── Idempotencia ──
  const existente = await leerSync(ctx, payload.idempotency_key);
  if (existente && (existente.status === 'sent' || existente.status === 'reconciled')) {
    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        idempotency_key: payload.idempotency_key,
        status: 'skip_idempotente',
        alegra_journal_id: existente.alegra_journal_id,
      },
    });
    logger.info('Asiento ya enviado a Alegra: se omite', {
      fecha_corte: payload.fecha_corte,
      tenantId: ctx.tenantId,
      idempotency_key: payload.idempotency_key,
    });
    return {
      ok: true,
      estado: 'omitido',
      motivo: 'idempotente',
      journalId: existente.alegra_journal_id ?? undefined,
      asientosEnviados: 0,
    };
  }
  // ── Fase 1: el corte queda registrado como pendiente ANTES de llamar a Alegra ──
  const syncId = existente?.id ?? newId('alg');
  await ctx.env.DB.prepare(SQL_UPSERT_SYNC)
    .bind(syncId, ctx.tenantId, payload.fecha_corte, payload.idempotency_key, payloadR2Key)
    .run();

  // ── Corte sin asientos: se reconcilia sin tocar Alegra ──
  if (payload.asientos.length === 0) {
    await actualizarSync(ctx, payload.idempotency_key, 'reconciled', null, null);
    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        idempotency_key: payload.idempotency_key,
        status: 'sin_asientos',
        payload_r2_key: payloadR2Key,
      },
    });
    return { ok: true, estado: 'reconciled', asientosEnviados: 0 };
  }

  const cliente = opciones.cliente ?? crearClienteAlegra(ctx.env);
  const mappings: { legal_audit_id: string; alegra_journal_id: string }[] = [];

  try {
    // El catálogo de cuentas se cachea 24 h: una llamada al día, no una por asiento.
    const { cuentas } = await listarCuentasConCache(ctx, cliente, payload.fecha_corte);
    if (cuentas.length === 0) {
      await logEvent(ctx, 'alegra_sync', {
        payload: {
          fecha_corte: payload.fecha_corte,
          status: 'warning',
          aviso: 'list_accounts sin cuentas: no se validaron las cuentas del payload',
        },
      });
    }

    const { asientos, sustituciones } = validarCuentas(ctx, payload.asientos, cuentas);
    for (const sustitucion of sustituciones) {
      await logEvent(ctx, 'alegra_account_fallback', {
        payload: {
          fecha_corte: payload.fecha_corte,
          legal_audit_id: sustitucion.legal_audit_id,
          regla_id: sustitucion.regla_id,
          cuenta_esperada: sustitucion.cuenta_esperada,
          cuenta_usada: sustitucion.cuenta_usada,
          lado: sustitucion.lado,
          motivo: 'cuenta_no_existe_en_alegra',
          accion_requerida: 'Verificar catálogo de cuentas en Alegra',
        },
      });
    }

    let primerJournalId: string | null = null;
    for (const [indice, asiento] of asientos.entries()) {
      const yaCreado = await journalIdDeLinea(ctx, payload.idempotency_key, asiento.legal_audit_id);
      if (yaCreado) {
        mappings.push({ legal_audit_id: asiento.legal_audit_id, alegra_journal_id: yaCreado });
        primerJournalId = primerJournalId ?? yaCreado;
        continue;
      }

      let creado;
      try {
        creado = await cliente.createJournalEntry(asiento, payload);
      } catch (error) {
        // Alegra rechazó la cuenta: se reintenta con la cuenta de contingencia legal.
        const mensaje = error instanceof Error ? error.message : String(error);
        const reemplazo = reemplazoPorCuentaInvalida(ctx, asiento, mensaje);
        if (!reemplazo) throw error;
        await logEvent(ctx, 'alegra_account_fallback', {
          payload: {
            fecha_corte: payload.fecha_corte,
            legal_audit_id: asiento.legal_audit_id,
            regla_id: asiento.regla_id,
            cuenta_esperada: asiento.cuenta_debito,
            cuenta_usada: cuentaContingenciaPorDefecto(ctx),
            motivo: 'alegra_rechazo_cuenta',
            accion_requerida: 'Verificar catálogo de cuentas en Alegra',
            error: mensaje,
          },
        });
        creado = await cliente.createJournalEntry(reemplazo, payload);
      }

      // Fase 2a: la línea se escribe ANTES de actualizar `alegra_sync`.
      // Si el UPDATE falla, la reconciliación encuentra la línea y no reasienta.
      await registrarLinea(
        ctx,
        syncId,
        indice + 1,
        payload.idempotency_key,
        asiento.legal_audit_id,
        creado.id
      );
      mappings.push({ legal_audit_id: asiento.legal_audit_id, alegra_journal_id: creado.id });
      primerJournalId = primerJournalId ?? creado.id;
    }

    await actualizarSync(ctx, payload.idempotency_key, 'sent', primerJournalId, null);
    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        idempotency_key: payload.idempotency_key,
        status: 'sent',
        alegra_journal_id: primerJournalId,
        payload_r2_key: payloadR2Key,
        asientos: mappings,
      },
    });

    return {
      ok: true,
      estado: 'sent',
      journalId: primerJournalId ?? undefined,
      asientosEnviados: mappings.length,
    };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    // Los errores JSON-RPC mapped como 'fail' no se reintentan: son del payload,
    // no de la red (reintentar sólo gastaría cola).
    const reintentable = !(error instanceof AlegraError) || error.reintentable;
    const definitivo = intento >= MAX_INTENTOS || !reintentable;

    // Si D1 tampoco responde, el error original no debe quedar tapado.
    try {
      await actualizarSync(ctx, payload.idempotency_key, 'failed', null, mensaje);
    } catch (errorSync) {
      logger.error('No se pudo marcar el corte como fallido', {
        fecha_corte: payload.fecha_corte,
        tenantId: ctx.tenantId,
        error: errorSync instanceof Error ? errorSync.message : String(errorSync),
      });
    }

    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        idempotency_key: payload.idempotency_key,
        status: definitivo ? 'failed' : 'reintentando',
        error: mensaje,
        codigo_mcp: error instanceof AlegraError ? (error.codigo ?? null) : null,
        reintentable,
        intento,
        asientos_creados: mappings.length,
      },
    });
    logger.error('Falló el envío a Alegra', {
      fecha_corte: payload.fecha_corte,
      tenantId: ctx.tenantId,
      intento,
      error: mensaje,
    });

    const reintentoProgramado = definitivo
      ? false
      : await programarReintento(ctx, payload, intento);
    return {
      ok: false,
      estado: 'failed',
      motivo: mensaje,
      asientosEnviados: mappings.length,
      reintentoProgramado,
    };
  }
}

/**
 * Programa el siguiente reintento con backoff exponencial (2 h, 4 h, 8 h)
 * usando la cola existente: el mensaje vuelve al consumidor con el delay.
 */
export async function programarReintento(
  ctx: TenantContext,
  payload: AccountingPayload,
  intento: number
): Promise<boolean> {
  const indice = Math.min(intento - 1, BACKOFF_REINTENTOS_SEG.length - 1);
  const delaySeconds = BACKOFF_REINTENTOS_SEG[indice] ?? BACKOFF_REINTENTOS_SEG[0];
  try {
    await ctx.env.COBRANZA_QUEUE.send(
      {
        type: 'contabilidad.reintento',
        fechaCorte: payload.fecha_corte,
        idempotencyKey: payload.idempotency_key,
        attempt: intento + 1,
        enqueuedAt: Date.now(),
        tenantId: ctx.tenantId,
      },
      { delaySeconds }
    );
    logger.warn('Reintento de Alegra programado', {
      fecha_corte: payload.fecha_corte,
      tenantId: ctx.tenantId,
      intento: intento + 1,
      delaySeconds,
    });
    return true;
  } catch (error) {
    await logEvent(ctx, 'alegra_sync', {
      payload: {
        fecha_corte: payload.fecha_corte,
        status: 'failed',
        error: `no se pudo programar el reintento: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    });
    return false;
  }
}

/**
 * Reintento disparado por la cola: relee el payload de R2 y lo vuelve a mandar.
 * El payload es idéntico ⇒ mismo `idempotency_key` ⇒ no se duplican asientos.
 */
export async function reintentarEnvioAlegra(
  ctx: TenantContext,
  fecha: string,
  intento: number
): Promise<SendResult> {
  const payload = await leerPayloadDesdeR2(ctx, fecha);
  if (!payload) {
    await logEvent(ctx, 'alegra_sync', {
      payload: { fecha_corte: fecha, status: 'failed', error: 'payload no encontrado en R2' },
    });
    return { ok: false, estado: 'failed', motivo: 'payload_no_encontrado', asientosEnviados: 0 };
  }
  return sendToAlegra(payload, ctx, { intento });
}

/** Reexporta el error de Alegra para que el consumidor lo distinga. */
export { AlegraError };