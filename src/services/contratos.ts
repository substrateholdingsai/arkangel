import type { TenantContext } from '../tenancy/types';
import type { ContratoLegal } from '../legal/tipos';
import { newId, nowIso } from './db';

interface ContractRow {
  id: string;
  tenant_id: string;
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
  ctx: TenantContext,
  clientId: string
): Promise<ContratoLegal | null> {
  const row = await ctx.env.DB.prepare(
    'SELECT * FROM contracts WHERE tenant_id = ? AND client_id = ? ORDER BY updated_at DESC LIMIT 1'
  )
    .bind(ctx.tenantId, clientId)
    .first<ContractRow>();
  return row ? toContrato(row) : null;
}

export interface ContractInput {
  tenantId: string;
  clientId: string;
  montoPactadoCents: number;
  tasaPct?: number | null;
  clabe?: string | null;
  nombreLegal?: string | null;
  condusef?: string | null;
}

export async function upsertContract(
  ctx: TenantContext,
  input: ContractInput
): Promise<ContratoLegal> {
  const id = newId('con');
  const timestamp = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO contracts (id, tenant_id, client_id, monto_pactado_cents, tasa_pct, clabe, nombre_legal, condusef, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.tenantId,
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

export async function listContracts(ctx: TenantContext, limit = 100): Promise<ContratoLegal[]> {
  const result = await ctx.env.DB.prepare(
    'SELECT * FROM contracts WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?'
  )
    .bind(ctx.tenantId, limit)
    .all<ContractRow>();
  return (result.results ?? []).map(toContrato);
}
