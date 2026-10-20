import type { Env } from '../types/env';
import type { Debt } from '../types/cobranza';
import { newId, nowIso } from './db';

interface DebtRow {
  id: string;
  client_id: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: Debt['status'];
  description: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

function toDebt(row: DebtRow): Debt {
  return {
    id: row.id,
    client_id: row.client_id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    due_date: row.due_date,
    status: row.status,
    description: row.description,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface DebtInput {
  clientId: string;
  amountCents: number;
  dueDate: string;
  description?: string | null;
  source?: string | null;
}

export async function createDebt(env: Env, input: DebtInput): Promise<Debt> {
  const id = newId('dbt');
  const timestamp = nowIso();

  await env.DB.prepare(
    `INSERT INTO debts (id, client_id, amount_cents, currency, due_date, status, description, source, created_at, updated_at)
     VALUES (?, ?, ?, 'MXN', ?, 'pending', ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.clientId,
      input.amountCents,
      input.dueDate,
      input.description ?? null,
      input.source ?? null,
      timestamp,
      timestamp
    )
    .run();

  return {
    id,
    client_id: input.clientId,
    amount_cents: input.amountCents,
    currency: 'MXN',
    due_date: input.dueDate,
    status: 'pending',
    description: input.description ?? null,
    source: input.source ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function listPendingDebts(env: Env, clientId: string): Promise<Debt[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM debts WHERE client_id = ? AND status IN ('pending', 'promised') ORDER BY due_date ASC`
  )
    .bind(clientId)
    .all<DebtRow>();
  return (result.results ?? []).map(toDebt);
}

export async function sumPendingCents(env: Env, clientId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM debts WHERE client_id = ? AND status IN ('pending', 'promised')`
  )
    .bind(clientId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function markDebtStatus(
  env: Env,
  debtId: string,
  status: Debt['status']
): Promise<void> {
  await env.DB.prepare('UPDATE debts SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, nowIso(), debtId)
    .run();
}
