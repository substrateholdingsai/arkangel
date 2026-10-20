import type { Env } from '../types/env';
import { newId, nowIso } from './db';

export interface PromiseInput {
  caseId: string;
  clientId: string;
  amountCents: number;
  promisedDate?: string | null;
  confidence: number;
  source?: string;
}

export async function recordPromise(env: Env, input: PromiseInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO promises (id, case_id, client_id, amount_cents, promised_date, confidence, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  )
    .bind(
      newId('prm'),
      input.caseId,
      input.clientId,
      input.amountCents,
      input.promisedDate ?? null,
      input.confidence,
      input.source ?? 'ai',
      nowIso()
    )
    .run();
}

export async function hasOpenPromise(env: Env, clientId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM promises WHERE client_id = ? AND status = 'open'`
  )
    .bind(clientId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0) > 0;
}

export async function countPromisesByDay(
  env: Env,
  date: string
): Promise<{ count: number; montoCents: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(amount_cents), 0) AS monto FROM promises WHERE created_at LIKE ?`
  )
    .bind(`${date}%`)
    .first<{ total: number; monto: number }>();
  return { count: Number(row?.total ?? 0), montoCents: Number(row?.monto ?? 0) };
}
