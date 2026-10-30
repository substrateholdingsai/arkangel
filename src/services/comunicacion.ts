/**
 * Servicio de datos y persistencia del Motor de Comunicación.
 *
 * Administra el consentimiento (comm_consents), supresiones (comm_suppressions),
 * plantillas (comm_templates), y consultas a FrequencyCapDO.
 */

import type { Env } from '../types/env';
import type {
  CanalComunicacion,
  CategoriaConsentimiento,
  HechoConsentimiento,
  PlantillaComunicacion,
} from '../comunicacion/tipos';
import { idsDeLaOrganizacion } from '../tenancy/jerarquia';
import type { FrequencyCapResult } from '../durable/frequency-cap';

export interface RegistrarConsentimientoParams {
  tenantId: string;
  contacto: string;
  channel: CanalComunicacion;
  categoria: CategoriaConsentimiento;
  optInSource: string;
  evidence?: Record<string, unknown>;
  optInAt?: string;
}

/**
 * Registra o actualiza el opt-in para un contacto, canal y categoría específicos.
 */
export async function registrarConsentimiento(
  env: Env,
  params: RegistrarConsentimientoParams
): Promise<void> {
  const id = `c_${params.tenantId}_${params.channel}_${params.categoria}_${params.contacto}`;
  const now = params.optInAt ?? new Date().toISOString();
  const evidenceJson = params.evidence ? JSON.stringify(params.evidence) : null;

  await env.DB.prepare(
    `INSERT INTO comm_consents (
      id, tenant_id, contacto, channel, categoria, opt_in_at, opt_in_source, evidence, revoked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(tenant_id, contacto, channel, categoria) DO UPDATE SET
      opt_in_at = excluded.opt_in_at,
      opt_in_source = excluded.opt_in_source,
      evidence = excluded.evidence,
      revoked_at = NULL,
      updated_at = excluded.updated_at`
  )
    .bind(
      id,
      params.tenantId,
      params.contacto,
      params.channel,
      params.categoria,
      now,
      params.optInSource,
      evidenceJson,
      now
    )
    .run();
}

/**
 * Consulta el hecho de consentimiento para evaluar un envío.
 */
export async function obtenerHechoConsentimiento(
  env: Env,
  tenantId: string,
  contacto: string,
  channel: CanalComunicacion,
  categoria: CategoriaConsentimiento
): Promise<HechoConsentimiento | null> {
  const row = await env.DB.prepare(
    `SELECT opt_in_at, opt_in_source, revoked_at
     FROM comm_consents
     WHERE tenant_id = ? AND contacto = ? AND channel = ? AND categoria = ?
     LIMIT 1`
  )
    .bind(tenantId, contacto, channel, categoria)
    .first<{ opt_in_at: string; opt_in_source: string; revoked_at: string | null }>();

  if (!row) return null;

  return {
    optInAt: row.opt_in_at,
    optInSource: row.opt_in_source,
    revokedAt: row.revoked_at,
  };
}

/**
 * Verifica si un contacto está en la lista de supresiones (Opt-out directo) para un tenant.
 */
export async function estaSuprimido(
  env: Env,
  tenantId: string,
  contacto: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM comm_suppressions
     WHERE tenant_id = ? AND contacto = ?
     LIMIT 1`
  )
    .bind(tenantId, contacto)
    .first<{ id: string }>();

  return Boolean(row);
}

export interface RegistrarOptOutParams {
  contacto: string;
  tenantId: string;
  orgId: string;
  scope: 'marca' | 'organizacion';
  reason?: 'opt_out' | 'bounce' | 'blocked' | 'manual';
  detail?: string;
}

/**
 * Procesa una solicitud de baja (Opt-out).
 * Si scope === 'organizacion', aplica la supresión a la cámara y a todos sus socios.
 * Si scope === 'marca', aplica únicamente para el tenant emisor.
 */
export async function registrarOptOut(env: Env, params: RegistrarOptOutParams): Promise<string[]> {
  const reason = params.reason ?? 'opt_out';
  const now = new Date().toISOString();

  let targetTenantIds: string[] = [params.tenantId];
  if (params.scope === 'organizacion') {
    targetTenantIds = await idsDeLaOrganizacion(env, params.orgId);
  }

  for (const tid of targetTenantIds) {
    const suppId = `supp_${tid}_${params.contacto}_${reason}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO comm_suppressions (id, tenant_id, contacto, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(suppId, tid, params.contacto, reason, params.detail ?? 'webhook_inbound_optout', now)
      .run();

    // Revocar consentimientos activos para ese contacto y tenant
    await env.DB.prepare(
      `UPDATE comm_consents
       SET revoked_at = ?, revoked_source = ?
       WHERE tenant_id = ? AND contacto = ? AND revoked_at IS NULL`
    )
      .bind(now, `opt_out_${reason}`, tid, params.contacto)
      .run();
  }

  return targetTenantIds;
}

/**
 * Consulta o registra un impacto en FrequencyCapDO para la clave brandId + contacto.
 */
