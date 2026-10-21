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
import type { TenantContext } from '../tenancy/types';
import { logger, TraceContext, createTracer } from '../lib/logger';
import { logEvent } from '../services/eventos';
import { listTenants } from '../tenancy/repository';
import { platformPrincipal } from '../auth/principal';
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
  fechaCorte?: string,
  parentTraceCtx?: TraceContext
): Promise<ResultadoContabilidad[]> {
  const tracer = createTracer('contabilidadDaily');
  const traceCtx = parentTraceCtx ?? { traceId: '', spanId: '', sampled: true };
  const { span, log } = tracer.startSpan(traceCtx, 'handleContabilidadDaily');

  const timeZone = env.TZ ?? 'America/Mexico_City';
  const fecha = fechaCorte ?? diaPrevioIso(timeZone);

  log.info('Cron contable ejecutado', { fecha_corte: fecha, traceId: traceCtx.traceId });

  // Obtener todos los tenants activos
  const tenants = await listTenants(env);
  const resultados: ResultadoContabilidad[] = [];

  for (const tenant of tenants) {
    if (tenant.status !== 'active') continue;

    const { span: tenantSpan, log: tenantLog } = tracer.startSpan(traceCtx, `tenant:${tenant.id}`);

    const ctx = {
      env,
      tenantId: tenant.id,
      tenant,
      config: {
        tz: tenant.tz,
        horaInicio: tenant.send_window_start,
        horaFin: tenant.send_window_end,
        maxContactos24h: tenant.max_contacts_per_day,
        montoToleranciaCents: tenant.legal_monto_tolerancia_cents,
        horarioEnRespuestas: tenant.legal_horario_en_respuestas === 1,
        dominiosPermitidos: tenant.allowed_payment_domains.split(',').filter(Boolean),
        condusef: tenant.condusef_registro,
        razonSocial: tenant.razon_social,
        rateLimitRpm: tenant.rate_limit_rpm,
        dedupeWindowHours: tenant.dedupe_window_hours,
        scoreAmountCeilingCents: tenant.score_amount_ceiling_cents,
        agentMode: tenant.agent_mode,
        agentAutoThresholdCents: tenant.agent_auto_threshold_cents,
        dryRun: tenant.dry_run === 1,
        cronAutoFire: tenant.cron_auto_fire === 1,
      },
      channels: [],
      principal: platformPrincipal('cron'),
    } as TenantContext;

    // ── Fase 0: reconciliación de cortes que quedaron a medio camino ──
    let reconciliacion: ResultadoReconciliacion | undefined;
    try {
      const resultadosRec = await reconciliarCortesPendientes(ctx.env);
      reconciliacion = resultadosRec[0];
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await logEvent(ctx, 'alegra_sync', {
        payload: { fecha_corte: fecha, status: 'reconciliacion_fallida', error: mensaje },
      });
      tenantLog.error('Falló la reconciliación previa', { fecha_corte: fecha, tenantId: tenant.id, error: mensaje });
    }

    let construccion: ResultadoBuild;
    try {
      construccion = await construirPayload(ctx, fecha);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await logEvent(ctx, 'alegra_sync', {
        payload: { fecha_corte: fecha, status: 'failed', error: mensaje },
      });
      tenantLog.error('No se pudo construir el payload contable', {
        fecha_corte: fecha,
        tenantId: tenant.id,
        error: mensaje,
      });
      resultados.push({ fecha, payloadGuardado: false, enviado: false, error: mensaje });
      tracer.endSpan(tenantLog, { error: true });
      continue;
    }

    const { payload } = construccion;

    // ── R2: el JSON normalizado siempre queda para auditoría ──
    let payloadGuardado = false;
    try {
      await guardarPayloadEnR2(ctx, fecha, payload);
      payloadGuardado = true;
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await logEvent(ctx, 'alegra_sync', {
        payload: {
          fecha_corte: fecha,
          status: 'failed',
          error: `no se pudo guardar en R2: ${mensaje}`,
        },
      });
      tenantLog.error('Falló el guardado del payload en R2', { fecha_corte: fecha, tenantId: tenant.id, error: mensaje });
    }

    // ── Ledger roto: no se envía, se alerta ──
    if (!payload.ledger_integrity.verificado) {
      await logEvent(ctx, 'alegra_sync', {
        payload: {
          fecha_corte: fecha,
          idempotency_key: payload.idempotency_key,
          status: 'skipped',
          motivo: 'ledger_broken',
          aviso: 'el ledger no verifica: los asientos NO se enviaron a Alegra',
        },
      });
      tenantLog.error('Contabilidad detenida: el ledger no verifica', { fecha_corte: fecha, tenantId: tenant.id });
      resultados.push({ fecha, payloadGuardado, enviado: false, error: 'ledger_broken' });
      tracer.endSpan(tenantLog, { ledger_broken: true });
      continue;
    }

    // ── Checkpoint del día (baseline del ledger para las próximas corridas) ──
    try {
      await guardarCheckpoint(
        ctx,
        fecha,
        construccion.checkpoint.hash,
        construccion.checkpoint.total
      );
    } catch (error) {
      tenantLog.warn('No se pudo guardar el checkpoint del ledger', {
        fecha_corte: fecha,
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // ── Envío a Alegra ──
    try {
      const resultado = await sendToAlegra(payload, ctx);
      resultados.push({ fecha, payloadGuardado, enviado: resultado.ok, resultado, reconciliacion });
      tracer.endSpan(tenantLog, { ok: resultado.ok });
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await logEvent(ctx, 'alegra_sync', {
        payload: { fecha_corte: fecha, status: 'failed', error: mensaje },
      });
      tenantLog.error('Falló el cron contable', { fecha_corte: fecha, tenantId: tenant.id, error: mensaje });
      resultados.push({ fecha, payloadGuardado, enviado: false, error: mensaje, reconciliacion });
      tracer.endSpan(tenantLog, { error: true });
    }
  }

  tracer.endSpan(log, { tenantsProcessed: tenants.length });
  return resultados;
}
