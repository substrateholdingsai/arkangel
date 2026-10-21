/**
 * Módulo contable — construcción del payload normalizado hacia Alegra.
 *
 * Traduce dos fuentes de verdad en un solo JSON auditable:
 *   · `legal_audit`  → provisiones, gastos y contingencias (una por violación).
 *   · `contracts` + `messages` → ingresos reconocidos (mensajes entregados).
 *
 * Reglas duras:
 *   · El ledger (`legal_audit`) es append-only: aquí sólo se lee.
 *   · Las cuentas contables salen de `legal_accounting_map`; nunca se hardcodean.
 *   · Si la cadena de hashes del ledger no verifica, el payload se marca
 *     `verificado: false` y NADIE lo envía a Alegra (fail-closed).
 */

import type { Env } from '../types/env';
import type { TenantContext } from '../tenancy/types';
import { logEvent } from '../services/eventos';
import { logger } from '../lib/logger';
import { todayIso } from '../services/db';
import {
  IVA_PCT_DEFAULT,
  mxn,
  validarPayload,
  type AccountingPayload,
  type AsientoContable,
  type DesgloseRegla,
  type LedgerIntegrity,
  type TipoAsiento,
} from './schemas';

/** Límite defensivo de registros del ledger leídos por corte. */
export const LIMITE_LEDGER = 50000;

/**
 * Regla de reconocimiento de ingreso: sólo cuentan los mensajes con recepción
 * real. `sent` NO cuenta: el proveedor aceptó el envío, no hay prueba de que
 * el deudor lo viera. `promise_made` queda reservado para cuando el estado de
 * promesa viva en `messages.status` (hoy vive en la tabla `promises`).
 */
export const ESTADOS_INGRESO_RECONOCIDO = ['delivered', 'read', 'promise_made'] as const;

/** Consultas del módulo (expuestas para pruebas y para el runbook). */
export const SQL_AUDITORIA_DIA = `SELECT id, tenant_id, regla_id, ley, articulo, castigo, accion, detalle, evidencia, case_id, client_id, canal, created_at
  FROM legal_audit
  WHERE tenant_id = ? AND replace(created_at, ' ', 'T') >= ? AND replace(created_at, ' ', 'T') < ?
  ORDER BY created_at ASC, id ASC`;

export const SQL_LEDGER_HISTORIA = `SELECT id, tenant_id, regla_id, accion, created_at, detalle, evidencia, castigo, articulo, ley
  FROM legal_audit
  WHERE tenant_id = ? AND replace(created_at, ' ', 'T') < ?
  ORDER BY created_at ASC, id ASC
  LIMIT ?`;

export const SQL_MAP_CONTABLE = `SELECT tenant_id, regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion
  FROM tenant_accounting_map
  WHERE tenant_id = ?`;

export const SQL_CASOS = `SELECT id, tenant_id, client_id, amount_cents, status FROM cases WHERE tenant_id = ? AND id IN (%IDS%)`;

export const SQL_CONTRATOS_CLIENTE = `SELECT id, tenant_id, client_id, monto_pactado_cents FROM contracts WHERE tenant_id = ? AND client_id IN (%IDS%) ORDER BY updated_at DESC`;

export const SQL_CFDI_CONTRATOS = `SELECT contract_id, cfdi_uuid FROM contract_cfdi WHERE tenant_id = ? AND contract_id IN (%IDS%)`;

export const SQL_INGRESOS_DIA = `SELECT m.client_id AS client_id, c.id AS contract_id, c.monto_pactado_cents AS monto_pactado_cents, COUNT(m.id) AS mensajes
  FROM messages m
  JOIN contracts c ON c.tenant_id = m.tenant_id AND c.client_id = m.client_id
  WHERE m.tenant_id = ?
    AND m.direction = 'outbound'
    AND m.status IN (${ESTADOS_INGRESO_RECONOCIDO.map(() => '?').join(', ')})
    AND replace(m.created_at, ' ', 'T') >= ? AND replace(m.created_at, ' ', 'T') < ?
  GROUP BY m.client_id, c.id`;