export async function checkFrequencyCap(
  env: Env,
  brandId: string,
  contacto: string,
  maxWeekly: number,
  increment: boolean
): Promise<FrequencyCapResult> {
  if (!env.FREQUENCY_CAP) {
    // Modo de desarrollo o sin binding
    return { allowed: true, count: 0, remaining: maxWeekly, maxWeekly };
  }

  const doKey = `fcap:${brandId}:${contacto}`;
  const doId = env.FREQUENCY_CAP.idFromName(doKey);
  const stub = env.FREQUENCY_CAP.get(doId);

  const action = increment ? 'check_and_increment' : 'status';
  const res = await stub.fetch(`http://frequency-cap/?action=${action}&max=${maxWeekly}`);
  return (await res.json()) as FrequencyCapResult;
}

/**
 * Obtiene una plantilla aprobada por su ID, permitiendo plantillas compartidas de la organización.
 */
export async function obtenerPlantilla(
  env: Env,
  id: string,
  tenantId: string,
  orgId: string
): Promise<PlantillaComunicacion | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM comm_templates
     WHERE id = ? AND (tenant_id = ? OR (tenant_id = ? AND shared = 1))
     LIMIT 1`
  )
    .bind(id, tenantId, orgId)
    .first<any>();

  if (!row) return null;

  let vars: string[] = [];
  try {
    vars = JSON.parse(row.variables_json || '[]');
  } catch {
    vars = [];
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel,
    nombre: row.nombre,
    metaName: row.meta_name,
    lang: row.lang ?? 'es_MX',
    categoria: row.categoria,
    status: row.status,
    subject: row.subject,
    bodyPreview: row.body_preview,
    variables: vars,
    shared: Boolean(row.shared),
  };
}

/**
 * Consulta de datos (fail-closed) para determinar si un contacto tiene cobranza activa con el tenant.
 * No importa lógica de cobranza; ejecuta un conteo SQL en las tablas de clientes y casos.
 */
export async function tieneCobranzaActiva(
  env: Env,
  tenantId: string,
  telefono: string
): Promise<boolean> {
  try {
    // 1. Buscar si el cliente existe para ese tenant
    const row = await env.DB.prepare(
      `SELECT c.id FROM clients cl
       JOIN cases c ON c.client_id = cl.id AND c.tenant_id = cl.tenant_id
       WHERE cl.tenant_id = ? AND cl.phone = ? AND c.status IN ('ready', 'sending', 'sent', 'replied')
       LIMIT 1`
    )
      .bind(tenantId, telefono)
      .first<{ id: string }>();

    return Boolean(row);
  } catch {
    // Si la tabla no existe o falla la consulta, ser conservador (fail-closed ante duda)
    return false;
  }
}

/**
 * Actualiza el estado de entrega o lectura en comm_envios a partir del webhook de estado del proveedor.
 */
export async function actualizarEstadoEnvio(
  env: Env,
  providerId: string,
  status: string
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE comm_envios
       SET status = ?, updated_at = datetime('now')
       WHERE provider_id = ?`
    )
      .bind(status, providerId)
      .run();
  } catch {
    // Si la tabla aún no existe o el providerId no corresponde a comm_envios, ignorar
  }
}

const PALABRAS_OPT_OUT = new Set([
  'baja',
  'stop',
  'alto',
  'cancelar',
  'no mas',
  'no más',
  'desuscribir',
  'no deseo recibir',
  'quitar',
]);

/**
 * Verifica si el texto entrante coincide con una solicitud expresa de baja (Opt-out).
 */
export function esPalabraOptOut(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const limpio = texto
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]/g, '');
  return PALABRAS_OPT_OUT.has(limpio);
}

/**
 * Procesa un mensaje entrante de desuscripción (BAJA, STOP) para marketing.
 * Si encuentra coincidencia, aplica la supresión de inmediato y devuelve true.
 */
export async function procesarInboundOptOut(
  env: Env,
  contacto: string,
  texto: string,
  defaultTenantId?: string
): Promise<{ handled: boolean; tenantsAfectados?: string[] }> {
  if (!esPalabraOptOut(texto)) {
    return { handled: false };
  }

  // Buscar el último envío comercial recibido por este contacto para atribuir la marca
  const ultimoEnvio = await env.DB.prepare(
    `SELECT tenant_id, org_tenant_id FROM comm_envios
     WHERE contacto = ?
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(contacto)
    .first<{ tenant_id: string; org_tenant_id: string }>();

  const tid = ultimoEnvio?.tenant_id ?? defaultTenantId ?? 'canaco_merida';
  const oid = ultimoEnvio?.org_tenant_id ?? tid;

  // Consultar política de alcance del tenant
  const tenantRow = await env.DB.prepare(
    'SELECT comm_optout_scope FROM tenants WHERE id = ? LIMIT 1'
  )
    .bind(tid)
    .first<{ comm_optout_scope: string | null }>();

  const scope = tenantRow?.comm_optout_scope === 'organizacion' ? 'organizacion' : 'marca';

  const afectados = await registrarOptOut(env, {
    contacto,
    tenantId: tid,
    orgId: oid,
    scope,
    reason: 'opt_out',
    detail: `solicitud_inbound_${texto.trim().toUpperCase()}`,
  });

  return { handled: true, tenantsAfectados: afectados };
}
