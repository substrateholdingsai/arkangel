import type { CaseStatus, CollectionCase } from '../types/cobranza';
import type { ScoreBand } from '../lib/score';
import type { TenantContext } from '../tenancy/types';
import { newId, nowIso, parseJson } from './db';

interface CaseRow {
  id: string;
  tenant_id: string;
  case_date: string;
  client_id: string;
  debt_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  amount_cents: number;
  status: CaseStatus;
  score: number;
  score_band: ScoreBand;
  channel_state: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function toCase(row: CaseRow): CollectionCase {
  return {
    id: row.id,
    case_date: row.case_date,
    client_id: row.client_id,
    debt_id: row.debt_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    amount_cents: row.amount_cents,
    status: row.status,
    score: row.score,
    score_band: row.score_band,
    channel_state: row.channel_state,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CaseInput {
  tenantId: string;
  caseDate: string;
  clientId: string;
  debtId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  amountCents: number;
  score: number;
  scoreBand: ScoreBand;
  source: string;
}

/** Crea el caso del día. Si ya existe para el cliente, actualiza montos y score. */
export async function upsertCase(ctx: TenantContext, input: CaseInput): Promise<CollectionCase> {
  const id = newId('cas');
  const timestamp = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO cases (id, tenant_id, case_date, client_id, debt_id, name, phone, email, amount_cents, status, score, score_band, channel_state, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, '{}', ?, ?, ?)
     ON CONFLICT(tenant_id, client_id, case_date) DO UPDATE SET
       amount_cents = excluded.amount_cents,
       name = excluded.name,
       phone = excluded.phone,
       email = excluded.email,
       debt_id = excluded.debt_id,
       score = excluded.score,
       score_band = excluded.score_band,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      ctx.tenantId,
      input.caseDate,
      input.clientId,
      input.debtId,
      input.name,
      input.phone,
      input.email,
      input.amountCents,
      input.score,
      input.scoreBand,
      input.source,
      timestamp,
      timestamp
    )
    .run();

  const row = await ctx.env.DB.prepare(
    'SELECT * FROM cases WHERE tenant_id = ? AND client_id = ? AND case_date = ? LIMIT 1'
  )
    .bind(ctx.tenantId, input.clientId, input.caseDate)
    .first<CaseRow>();

  return toCase(row!);
}

export async function getCase(ctx: TenantContext, id: string): Promise<CollectionCase | null> {
  const row = await ctx.env.DB.prepare('SELECT * FROM cases WHERE tenant_id = ? AND id = ? LIMIT 1')
    .bind(ctx.tenantId, id)
    .first<CaseRow>();
  return row ? toCase(row) : null;
}

export async function listCasesByDate(ctx: TenantContext, date: string): Promise<CollectionCase[]> {
  const result = await ctx.env.DB.prepare(
    'SELECT * FROM cases WHERE tenant_id = ? AND case_date = ? ORDER BY amount_cents DESC'
  )
    .bind(ctx.tenantId, date)
    .all<CaseRow>();
  return (result.results ?? []).map(toCase);
}

export async function listReadyCases(ctx: TenantContext, date: string): Promise<CollectionCase[]> {
  const result = await ctx.env.DB.prepare(
    `SELECT * FROM cases WHERE tenant_id = ? AND case_date = ? AND status IN ('ready', 'sending') ORDER BY amount_cents DESC`
  )
    .bind(ctx.tenantId, date)
    .all<CaseRow>();
  return (result.results ?? []).map(toCase);
}

export interface CasePatch {
  status?: CaseStatus;
  score?: number;
  scoreBand?: ScoreBand;
  amountCents?: number;
  channelState?: Record<string, unknown>;
}

export async function updateCase(ctx: TenantContext, id: string, patch: CasePatch): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (patch.status) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.score !== undefined) {
    sets.push('score = ?');
    binds.push(patch.score);
  }
  if (patch.scoreBand) {
    sets.push('score_band = ?');
    binds.push(patch.scoreBand);
  }
  if (patch.amountCents !== undefined) {
    sets.push('amount_cents = ?');
    binds.push(patch.amountCents);
  }
  if (patch.channelState) {
    sets.push('channel_state = ?');
    binds.push(JSON.stringify(patch.channelState));
  }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  binds.push(nowIso());
  binds.push(ctx.tenantId);
  binds.push(id);

  await ctx.env.DB.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...binds)
    .run();
}

export interface ChannelState {
  whatsapp?: string;
  sms?: string;
  email?: string;
  lastChannel?: string;
  attempts?: number;
}

export function readChannelState(raw: string): ChannelState {
  return parseJson<ChannelState>(raw, {});
}

/** Próxima acción operativa según el estado del caso (columna del panel). */
export function proximaAccion(status: string): string {
  switch (status) {
    case 'ready':
      return 'Listo para disparo';
    case 'sending':
      return 'Enviando';
    case 'sent':
      return 'Recordatorio en 24 h';
    case 'replied':
      return 'En espera de respuesta';
    case 'promised':
      return 'Seguimiento a la promesa';
    case 'paid':
      return 'Cobro confirmado';
    case 'human':
      return 'Revisar antes de 14:00';
    case 'failed':
      return 'Reintentar / revisar canal';
    default:
      return 'Sin acción';
  }
}

/** Etiqueta legible del estado del caso. */
export function etiquetaEstado(status: string): string {
  const mapa: Record<string, string> = {
    ready: 'Listo',
    sending: 'Enviando',
    sent: 'Enviado',
    replied: 'Respondió',
    promised: 'Promesa',
    paid: 'Cobrado',
    human: 'Escalado a Humano',
    failed: 'Fallido',
  };
  return mapa[status] ?? status;
}
