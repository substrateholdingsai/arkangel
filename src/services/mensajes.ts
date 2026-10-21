import type { Channel, MessageRow, MessageStatus } from '../types/cobranza';
import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import { newId, nowIso } from './db';

interface MessageDbRow {
  id: string;
  tenant_id: string;
  case_id: string;
  client_id: string;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  provider_id: string | null;
  body: string;
  status: MessageStatus;
  error: string | null;
  meta: string | null;
  created_at: string;
}

function toMessage(row: MessageDbRow): MessageRow {
  return {
    id: row.id,
    case_id: row.case_id,
    client_id: row.client_id,
    channel: row.channel,
    direction: row.direction,
    provider_id: row.provider_id,
    body: row.body,
    status: row.status,
    error: row.error,
    meta: row.meta,
    created_at: row.created_at,
  };
}

export interface RecordMessageInput {
  caseId: string;
  clientId: string;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  providerId?: string | null;
  body: string;
  status?: MessageStatus;
  error?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function recordMessage(ctx: TenantContext, input: RecordMessageInput): Promise<MessageRow> {
  const id = newId('msg');
  const timestamp = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO messages (id, tenant_id, case_id, client_id, channel, direction, provider_id, body, status, error, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.tenantId,
      input.caseId,
      input.clientId,
      input.channel,
      input.direction,
      input.providerId ?? null,
      input.body,
      input.status ?? 'queued',
      input.error ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      timestamp
    )
    .run();

  return {
    id,
    case_id: input.caseId,
    client_id: input.clientId,
    channel: input.channel,
    direction: input.direction,
    provider_id: input.providerId ?? null,
    body: input.body,
    status: input.status ?? 'queued',
    error: input.error ?? null,
    meta: input.meta ? JSON.stringify(input.meta) : null,
    created_at: timestamp,
  };
}

export async function updateMessageStatus(
  ctx: TenantContext,
  providerId: string,
  status: MessageStatus,
  error?: string | null
): Promise<void> {
  await ctx.env.DB.prepare('UPDATE messages SET status = ?, error = ? WHERE tenant_id = ? AND provider_id = ?')
    .bind(status, error ?? null, ctx.tenantId, providerId)
    .run();
}

export async function listConversation(
  ctx: TenantContext,
  clientId: string,
  limit = 50
): Promise<MessageRow[]> {
  const result = await ctx.env.DB.prepare(
    'SELECT * FROM messages WHERE tenant_id = ? AND client_id = ? ORDER BY created_at ASC LIMIT ?'
  )
    .bind(ctx.tenantId, clientId, limit)
    .all<MessageDbRow>();
  return (result.results ?? []).map(toMessage);
}

export async function countOutboundByDay(
  ctx: TenantContext,
  date: string
): Promise<{ total: number; porCanal: Record<string, number> }> {
  const result = await ctx.env.DB.prepare(
    `SELECT channel, COUNT(*) AS total FROM messages
     WHERE tenant_id = ? AND direction = 'outbound' AND created_at LIKE ? GROUP BY channel`
  )
    .bind(ctx.tenantId, `${date}%`)
    .all<{ channel: string; total: number }>();

  const porCanal: Record<string, number> = {};
  let total = 0;
  for (const row of result.results ?? []) {
    porCanal[row.channel] = Number(row.total);
    total += Number(row.total);
  }
  return { total, porCanal };
}

/** Impactos reales al deudor en las últimas 24 h (regla 2.3 hostigamiento). */
export async function countContactos24h(ctx: TenantContext, clientId: string): Promise<number> {
  const row = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages
     WHERE tenant_id = ? AND client_id = ? AND direction = 'outbound' AND created_at >= datetime('now', '-24 hours')`
  )
    .bind(ctx.tenantId, clientId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** Contactos que el CRM declara vs. los que realmente salieron (regla 8.7). */
export async function countSentForCase(ctx: TenantContext, caseId: string): Promise<number> {
  const row = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages
     WHERE tenant_id = ? AND case_id = ? AND direction = 'outbound' AND status = 'sent'`
  )
    .bind(ctx.tenantId, caseId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** Última intención detectada por la IA en el caso (columna "Estado / Intención"). */
export async function ultimaIntencion(ctx: TenantContext, caseId: string): Promise<string | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT meta FROM messages
     WHERE tenant_id = ? AND case_id = ? AND direction = 'inbound' AND meta IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(ctx.tenantId, caseId)
    .first<{ meta: string | null }>();
  if (!row?.meta) return null;
  try {
    const meta = JSON.parse(row.meta) as { intent?: string };
    return meta.intent ?? null;
  } catch {
    return null;
  }
}

/** Actualiza la metadata de un mensaje (p. ej. la intención detectada). */
export async function actualizarMetaMensaje(
  ctx: TenantContext,
  messageId: string,
  meta: Record<string, unknown>
): Promise<void> {
  await ctx.env.DB.prepare('UPDATE messages SET meta = ? WHERE tenant_id = ? AND id = ?')
    .bind(JSON.stringify(meta), ctx.tenantId, messageId)
    .run();
}
