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

  // Métricas de Telefonía & Voice AI (minutos hablados, llamadas completadas, promesas en audio)
  const callEvents = await ctx.env.DB.prepare(
    `SELECT type, payload FROM events 
     WHERE tenant_id = ? 
       AND type IN ('telnyx.conversation_ended', 'telnyx.call_hangup', 'operador.llamada_completada') 
       AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, `${date}%`)
    .all<{ type: string; payload: string | null }>();

  const seenCallIds = new Set<string>();
  let unkeyedCalls = 0;
  let totalCallSeconds = 0;

  for (const row of callEvents.results ?? []) {
    let sec = 0;
    let callKey: string | null = null;
    if (row.payload) {
      try {
        const parsed = JSON.parse(row.payload) as Record<string, unknown>;
        sec = Number(parsed.durationSeconds ?? parsed.duration_seconds ?? 0);
        const rawKey = parsed.callControlId ?? parsed.conversationId;
        if (typeof rawKey === 'string' && rawKey.length > 0) {
          callKey = rawKey;
        }
      } catch {
        /* ignorar json malformado */
      }
    }

    if (callKey) {
      if (!seenCallIds.has(callKey)) {
        seenCallIds.add(callKey);
        if (sec > 0) totalCallSeconds += sec;
      }
    } else {
      unkeyedCalls++;
      if (sec > 0) totalCallSeconds += sec;
    }
  }

  const voicePromisesRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM promises 
     WHERE tenant_id = ? 
       AND (source IN ('voice_ai', 'voice', 'telnyx') OR (source = 'ai' AND case_id IN (
         SELECT DISTINCT case_id FROM events 
         WHERE tenant_id = ? 
           AND type IN ('telnyx.conversation_ended', 'telnyx.conversation_insights', 'telnyx.recording_saved')
           AND created_at LIKE ?
       )))
       AND created_at LIKE ?`
  )
    .bind(ctx.tenantId, ctx.tenantId, `${date}%`, `${date}%`)
    .first<{ total: number }>();

  const minutos_voz_hoy = Math.round((totalCallSeconds / 60) * 10) / 10;
  const llamadas_voz_hoy = seenCallIds.size + unkeyedCalls;
  const promesas_voz_hoy = Number(voicePromisesRow?.total ?? 0);

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
    minutos_voz_hoy,
    llamadas_voz_hoy,
    promesas_voz_hoy,
  };
}
