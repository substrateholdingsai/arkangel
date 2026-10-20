import { logger } from '../lib/logger';
import { IdempotencyKey } from '../lib/idempotencia';
import type { Env } from '../types/env';
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
  env: Env,
  cases: CollectionCase[],
  channel?: string
): Promise<DispararResult> {
  const result: DispararResult = { queued: 0, skipped: 0, caseIds: [] };

  for (const c of cases) {
    if (c.status !== 'ready') {
      result.skipped++;
      continue;
    }

    await env.COBRANZA_QUEUE.send({
      type: 'cobranza.disparar',
      caseId: c.id,
      clientId: c.client_id,
      channel,
      attempt: 0,
      enqueuedAt: Date.now(),
    });

    result.queued++;
    result.caseIds.push(c.id);
    await logEvent(env, 'cobranza.enqueued', { caseId: c.id, clientId: c.client_id });
  }

  if (result.queued > 0) logger.info('Casos encolados', { queued: result.queued });
  return result;
}

/** Dispara todos los casos listos del día. Es el botón verde del dashboard. */
export async function dispararHoy(env: Env, date: string): Promise<DispararResult> {
  const cases = await listReadyCases(env, date);
  return enqueueCases(env, cases);
}

/** Llave de idempotencia por caso/canal (expuesta para los tests). */
export function caseChannelKey(caseId: string, channel: string): string {
  return IdempotencyKey.forCase(caseId, channel);
}
