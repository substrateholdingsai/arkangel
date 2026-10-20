/**
 * Cron contable — 23:59 CDMX.
 *
 * Cierra el día contable: arma el payload normalizado, lo deja en R2 y lo
 * manda a Alegra vía MCP. Todo sin intervención del contador.
 *
 * Fail-closed: si el ledger no verifica, el payload se guarda en R2 para
 * revisión pero NO se envía a Alegra; se alerta al humano por `events`.
 */

import type { Env } from '../types/env';
import { logger } from '../lib/logger';
import { logEvent } from '../services/eventos';
import {
  construirPayload,
  diaPrevioIso,
  guardarCheckpoint,
  type ResultadoBuild,
} from '../contabilidad/buildPayload';
import { guardarPayloadEnR2, sendToAlegra, type SendResult } from '../contabilidad/sendToAlegra';
import { reconciliarCortesPendientes, type ResultadoReconciliacion } from './reconciliacion';

export interface ResultadoContabilidad {
  fecha: string;
  payloadGuardado: boolean;
  enviado: boolean;
  resultado?: SendResult;
  reconciliacion?: ResultadoReconciliacion;
  error?: string;
}

/**
 * Cierra el corte contable del día anterior y sincroniza con Alegra.
 *
 * El cron dispara a las 23:59 CDMX (05:59 UTC). El corte es el día hábil de
 * CDMX **anterior**: una jornada ya cerrada de punta a punta, sin carrera con
 * el último minuto del día.
 *
 * `fechaCorte` permite forzar el corte (reprocesos manuales y pruebas).
 */
export async function handleContabilidadDaily(
  env: Env,
  fechaCorte?: string
): Promise<ResultadoContabilidad> {
  const timeZone = env.TZ ?? 'America/Mexico_City';
  const fecha = fechaCorte ?? diaPrevioIso(timeZone);

  logger.info('Cron contable ejecutado', { fecha_corte: fecha });

  // ── Fase 0: reconciliación de cortes que quedaron a medio camino ──
  let reconciliacion: ResultadoReconciliacion | undefined;
  try {
    reconciliacion = await reconciliarCortesPendientes(env);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    await logEvent(env, 'alegra_sync', {
      payload: { fecha_corte: fecha, status: 'reconciliacion_fallida', error: mensaje },
    });
    logger.error('Falló la reconciliación previa', { fecha_corte: fecha, error: mensaje });
  }

  let construccion: ResultadoBuild;
  try {
    construccion = await construirPayload(fecha, env);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    await logEvent(env, 'alegra_sync', {
      payload: { fecha_corte: fecha, status: 'failed', error: mensaje },
    });
    logger.error('No se pudo construir el payload contable', {
      fecha_corte: fecha,
      error: mensaje,
    });
    return { fecha, payloadGuardado: false, enviado: false, error: mensaje };
  }

  const { payload } = construccion;

  // ── R2: el JSON normalizado siempre queda para auditoría ──
  let payloadGuardado = false;
  try {
    await guardarPayloadEnR2(env, fecha, payload);
    payloadGuardado = true;
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    await logEvent(env, 'alegra_sync', {
      payload: {
        fecha_corte: fecha,
        status: 'failed',
        error: `no se pudo guardar en R2: ${mensaje}`,
      },
    });
    logger.error('Falló el guardado del payload en R2', { fecha_corte: fecha, error: mensaje });
  }

  // ── Ledger roto: no se envía, se alerta ──
  if (!payload.ledger_integrity.verificado) {
    await logEvent(env, 'alegra_sync', {
      payload: {
        fecha_corte: fecha,
        idempotency_key: payload.idempotency_key,
        status: 'skipped',
        motivo: 'ledger_broken',
        aviso: 'el ledger no verifica: los asientos NO se enviaron a Alegra',
      },
    });
    logger.error('Contabilidad detenida: el ledger no verifica', { fecha_corte: fecha });
    return { fecha, payloadGuardado, enviado: false, error: 'ledger_broken' };
  }

  // ── Checkpoint del día (baseline del ledger para las próximas corridas) ──
  try {
    await guardarCheckpoint(
      env,
      fecha,
      construccion.checkpoint.hash,
      construccion.checkpoint.total
    );
  } catch (error) {
    logger.warn('No se pudo guardar el checkpoint del ledger', {
      fecha_corte: fecha,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Envío a Alegra ──
  try {
    const resultado = await sendToAlegra(payload, env);
    return { fecha, payloadGuardado, enviado: resultado.ok, resultado, reconciliacion };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    await logEvent(env, 'alegra_sync', {
      payload: { fecha_corte: fecha, status: 'failed', error: mensaje },
    });
    logger.error('Falló el cron contable', { fecha_corte: fecha, error: mensaje });
    return { fecha, payloadGuardado, enviado: false, error: mensaje, reconciliacion };
  }
}
