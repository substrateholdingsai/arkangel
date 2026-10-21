import { logger } from '../lib/logger';
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
export async function handleScheduled(env: Env, scheduledTime: Date): Promise<void> {
  const ctx = await resolveTenantContext(env);
  const date = todayIso(ctx.config.tz);
  logger.info('Cron 6AM ejecutado', {
    date,
    scheduledTime: scheduledTime.toISOString(),
    tenantId: ctx.tenantId,
  });

  const metrics = await dailyMetrics(env, date);

  if (!metrics.csv_received_at) {
    await logEvent(env, 'cron.csv_ausente', { payload: { date } });
    logger.warn('No hay CSV recibido para hoy', { date });
    return;
  }

  if (!ctx.config.cronAutoFire) {
    await logEvent(env, 'cron.requiere_disparo_manual', {
      payload: { date, casos: metrics.total },
    });
    return;
  }

  const result = await dispararHoy(env, date, ctx.tenantId);
  await logEvent(env, 'cron.disparo_automatico', { payload: { date, ...result } });
}
