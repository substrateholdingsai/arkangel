import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import { newId, nowIso } from './db';

export async function logEvent(
  ctx: TenantContext,
  type: string,
  options: { caseId?: string | null; clientId?: string | null; payload?: unknown } = {}
): Promise<void> {
  await logEventForTenant(ctx.env, ctx.tenantId, type, options);
}

/**
 * Evento con el tenant explícito.
 *
 * Existe para los casos en los que todavía no hay contexto de tenant (por
 * ejemplo, la auditoría de impersonación, que se escribe justo cuando la
 * plataforma opera sobre un tenant ajeno). El tenant lo pone quien audita,
 * no el cliente de la petición.
 */
export async function logEventForTenant(
  env: Env,
  tenantId: string,
  type: string,
  options: { caseId?: string | null; clientId?: string | null; payload?: unknown } = {}
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO events (id, tenant_id, type, case_id, client_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      newId('evt'),
      tenantId,
      type,
      options.caseId ?? null,
      options.clientId ?? null,
      options.payload ? JSON.stringify(options.payload) : null,
      nowIso()
    )
    .run();
}
