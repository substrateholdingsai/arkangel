import type { Env } from '../types/env';
import type { ContratoLegal } from '../legal/tipos';
import { newId, nowIso } from './db';

interface ContractRow {
  id: string;
  client_id: string;
  monto_pactado_cents: number;
  tasa_pct: number | null;
  clabe: string | null;
  nombre_legal: string | null;
  condusef: string | null;
  created_at: string;
  updated_at: string;
}

function toContrato(row: ContractRow): ContratoLegal {
  return {
    id: row.id,
    client_id: row.client_id,
    monto_pactado_cents: row.monto_pactado_cents,
    tasa_pct: row.tasa_pct,
    clabe: row.clabe,
    nombre_legal: row.nombre_legal,
    condusef: row.condusef,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Contrato vigente del cliente (el más reciente). Base de las reglas 8.1, 3.2 y 4.2. */
export async function getContractByClient(
  env: Env,
  clientId: string
): Promise<ContratoLegal | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM contracts WHERE client_id = ? ORDER BY updated_at DESC LIMIT 1'
  )
    .bind(clientId)
    .first<ContractRow>();
  return row ? toContrato(row) : null;
}

export interface ContractInput {
  clientId: string;
  montoPactadoCents: number;
  tasaPct?: number | null;
  clabe?: string | null;
  nombreLegal?: string | null;
  condusef?: string | null;
}

export async function upsertContract(env: Env, input: ContractInput): Promise<ContratoLegal> {
  const id = newId('con');
  const timestamp = nowIso();

  await env.DB.prepare(
    `INSERT INTO contracts (id, client_id, monto_pactado_cents, tasa_pct, clabe, nombre_legal, condusef, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.clientId,
      input.montoPactadoCents,
      input.tasaPct ?? null,
      input.clabe ?? null,
      input.nombreLegal ?? null,
      input.condusef ?? null,
      timestamp,
      timestamp
    )
    .run();

  return {
    id,
    client_id: input.clientId,
    monto_pactado_cents: input.montoPactadoCents,
    tasa_pct: input.tasaPct ?? null,
    clabe: input.clabe ?? null,
    nombre_legal: input.nombreLegal ?? null,
    condusef: input.condusef ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function listContracts(env: Env, limit = 100): Promise<ContratoLegal[]> {
  const result = await env.DB.prepare('SELECT * FROM contracts ORDER BY updated_at DESC LIMIT ?')
    .bind(limit)
    .all<ContractRow>();
  return (result.results ?? []).map(toContrato);
}
