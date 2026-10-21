import type { DailyMetrics } from '../types/cobranza';
import type { TenantContext } from '../tenancy/types';
import { countPromisesByDay } from './promesas';

export async function dailyMetrics(ctx: TenantContext, date: string): Promise<DailyMetrics> {
  const totalRow = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM cases WHERE tenant_id = ? AND case_date = ?'
  )
    .bind(ctx.tenantId, date)
    .first<{ total: number }>();

  const outboundRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ? AND direction = 'outbound' AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, `${date}%`)
    .first<{ total: number }>();

  const inboundRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ? AND direction = 'inbound' AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, `${date}%`)
    .first<{ total: number }>();

  const collectedRow = await ctx.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM promises WHERE tenant_id = ? AND status = 'kept' AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, `${date}%`)
    .first<{ total: number }>();

  const promises = await countPromisesByDay(ctx, date);

  const estados = await ctx.env.DB.prepare(
    'SELECT status, COUNT(*) AS total FROM cases WHERE tenant_id = ? AND case_date = ? GROUP BY status'
  )
    .bind(ctx.tenantId, date)
    .all<{ status: string; total: number }>();

  const por_estado: Record<string, number> = {};
  for (const row of estados.results ?? []) por_estado[row.status] = Number(row.total);

  const intake = await ctx.env.DB.prepare(
    'SELECT created_at, file_name FROM intakes WHERE tenant_id = ? AND source = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(ctx.tenantId, 'csv')
    .first<{ created_at: string; file_name: string | null }>();

  return {
    total: Number(totalRow?.total ?? 0),
    enviadas: Number(outboundRow?.total ?? 0),
    contestadas: Number(inboundRow?.total ?? 0),
    promesas: promises.count,
    monto_prometido_cents: promises.montoCents,
    monto_cobrado_cents: Number(collectedRow?.total ?? 0),
    csv_received_at: intake?.created_at ?? null,
    csv_name: intake?.file_name ?? null,
    por_estado: por_estado,
  };
}