export const SQL_CHECKPOINT = `SELECT tenant_id, fecha_corte, hash_cadena, total_registros, verificado
  FROM ledger_checkpoint
  WHERE tenant_id = ? AND fecha_corte <= ?
  ORDER BY fecha_corte DESC
  LIMIT 1`;

export const SQL_CHECKPOINT_FECHA = `SELECT tenant_id, fecha_corte, hash_cadena, total_registros, verificado
  FROM ledger_checkpoint
  WHERE tenant_id = ? AND fecha_corte = ?
  LIMIT 1`;

export const SQL_UPSERT_CHECKPOINT = `INSERT OR IGNORE INTO ledger_checkpoint (tenant_id, fecha_corte, hash_cadena, total_registros, verificado)
  VALUES (?, ?, ?, ?, 1)`;

export const SQL_REBASAR_CHECKPOINT = `UPDATE ledger_checkpoint
  SET hash_cadena = ?, total_registros = ?, verificado = 1
  WHERE tenant_id = ? AND fecha_corte = ?`;

export interface AuditoriaRow {
  id: string;
  tenant_id: string;
  regla_id: string;
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

export interface LedgerRow {
  id: string;
  tenant_id: string;
  regla_id: string;
  accion: string;
  created_at: string;
  detalle: string | null;
  evidencia: string | null;
  castigo: string | null;
  articulo: string | null;
  ley: string | null;
}

export interface MapaContable {
  tenant_id: string;
  regla_id: string;
  cuenta_debito: string;
  cuenta_credito: string;
  tipo_asiento: string;
  descripcion: string | null;
}

export interface CasoRow {
  id: string;
  tenant_id: string;
  client_id: string;
  amount_cents: number;
  status: string;
}

export interface ContratoRow {
  id: string;
  tenant_id: string;
  client_id: string;
  monto_pactado_cents: number;
}

export interface Checkpoint {
  tenant_id: string;
  fecha_corte: string;
  hash_cadena: string;
  total_registros: number;
  verificado?: number;
}

const ETIQUETA_TIPO: Record<TipoAsiento, string> = {
  provision: 'Provisión',
  gasto: 'Gasto',
  contingencia: 'Contingencia',
};

// ────────────────────────────── utilidades de fecha ──────────────────────────────

/** Desplazamiento de la zona horaria (ms) respecto a UTC en un instante dado. */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const valor = (tipo: string): number =>
    Number(parts.find((part) => part.type === tipo)?.value ?? '0');
  const comoUtc = Date.UTC(
    valor('year'),
    valor('month') - 1,
    valor('day'),
    valor('hour') % 24,
    valor('minute'),
    valor('second')
  );
  return comoUtc - instant.getTime();
}

/**
 * Ventana UTC semiabierta que corresponde a un día hábil en la zona del Worker.
 * `desde` inclusivo, `hasta` exclusivo. Por ejemplo 2026-10-19 en CDMX
 * → ['2026-10-19T06:00:00.000Z', '2026-10-20T06:00:00.000Z').
 */
export function ventanaUtcDeDia(fecha: string, timeZone: string): { desde: string; hasta: string } {
  const [anio, mes, dia] = fecha.split('-').map((part) => Number(part));
  const naiveInicio = Date.UTC(anio || 1970, (mes || 1) - 1, dia || 1);
  const naiveFin = Date.UTC(anio || 1970, (mes || 1) - 1, (dia || 1) + 1);

  let offset = tzOffsetMs(new Date(naiveInicio), timeZone);
  let inicio = new Date(naiveInicio - offset);
  offset = tzOffsetMs(inicio, timeZone);
  inicio = new Date(naiveInicio - offset);

  let offsetFin = tzOffsetMs(new Date(naiveFin), timeZone);
  let fin = new Date(naiveFin - offsetFin);
  offsetFin = tzOffsetMs(fin, timeZone);
  fin = new Date(naiveFin - offsetFin);

  return { desde: inicio.toISOString(), hasta: fin.toISOString() };
}

