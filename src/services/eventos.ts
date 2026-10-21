import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import { newId, nowIso } from './db';

export async function logEvent(
  ctx: TenantContext,
  type: string,
  options: { caseId?: string | null; clientId?: string | null; payload?: unknown } = {}
): Promise<void> {
  await ctx.env.DB.prepare(
    'INSERT INTO events (id, tenant_id, type, case_id, client_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      newId('evt'),
      ctx.tenantId,
      type,
      options.caseId ?? null,
      options.clientId ?? null,
      options.payload ? JSON.stringify(options.payload) : null,
      nowIso()
    )
    .run();
}
