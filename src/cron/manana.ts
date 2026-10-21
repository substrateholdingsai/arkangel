import { TraceContext, createTracer } from '../lib/logger';
import type { Env } from '../types/env';
import { dailyMetrics } from '../services/metricas';
import { logEvent } from '../services/eventos';
import { todayIso } from '../services/db';
import { dispararHoy } from '../orquestacion/disparador';
import { resolveTenantContext } from '../tenancy/context';

/**
 * Cron de las 6:00 AM. Es la red de seguridad del flujo neandertal:
 * el CSV llega por webhook del CRM, el botón verde dispara, y este cron
 * dispara lo que haya quedado listo (si CRON_AUTO_FIRE está activo).
 */
export async function handleScheduled(
  env: Env,
  scheduledTime: Date,
  parentTraceCtx?: TraceContext
): Promise<void> {
  const tracer = createTracer('manana');
  const traceCtx = parentTraceCtx ?? { traceId: '', spanId: '', sampled: true };
  const { log } = tracer.startSpan(traceCtx, 'handleScheduled');

  const ctx = await resolveTenantContext(env);
  const date = todayIso(ctx.config.tz);
  log.info('Cron 6AM ejecutado', {
    date,
    scheduledTime: scheduledTime.toISOString(),
    tenantId: ctx.tenantId,
    traceId: traceCtx.traceId,
  });

  const metrics = await dailyMetrics(ctx, date);

  if (!metrics.csv_received_at) {
    await logEvent(ctx, 'cron.csv_ausente', { payload: { date } });
    log.warn('No hay CSV recibido para hoy', { date });
    tracer.endSpan(log, { csv_ausente: true });
    return;
  }

  if (!ctx.config.cronAutoFire) {
    await logEvent(ctx, 'cron.requiere_disparo_manual', {
      payload: { date, casos: metrics.total },
    });
    tracer.endSpan(log, { manual_trigger_required: true });
    return;
  }

  const result = await dispararHoy(ctx, date);
  await logEvent(ctx, 'cron.disparo_automatico', { payload: { date, ...result } });
  tracer.endSpan(log, { ok: true, queued: result.queued });
}