/** Versión del contrato de payload (para el contador y para el auditor). */
export const VERSION_PAYLOAD = '1.0.0';

/** Valor inicial de la cadena: un día sin violaciones deja la cadena vacía. */
export const GENESIS_HASH = '0x0';

/**
 * Ventana del corte en UTC y en hora CDMX. El corte es el día hábil de CDMX
 * cerrado: así la ventana de contacto 08:00–22:00 nunca se parte en dos.
 */
export function ventanaDeDia(
  fecha: string,
  timeZone: string
): {
  inicio_utc: string;
  fin_utc: string;
  inicio_cdmx: string;
  fin_cdmx: string;
} {
  const { desde, hasta } = ventanaUtcDeDia(fecha, timeZone);
  const [anio, mes, dia] = fecha.split('-').map((part) => Number(part));
  const naiveInicio = Date.UTC(anio || 1970, (mes || 1) - 1, dia || 1);
  const offsetMin = Math.round(tzOffsetMs(new Date(naiveInicio), timeZone) / 60000);
  const offsetFin = Math.round(tzOffsetMs(new Date(naiveInicio + 86_400_000), timeZone) / 60000);

  return {
    inicio_utc: desde,
    fin_utc: hasta,
    inicio_cdmx: isoLocalMedianoche(fecha, offsetMin),
    fin_cdmx: isoLocalMedianoche(fecha, offsetFin, true),
  };
}

/** ISO local con offset: 2026-10-19T00:00:00-06:00 */
function isoLocalMedianoche(fecha: string, offsetMin: number, diaSiguiente = false): string {
  const [anio, mes, dia] = fecha.split('-').map((part) => Number(part));
  const base = new Date(
    Date.UTC(anio || 1970, (mes || 1) - 1, (dia || 1) + (diaSiguiente ? 1 : 0))
  );
  const iso = base.toISOString().slice(0, 10);
  const signo = offsetMin < 0 ? '-' : '+';
  const absoluto = Math.abs(offsetMin);
  const horas = String(Math.floor(absoluto / 60)).padStart(2, '0');
  const minutos = String(absoluto % 60).padStart(2, '0');
  return `${iso}T00:00:00${signo}${horas}:${minutos}`;
}

/** Día hábil anterior (MX) respecto a hoy. */
export function diaPrevioIso(timeZone: string): string {
  const [anio, mes, dia] = todayIso(timeZone)
    .split('-')
    .map((part) => Number(part));
  return new Date(Date.UTC(anio || 1970, (mes || 1) - 1, (dia || 1) - 1))
    .toISOString()
    .slice(0, 10);
}

// ────────────────────────────── utilidades de dato ──────────────────────────────

export async function sha256Hex(entrada: string): Promise<string> {
  const datos = new TextEncoder().encode(entrada);
  const digest = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** D1 puede timeoutear: se reintenta 3 veces y, si persiste, escala a un humano. */
export async function conReintentos<T>(operacion: () => Promise<T>, intentos = 3): Promise<T> {
  let ultimoError: unknown;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      return await operacion();
    } catch (error) {
      ultimoError = error;
      if (intento < intentos - 1) await sleep(200 * 2 ** intento);
    }
  }
  throw new Error(
    `Consulta D1 falló tras ${intentos} intentos: ${
      ultimoError instanceof Error ? ultimoError.message : String(ultimoError)
    }`
  );
}

function placeholders(cantidad: number): string {
  return new Array(cantidad).fill('?').join(', ');
}

function idsUnicos(valores: (string | null | undefined)[]): string[] {
  return Array.from(new Set(valores.filter((v): v is string => Boolean(v))));
}

// ────────────────────────────── cadena del ledger ──────────────────────────────

