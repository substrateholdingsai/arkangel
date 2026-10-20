import type { DailyMetrics } from '../types/cobranza';
import type { Env } from '../types/env';
import { countPromisesByDay } from './promesas';

export async function dailyMetrics(env: Env, date: string): Promise<DailyMetrics> {
  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM cases WHERE case_date = ?')
    .bind(date)
    .first<{ total: number }>();

  const outboundRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages WHERE direction = 'outbound' AND created_at LIKE ?`
  )
    .bind(`${date}%`)
    .first<{ total: number }>();

  const inboundRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages WHERE direction = 'inbound' AND created_at LIKE ?`
  )
    .bind(`${date}%`)
    .first<{ total: number }>();

  const collectedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM promises WHERE status = 'kept' AND created_at LIKE ?`
  )
    .bind(`${date}%`)
    .first<{ total: number }>();

  const promises = await countPromisesByDay(env, date);

  const estados = await env.DB.prepare(
    'SELECT status, COUNT(*) AS total FROM cases WHERE case_date = ? GROUP BY status'
  )
    .bind(date)
    .all<{ status: string; total: number }>();

  const por_estado: Record<string, number> = {};
  for (const row of estados.results ?? []) por_estado[row.status] = Number(row.total);

  const intake = await env.DB.prepare(
    'SELECT created_at, file_name FROM intakes WHERE source = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind('csv')
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
