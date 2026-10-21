import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import type { Violacion } from '../legal/tipos';
import { newId, nowIso } from './db';

export interface AuditoriaLegal {
  id: string;
  tenant_id: string;
  regla_id: string;
  seccion: string | null;
  conducta: string | null;
  ley: string | null;
  articulo: string | null;
  castigo: string | null;
  accion: string;
  detalle: string | null;
  evidencia: string | null;
  case_id: string | null;
  client_id: string | null;
  canal: string | null;
  created_at: string;
}

export interface EntradaAuditoria {
  caseId?: string | null;
  clientId?: string | null;
  canal?: string | null;
}

/** Bitácora de cumplimiento: cada violation queda con su base legal. */
export async function registrarViolacion(
  ctx: TenantContext,
  violacion: Violacion,
  entrada: EntradaAuditoria = {}
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO legal_audit (id, tenant_id, regla_id, seccion, conducta, ley, articulo, castigo, accion, detalle, evidencia, case_id, client_id, canal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId('leg'),
      ctx.tenantId,
      violacion.reglaId,
      violacion.seccion,
      violacion.conducta,
      violacion.ley,
      violacion.articulo,
      violacion.castigo,
      violacion.accion,
      violacion.detalle,
      violacion.evidencia?.slice(0, 1000) ?? null,
      entrada.caseId ?? null,
      entrada.clientId ?? null,
      entrada.canal ?? null,
      nowIso()
    )
    .run();
}

export async function registrarViolaciones(
  ctx: TenantContext,
  violaciones: Violacion[],
  entrada: EntradaAuditoria = {}
): Promise<void> {
  for (const violacion of violaciones) {
    await registrarViolacion(ctx, violacion, entrada);
  }
}

export interface ResumenCumplimiento {
  total: number;
  bloqueos: number;
  saneos: number;
  escalados: number;
  porRegla: Record<string, number>;
}

export async function resumenCumplimiento(ctx: TenantContext, date: string): Promise<ResumenCumplimiento> {
  const rows = await ctx.env.DB.prepare(
    'SELECT regla_id, accion, COUNT(*) AS total FROM legal_audit WHERE tenant_id = ? AND created_at LIKE ? GROUP BY regla_id, accion'
  )
    .bind(ctx.tenantId, `${date}%`)
    .all<{ regla_id: string; accion: string; total: number }>();

  const porRegla: Record<string, number> = {};
  let total = 0;
  let bloqueos = 0;
  let saneos = 0;
  let escalados = 0;

  for (const row of rows.results ?? []) {
    const n = Number(row.total);
    total += n;
    porRegla[row.regla_id] = (porRegla[row.regla_id] ?? 0) + n;
    if (row.accion === 'BLOCK') bloqueos += n;
    else if (row.accion === 'SANITIZE') saneos += n;
    else if (row.accion === 'ESCALATE') escalados += n;
  }

  return { total, bloqueos, saneos, escalados, porRegla };
}

export async function listAudit(ctx: TenantContext, limit = 50): Promise<AuditoriaLegal[]> {
  const result = await ctx.env.DB.prepare('SELECT * FROM legal_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(ctx.tenantId, limit)
    .all<AuditoriaLegal>();
  return result.results ?? [];
}