export interface CadenaLedger {
  /** Cabeza de la cadena (hash + posición acumulada) al cierre de cada día. */
  cabezasPorDia: Map<string, { hash: string; total: number }>;
  /** Hash de la cadena por registro de auditoría. */
  hashPorRegistro: Map<string, string>;
  /** Conjunto de hashes de la cadena (para comprobar ancestros). */
  hashes: Set<string>;
  totalHistorico: number;
  /** Hash del primer registro del día de corte. */
  hashPrimerRegistro: string;
  /** Hash del último registro del día de corte. */
  hashUltimoRegistro: string;
  /** Registros del día de corte. */
  totalRegistros: number;
  /** Hash absoluto del corte (cadena completa desde el génesis). */
  hashCorte: string;
}

/**
 * Cadena de hashes sobre `legal_audit` (append-only). Cada eslabón depende del
 * anterior, así que alterar un registro viejo invalida toda la cola.
 */
export async function calcularCadenaLedger(
  filas: LedgerRow[],
  fechaCorte: string
): Promise<CadenaLedger> {
  const cabezasPorDia = new Map<string, { hash: string; total: number }>();
  const hashPorRegistro = new Map<string, string>();
  const hashes = new Set<string>();
  let previo = GENESIS_HASH;
  let total = 0;
  let hashPrimerRegistro = '';
  let hashUltimoRegistro = '';
  let totalRegistros = 0;

  for (const fila of filas) {
    const material = [
      previo,
      fila.id,
      fila.regla_id,
      fila.accion,
      fila.created_at,
      fila.detalle ?? '',
      fila.evidencia ?? '',
      fila.castigo ?? '',
      fila.articulo ?? '',
      fila.ley ?? '',
    ].join('|');
    const hash = `0x${await sha256Hex(material)}`;
    previo = hash;
    total += 1;
    hashPorRegistro.set(fila.id, hash);
    hashes.add(hash);

    const dia = String(fila.created_at).slice(0, 10);
    cabezasPorDia.set(dia, { hash, total });

    if (dia === fechaCorte) {
      totalRegistros += 1;
      if (!hashPrimerRegistro) hashPrimerRegistro = hash;
      hashUltimoRegistro = hash;
    }
  }

  return {
    cabezasPorDia,
    hashPorRegistro,
    hashes,
    totalHistorico: total,
    hashPrimerRegistro,
    hashUltimoRegistro,
    totalRegistros,
    hashCorte: previo,
  };
}

/** Cabeza de la cadena al cierre de una fecha (inclusive). */
export function cabezaAlCorte(
  cadena: CadenaLedger,
  fechaCorte: string
): { hash: string; total: number } | null {
  let ultima: { hash: string; total: number } | null = null;
  for (const [dia, valor] of cadena.cabezasPorDia) {
    if (dia <= fechaCorte) ultima = valor;
    else break;
  }
  return ultima;
}

// ────────────────────────────── construcción ──────────────────────────────

export interface ResultadoBuild {
  payload: AccountingPayload;
  /** Reglas del catálogo sin mapeo contable (no generan asiento). */
  reglasSinMapa: string[];
  /** Checkpoint del día: cabeza de la cadena y posición acumulada. */
  checkpoint: { hash: string; total: number };
}

/**
 * Construye el payload contable del corte. Lanza si el JSON no valida con Zod:
 * un payload inválido nunca llega a R2 ni a Alegra.
 */
export async function buildAccountingPayload(ctx: TenantContext, fecha: string): Promise<AccountingPayload> {
  const resultado = await construirPayload(ctx, fecha);
  return resultado.payload;
}

