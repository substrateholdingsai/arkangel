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

const UUID_SAT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCfdiUuid(uuid: string): boolean {
  return UUID_SAT_REGEX.test(uuid.trim());
}

/**
 * Obtiene el UUID de CFDI timbrado vinculado a un contrato (`contract_cfdi`), si existe.
 */
export async function getContractCfdi(
  ctx: TenantContext,
  contractId: string
): Promise<string | null> {
  try {
    const row = await ctx.env.DB.prepare(
      'SELECT cfdi_uuid FROM contract_cfdi WHERE tenant_id = ? AND contract_id = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(ctx.tenantId, contractId)
      .first<{ cfdi_uuid: string }>();
    return row?.cfdi_uuid ?? null;
  } catch {
    return null;
  }
}

/**
 * Vincula o actualiza el UUID del CFDI timbrado para un contrato en `contract_cfdi`.
 * Este UUID viaja automáticamente como `cfdi_relacionado` hacia Alegra en el corte contable.
 */
export async function upsertContractCfdi(
  ctx: TenantContext,
  contractId: string,
  cfdiUuid: string
): Promise<{ id: string; contract_id: string; cfdi_uuid: string; created_at: string }> {
  const normalized = cfdiUuid.trim().toUpperCase();
  const timestamp = nowIso();
  const id = newId('cfdi');

  await ctx.env.DB.prepare('DELETE FROM contract_cfdi WHERE tenant_id = ? AND contract_id = ?')
    .bind(ctx.tenantId, contractId)
    .run();

  await ctx.env.DB.prepare(
    'INSERT INTO contract_cfdi (id, tenant_id, contract_id, cfdi_uuid, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, ctx.tenantId, contractId, normalized, timestamp)
    .run();

  return {
    id,
    contract_id: contractId,
    cfdi_uuid: normalized,
    created_at: timestamp,
  };
}
