/**
 * Esquemas del módulo contable (payload normalizado hacia Alegra).
 *
 * El payload es el contrato entre Arkangel y Alegra: si no valida con Zod, no se
 * guarda en R2 y no se manda. Todo monto es MXN con dos decimales.
 */

import { z } from 'zod';

/** Tipos de asiento soportados por el módulo contable. */
export const TIPOS_ASIENTO = ['provision', 'gasto', 'contingencia'] as const;
export type TipoAsiento = (typeof TIPOS_ASIENTO)[number];

/** Cuenta de respaldo cuando la cuenta mapeada no existe en Alegra. */
export const CUENTA_CONTINGENCIA_DEFAULT = '5101-004';
export const CUENTA_PROVISION_CREDITO_DEFAULT = '1102-003';

/** Tasa de IVA usada para el resumen (configurable por var). */
export const IVA_PCT_DEFAULT = 16;

/** Nombre legible de la cuenta de respaldo (aparece en el evento de warning). */
export const DESCRIPCION_CONTINGENCIA_DEFAULT = 'Provisión por Contingencia Legal';

export const ResumenSchema = z.object({
  ingresos_reconocidos: z.number(),
  ingresos_no_reconocidos_por_bloqueo: z.number(),
  provision_cartera_ilegal: z.number(),
  iva_trasladado: z.number(),
  /**
   * IVA acreditable **estimado**: hoy no existe módulo de CFDI de proveedores,
   * así que se calcula sobre los asientos de tipo `gasto`. El campo se llama
   * "estimado" a propósito: el contador no debe tomarlo por un dato fiscal.
   */
  iva_acreditable_estimado: z.number(),
});

/** Ventana temporal del corte, en UTC y en hora CDMX. */
export const VentanaSchema = z.object({
  inicio_utc: z.string(),
  fin_utc: z.string(),
  inicio_cdmx: z.string(),
  fin_cdmx: z.string(),
});

/** Metadatos del corte: de dónde viene cada número y qué falta por confirmar. */
export const MetadataSchema = z.object({
  fuente_iva_acreditable: z.string(),
  nota: z.string(),
  regla_ingreso_reconocido: z.string(),
  version: z.string(),
});

export const DesgloseReglaSchema = z.object({
  count: z.number().int().nonnegative(),
  monto: z.number().nonnegative(),
});

export const AsientoSchema = z.object({
  cuenta_debito: z.string().min(1),
  cuenta_credito: z.string().min(1),
  concepto: z.string().min(1),
  monto: z.number().nonnegative(),
  tipo_asiento: z.enum(TIPOS_ASIENTO),
  regla_id: z.string().min(1),
  ley: z.string(),
  articulo: z.string(),
  castigo: z.string(),
  /** Hash de la cadena del ledger: ancla el asiento al registro append-only. */
  referencia_ledger: z.string().min(1),
  /** UUID del CFDI en Alegra; null cuando es "Provisión sin CFDI". */
  cfdi_relacionado: z.string().nullable(),
  /** Trazabilidad directa al registro de auditoría que originó el asiento. */
  legal_audit_id: z.string().min(1),
});

export const LedgerIntegritySchema = z.object({
  hash_primer_registro: z.string(),
  hash_ultimo_registro: z.string(),
  total_registros: z.number().int().nonnegative(),
  verificado: z.boolean(),
});

export const AccountingPayloadSchema = z.object({
  idempotency_key: z.string().min(1),
  fecha_corte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodo: z.string().regex(/^\d{4}-\d{2}$/),
  ventana: VentanaSchema,
  resumen: ResumenSchema,
  desglose_bloqueos: z.record(DesgloseReglaSchema),
  asientos: z.array(AsientoSchema),
  ledger_integrity: LedgerIntegritySchema,
  metadata: MetadataSchema,
});

export type ResumenContable = z.infer<typeof ResumenSchema>;
export type VentanaCorte = z.infer<typeof VentanaSchema>;
export type MetadataCorte = z.infer<typeof MetadataSchema>;
export type DesgloseRegla = z.infer<typeof DesgloseReglaSchema>;
export type AsientoContable = z.infer<typeof AsientoSchema>;
export type LedgerIntegrity = z.infer<typeof LedgerIntegritySchema>;
export type AccountingPayload = z.infer<typeof AccountingPayloadSchema>;

/** Resultado del parseo: o el payload validado, o el error con detalle. */
export function validarPayload(
  candidate: unknown
): { ok: true; payload: AccountingPayload } | { ok: false; error: string } {
  const parsed = AccountingPayloadSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error: issues };
}

/** Redondeo contable a dos decimales (MXN). */
export function mxn(cents: number): number {
  return Number((Math.round(cents) / 100).toFixed(2));
}