export async function construirPayload(ctx: TenantContext, fecha: string): Promise<ResultadoBuild> {
  const timeZone = ctx.config.tz;
  const ventana = ventanaDeDia(fecha, timeZone);
  const desde = ventana.inicio_utc;
  const hasta = ventana.fin_utc;

  const [auditoria, mapa, ingresos, checkpointPrevio, checkpointDia, historia] = await Promise.all([
    conReintentos(() => ctx.env.DB.prepare(SQL_AUDITORIA_DIA).bind(ctx.tenantId, desde, hasta).all<AuditoriaRow>()),
    conReintentos(() => ctx.env.DB.prepare(SQL_MAP_CONTABLE).bind(ctx.tenantId).all<MapaContable>()),
    conReintentos(() =>
      ctx.env.DB.prepare(SQL_INGRESOS_DIA)
        .bind(ctx.tenantId, ...ESTADOS_INGRESO_RECONOCIDO, desde, hasta)
        .all<{
          client_id: string;
          contract_id: string;
          monto_pactado_cents: number;
          mensajes: number;
        }>()
    ),
    conReintentos(() => ctx.env.DB.prepare(SQL_CHECKPOINT).bind(ctx.tenantId, fecha).first<Checkpoint>()),
    conReintentos(() => ctx.env.DB.prepare(SQL_CHECKPOINT_FECHA).bind(ctx.tenantId, fecha).first<Checkpoint>()),
    conReintentos(() =>
      ctx.env.DB.prepare(SQL_LEDGER_HISTORIA).bind(ctx.tenantId, hasta, LIMITE_LEDGER).all<LedgerRow>()
    ),
  ]);

  const filasAuditoria = auditoria.results ?? [];
  const filasMapa = mapa.results ?? [];
  const filasIngresos = ingresos.results ?? [];
  const filasHistoria = historia.results ?? [];

  // ── Ledger: cadena de hashes + verificación contra el checkpoint ──
  const cadena = await calcularCadenaLedger(filasHistoria, fecha);
  const integridad = await verificarLedger(ctx, fecha, cadena, checkpointPrevio, checkpointDia);
  const cabeza = cabezaAlCorte(cadena, fecha);

  // ── Montos por caso y contratos ──
  const caseIds = idsUnicos(filasAuditoria.map((fila) => fila.case_id));
  const clientIds = idsUnicos(filasAuditoria.map((fila) => fila.client_id));

  const casos = await cargarCasos(ctx, caseIds);
  const contratos = await cargarContratos(ctx, clientIds);
  const cfdis = await cargarCfdis(
    ctx,
    contratos.map((contrato) => contrato.id)
  );

  const porCaso = new Map(casos.map((caso) => [caso.id, caso]));
  const contratoPorCliente = new Map<string, ContratoRow>();
  for (const contrato of contratos) {
    if (!contratoPorCliente.has(contrato.client_id)) {
      contratoPorCliente.set(contrato.client_id, contrato);
    }
  }

  const mapaPorRegla = new Map<string, MapaContable>();
  for (const fila of filasMapa) mapaPorRegla.set(fila.regla_id, fila);

  const reglasSinMapa = new Set<string>();
  const desglose = new Map<string, DesgloseRegla>();
  const asientos: AsientoContable[] = [];
  const casosAfectados = new Map<string, number>();
  const casosBloqueados = new Map<string, number>();

  for (const fila of filasAuditoria) {
    const mapeo = mapaPorRegla.get(fila.regla_id);
    if (!mapeo) {
      reglasSinMapa.add(fila.regla_id);
      continue;
    }

    const montoCents = montoDeViolacion(fila, porCaso, contratoPorCliente);
    const cfdi = cfdiDelCaso(fila, contratoPorCliente, cfdis);

    const previo = desglose.get(fila.regla_id) ?? { count: 0, monto: 0 };
    desglose.set(fila.regla_id, {
      count: previo.count + 1,
      monto: Number((previo.monto + mxn(montoCents)).toFixed(2)),
    });

    if (fila.case_id) casosAfectados.set(fila.case_id, montoCents);
    if (fila.accion === 'BLOCK' && fila.case_id) casosBloqueados.set(fila.case_id, montoCents);

    const tipo = (mapeo.tipo_asiento as TipoAsiento) ?? 'contingencia';
    const referenciaLedger = referenciaLedgerDe(fila.id, cadena);

    asientos.push({
      cuenta_debito: mapeo.cuenta_debito,
      cuenta_credito: mapeo.cuenta_credito,
      concepto: conceptoDe({
        tipo,
        articulo: fila.articulo ?? '',
        legalAuditId: fila.id,
        referenciaLedger,
        cfdi,
      }),
      monto: mxn(montoCents),
      tipo_asiento: tipo,
      regla_id: fila.regla_id,
      ley: fila.ley ?? '',
      articulo: fila.articulo ?? '',
      castigo: fila.castigo ?? '',
      referencia_ledger: referenciaLedger,
      cfdi_relacionado: cfdi,
      legal_audit_id: fila.id,
    });
  }

  // ── Resumen ──
  const ingresosCents = ingresosUnicos(filasIngresos);
  const ivaPct = Number(ctx.env.ALEGRA_IVA_PCT ?? IVA_PCT_DEFAULT);
  const gastosCents = asientos
    .filter((asiento) => asiento.tipo_asiento === 'gasto')
    .reduce((suma, asiento) => suma + Math.round(asiento.monto * 100), 0);
  const bloqueadoCents = sumarCasos(casosBloqueados);
  const exponidoCents = sumarCasos(casosAfectados);

  const resumen = {
    ingresos_reconocidos: mxn(ingresosCents),
    ingresos_no_reconocidos_por_bloqueo: mxn(bloqueadoCents),
    provision_cartera_ilegal: mxn(exponidoCents),
    iva_trasladado: Number(((ingresosCents / 100) * (ivaPct / 100)).toFixed(2)),
    // TODO(arkangel-contabilidad): cuando exista el módulo de CFDI de proveedores,
    // reemplazar este cálculo por el IVA acreditable real.
    iva_acreditable_estimado: Number(((gastosCents / 100) * (ivaPct / 100)).toFixed(2)),
  };

  const idempotencyKey = await calcularIdempotencyKey(
    fecha,
    integridad.total_registros,
    integridad.hash_ultimo_registro,
    ctx.env.ALEGRA_IDEMPOTENCY_SALT
  );

  const payload = {
    idempotency_key: idempotencyKey,
    fecha_corte: fecha,
    periodo: fecha.slice(0, 7),
    ventana: {
      inicio_utc: ventana.inicio_utc,
      fin_utc: ventana.fin_utc,
      inicio_cdmx: ventana.inicio_cdmx,
      fin_cdmx: ventana.fin_cdmx,
    },
    resumen,
    desglose_bloqueos: Object.fromEntries(
      [...desglose.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
    asientos,
    ledger_integrity: integridad,
    metadata: {
      fuente_iva_acreditable: 'estimado_por_gastos_arkangel',
      nota: 'Sustituir por IVA acreditable real cuando exista módulo de CFDI de proveedores',
      regla_ingreso_reconocido: ESTADOS_INGRESO_RECONOCIDO.join(', '),
      version: VERSION_PAYLOAD,
    },
  };

  const validado = validarPayload(payload);
  if (!validado.ok) {
    throw new Error(`Payload contable inválido: ${validado.error}`);
  }

  if (reglasSinMapa.size > 0) {
    await logEvent(ctx, 'contabilidad.regla_sin_mapa', {
      payload: { fecha_corte: fecha, reglas: [...reglasSinMapa] },
    });
    logger.warn('Reglas legales sin mapeo contable', {
      fecha_corte: fecha,
      reglas: [...reglasSinMapa],
    });
  }

  return {
    payload: validado.payload,
    reglasSinMapa: [...reglasSinMapa],
    checkpoint: { hash: cabeza?.hash ?? cadena.hashCorte, total: cabeza?.total ?? 0 },
  };
}

/** SHA256(salt + fecha_corte + total_registros + hash_ultimo_registro). */
export async function calcularIdempotencyKey(
  fecha: string,
  totalRegistros: number,
  hashUltimoRegistro: string,
  salt?: string
): Promise<string> {
  const digests = await sha256Hex(`${salt ?? ''}${fecha}${totalRegistros}${hashUltimoRegistro}`);
  return `sha256:${digests}`;
}

/**
 * Verifica la integridad del ledger comparando la cadena recalculada contra el
 * checkpoint almacenado. Si algo no cuadra, `verificado` queda en false y el
 * flujo contable se detiene (fail-closed).
 *
 * Tres casos:
 *   1. el checkpoint coincide con la cabeza recalculada  → ledger intacto;
 *   2. el checkpoint es un ancestro de la cadena actual → hubo un alta legítima
 *      posterior al corte (se re-atenúa el checkpoint y se avisa);
 *   3. el checkpoint no aparece en la cadena             → el ledger fue alterado.
 */
async function verificarLedger(
  ctx: TenantContext,
  fecha: string,
  cadena: CadenaLedger,
  checkpointPrevio: Checkpoint | null,
  checkpointDia: Checkpoint | null
): Promise<LedgerIntegrity> {
  const motivos: string[] = [];
  let verificado = true;

  for (const checkpoint of [checkpointPrevio, checkpointDia]) {
    if (!checkpoint) continue;

    if (checkpoint.verificado === 0) {
      verificado = false;
      motivos.push(`el checkpoint de ${checkpoint.fecha_corte} está marcado como no verificado`);
      continue;
    }

    const cabeza = cabezaAlCorte(cadena, checkpoint.fecha_corte);
    if (cabeza && cabeza.hash === checkpoint.hash_cadena) continue;

    // Día sin violaciones: el checkpoint apunta al génesis de la cadena.
    if (!cabeza && checkpoint.hash_cadena === GENESIS_HASH) continue;

    // El checkpoint no es la cabeza actual: ¿es un ancestro (alta legítima)?
    if (cabeza && cadena.hashes.has(checkpoint.hash_cadena)) {
      await rebasarCheckpoint(ctx, checkpoint.fecha_corte, cabeza.hash, cabeza.total);
      await logEvent(ctx, 'ledger_rebasado', {
        payload: {
          fecha_corte: fecha,
          checkpoint_fecha: checkpoint.fecha_corte,
          aviso: 'el ledger creció después del corte: se re-atenúa el checkpoint',
        },
      });
      continue;
    }

    verificado = false;
    motivos.push(
      `el ledger cambió en o antes de ${checkpoint.fecha_corte}: checkpoint ${checkpoint.hash_cadena} no está en la cadena recalculada`
    );
  }

  if (!verificado) {
    await logEvent(ctx, 'ledger_broken', {
      payload: { fecha_corte: fecha, motivos, total_registros: cadena.totalRegistros },
    });
    logger.error('Integridad del ledger comprometida', { fecha_corte: fecha, motivos });
  }

  return {
    hash_primer_registro: cadena.hashPrimerRegistro,
    hash_ultimo_registro: cadena.hashUltimoRegistro,
    total_registros: cadena.totalRegistros,
    verificado,
  };
}

async function cargarCasos(ctx: TenantContext, caseIds: string[]): Promise<CasoRow[]> {
  if (caseIds.length === 0) return [];
  const sql = SQL_CASOS.replace('%IDS%', placeholders(caseIds.length));
  const result = await conReintentos(() =>
    ctx.env.DB.prepare(sql)
      .bind(ctx.tenantId, ...caseIds)
      .all<CasoRow>()
  );
  return result.results ?? [];
}

async function cargarContratos(ctx: TenantContext, clientIds: string[]): Promise<ContratoRow[]> {
  if (clientIds.length === 0) return [];
  const sql = SQL_CONTRATOS_CLIENTE.replace('%IDS%', placeholders(clientIds.length));
  const result = await conReintentos(() =>
    ctx.env.DB.prepare(sql)
      .bind(ctx.tenantId, ...clientIds)
      .all<ContratoRow>()
  );
  return result.results ?? [];
}

async function cargarCfdis(ctx: TenantContext, contractIds: string[]): Promise<Map<string, string>> {
  if (contractIds.length === 0) return new Map();
  const sql = SQL_CFDI_CONTRATOS.replace('%IDS%', placeholders(contractIds.length));
  const result = await conReintentos(() =>
    ctx.env.DB.prepare(sql)
      .bind(ctx.tenantId, ...contractIds)
      .all<{ contract_id: string; cfdi_uuid: string }>()
  );
  return new Map((result.results ?? []).map((fila) => [fila.contract_id, fila.cfdi_uuid]));
}

/** Monto expuesto por una violación: el caso manda; si no, el contrato del cliente. */
function montoDeViolacion(
  fila: AuditoriaRow,
  porCaso: Map<string, CasoRow>,
  contratoPorCliente: Map<string, ContratoRow>
): number {
  const caso = fila.case_id ? porCaso.get(fila.case_id) : undefined;
  if (caso && caso.amount_cents > 0) return caso.amount_cents;
  const contrato = fila.client_id ? contratoPorCliente.get(fila.client_id) : undefined;
  if (contrato) return contrato.monto_pactado_cents;
  return 0;
}

function cfdiDelCaso(
  fila: AuditoriaRow,
  contratoPorCliente: Map<string, ContratoRow>,
  cfdis: Map<string, string>
): string | null {
  const contrato = fila.client_id ? contratoPorCliente.get(fila.client_id) : undefined;
  if (!contrato) return null;
  return cfdis.get(contrato.id) ?? null;
}

/** Ingresos reconocidos: una vez por cliente (el contrato pactado). */
function ingresosUnicos(
  filas: { client_id: string; contract_id: string; monto_pactado_cents: number }[]
): number {
  const vistos = new Set<string>();
  let total = 0;
  for (const fila of filas) {
    if (vistos.has(fila.client_id)) continue;
    vistos.add(fila.client_id);
    total += Number(fila.monto_pactado_cents ?? 0);
  }
  return total;
}

function sumarCasos(casos: Map<string, number>): number {
  let total = 0;
  for (const monto of casos.values()) total += monto;
  return total;
}

/**
 * Referencia al ledger: hash de la cadena del registro de auditoría.
 * Es el ancla que permite rastrear el asiento hasta `legal_audit.id`.
 */
export function referenciaLedgerDe(legalAuditId: string, cadena: CadenaLedger): string {
  const hash = cadena.hashPorRegistro.get(legalAuditId);
  if (!hash) return `0x${legalAuditId.slice(0, 20)}`;
  return `0x${hash.slice(2, 22)}`;
}

function conceptoDe(params: {
  tipo: TipoAsiento;
  articulo: string;
  legalAuditId: string;
  referenciaLedger: string;
  cfdi: string | null;
}): string {
  const etiqueta = ETIQUETA_TIPO[params.tipo] ?? 'Provisión';
  const articulo = params.articulo ? ` ${params.articulo}` : '';
  const cfdi = params.cfdi ? ` — CFDI ${params.cfdi}` : ' — Provisión sin CFDI';
  return `${etiqueta}${articulo} — ref legal_audit: ${params.legalAuditId} — ledger ${params.referenciaLedger}${cfdi}`;
}

/**
 * Guarda el checkpoint del día una vez que el ledger verificó.
 * Sólo se inserta (nunca se sobrescribe): un checkpoint que cambia es evidencia
 * de manipulación y debe permanecer para la auditoría.
 */
export async function guardarCheckpoint(
  ctx: TenantContext,
  fecha: string,
  hash: string,
  total: number
): Promise<void> {
  await ctx.env.DB.prepare(SQL_UPSERT_CHECKPOINT).bind(ctx.tenantId, fecha, hash, total).run();
}

/**
 * Re-atenúa el checkpoint de un día: sólo se usa cuando la cadena recalculada
 * contiene el hash guardado (es decir, el ledger creció de forma legítima y
 * nadie lo alteró). Un checkpoint alterado nunca se re-atenúa: se conserva
 * como evidencia.
 */
export async function rebasarCheckpoint(
  ctx: TenantContext,
  fecha: string,
  hash: string,
  total: number
): Promise<void> {
  await ctx.env.DB.prepare(SQL_REBASAR_CHECKPOINT).bind(hash, total, ctx.tenantId, fecha).run();
}
