import type { Channel, MessageRow, MessageStatus } from '../types/cobranza';
import type { Env } from '../types/env';
import { newId, nowIso } from './db';

interface MessageDbRow {
  id: string;
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

export async function recordMessage(env: Env, input: RecordMessageInput): Promise<MessageRow> {
  const id = newId('msg');
  const timestamp = nowIso();

  await env.DB.prepare(
    `INSERT INTO messages (id, case_id, client_id, channel, direction, provider_id, body, status, error, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
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
  env: Env,
  providerId: string,
  status: MessageStatus,
  error?: string | null
): Promise<void> {
  await env.DB.prepare('UPDATE messages SET status = ?, error = ? WHERE provider_id = ?')
    .bind(status, error ?? null, providerId)
    .run();
}

export async function listConversation(
  env: Env,
  clientId: string,
  limit = 50
): Promise<MessageRow[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM messages WHERE client_id = ? ORDER BY created_at ASC LIMIT ?'
  )
    .bind(clientId, limit)
    .all<MessageDbRow>();
  return (result.results ?? []).map(toMessage);
}

export async function countOutboundByDay(
  env: Env,
  date: string
): Promise<{ total: number; porCanal: Record<string, number> }> {
  const result = await env.DB.prepare(
    `SELECT channel, COUNT(*) AS total FROM messages
     WHERE direction = 'outbound' AND created_at LIKE ? GROUP BY channel`
  )
    .bind(`${date}%`)
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
export async function countContactos24h(env: Env, clientId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages
     WHERE client_id = ? AND direction = 'outbound' AND created_at >= datetime('now', '-24 hours')`
  )
    .bind(clientId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** Contactos que el CRM declara vs. los que realmente salieron (regla 8.7). */
export async function countSentForCase(env: Env, caseId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM messages
     WHERE case_id = ? AND direction = 'outbound' AND status = 'sent'`
  )
    .bind(caseId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** Última intención detectada por la IA en el caso (columna "Estado / Intención"). */
export async function ultimaIntencion(env: Env, caseId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT meta FROM messages
     WHERE case_id = ? AND direction = 'inbound' AND meta IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(caseId)
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
  env: Env,
  messageId: string,
  meta: Record<string, unknown>
): Promise<void> {
  await env.DB.prepare('UPDATE messages SET meta = ? WHERE id = ?')
    .bind(JSON.stringify(meta), messageId)
    .run();
}
