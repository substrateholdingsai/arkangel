import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import type { CollectionCase } from '../types/cobranza';
import { listReadyCases } from '../services/casos';
import { logEvent } from '../services/eventos';

export interface DispararResult {
  queued: number;
  skipped: number;
  caseIds: string[];
}

/** Encola los casos listos (status ready) de una fecha. */
export async function enqueueCases(
  ctx: TenantContext,
  cases: CollectionCase[]
): Promise<DispararResult> {
  const result: DispararResult = { queued: 0, skipped: 0, caseIds: [] };

  for (const c of cases) {
    if (c.status !== 'ready') {
      result.skipped++;
      continue;
    }

    await ctx.env.COBRANZA_QUEUE.send({
      type: 'cobranza.disparar',
      caseId: c.id,
      clientId: c.client_id,
      attempt: 0,
      enqueuedAt: Date.now(),
      tenantId: ctx.tenantId,
    });

    result.queued++;
    result.caseIds.push(c.id);
    await logEvent(ctx, 'cobranza.enqueued', { caseId: c.id, clientId: c.client_id });
  }

  if (result.queued > 0) logger.info('Casos encolados', { queued: result.queued, tenantId: ctx.tenantId });
  return result;
}

/** Dispara todos los casos listos del día. Es el botón verde del dashboard. */
export async function dispararHoy(
  ctx: TenantContext,
  date: string
): Promise<DispararResult> {
  const cases = await listReadyCases(ctx, date);
  return enqueueCases(ctx, cases);
}
