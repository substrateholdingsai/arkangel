import type { TenantContext } from '../tenancy/types';
import { newId, nowIso } from './db';

export interface PromiseInput {
  tenantId: string;
  caseId: string;
  clientId: string;
  amountCents: number;
  promisedDate?: string | null;
  confidence: number;
  source?: string;
}

export async function recordPromise(ctx: TenantContext, input: PromiseInput): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO promises (id, tenant_id, case_id, client_id, amount_cents, promised_date, confidence, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  )
    .bind(
      newId('prm'),
      ctx.tenantId,
      input.caseId,
      input.clientId,
      input.amountCents,
      input.promisedDate ?? null,
      input.confidence,
      input.source ?? 'ai',
      nowIso()
    )
    .run();

  // Promueve el último mensaje saliente del caso a 'promise_made' para que el
  // módulo contable reconozca el ingreso aunque el webhook de entrega ('delivered')
  // aún no haya llegado del proveedor.
  await ctx.env.DB.prepare(
    `UPDATE messages SET status = 'promise_made'
     WHERE id = (
       SELECT id FROM messages
       WHERE tenant_id = ? AND case_id = ? AND direction = 'outbound'
         AND status IN ('sent', 'delivered', 'read')
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )`
  )
    .bind(ctx.tenantId, input.caseId)
    .run();
}

export async function hasOpenPromise(ctx: TenantContext, clientId: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM promises WHERE tenant_id = ? AND client_id = ? AND status = 'open'`
  )
    .bind(ctx.tenantId, clientId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0) > 0;
}

export async function countPromisesByDay(
  ctx: TenantContext,
  date: string
): Promise<{ count: number; montoCents: number }> {
  const row = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(amount_cents), 0) AS monto FROM promises WHERE tenant_id = ? AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, `${date}%`)
    .first<{ total: number; monto: number }>();
  return { count: Number(row?.total ?? 0), montoCents: Number(row?.monto ?? 0) };
}
