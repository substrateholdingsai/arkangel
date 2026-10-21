/**
 * Acceso a D1 del catálogo de tenants y sus canales.
 *
 * En esta fase (multi-tenant · Fase 2) el catálogo es de una sola tabla más sus
 * canales; las tablas de negocio todavía no llevan `tenant_id` (eso es la Fase 4,
 * donde `ctx` se propaga a todos los servicios).
 */

import { parseJson } from '../services/db';
import type { Env } from '../types/env';
import type { Role } from '../auth/scopes';
import type {
  Tenant,
  TenantChannel,
  TenantChannelCredentials,
  TenantConfigMode,
  TenantStatus,
} from './types';

const SQL_TENANT_POR_ID = 'SELECT * FROM tenants WHERE id = ? LIMIT 1';
const SQL_TENANT_POR_SLUG = 'SELECT * FROM tenants WHERE slug = ? LIMIT 1';
const SQL_TENANT_POR_DEFECTO = 'SELECT * FROM tenants WHERE is_default = 1 LIMIT 1';
const SQL_TENANT_POR_CLERK_ORG_ID = 'SELECT * FROM tenants WHERE clerk_org_id = ? LIMIT 1';
const SQL_CANALES_DEL_TENANT =
  "SELECT * FROM tenant_channels WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC";
const SQL_USUARIOS_PLATAFORMA = 'SELECT 1 FROM platform_users WHERE user_id = ? LIMIT 1';
const SQL_USUARIOS_TENANT =
  'SELECT role FROM tenant_users WHERE user_id = ? AND tenant_id = ? LIMIT 1';

interface TenantRow {
  id: string;
  slug: string;
  nombre: string;
  status: string;
  config_mode: string;
  razon_social: string;
  condusef_registro: string;
  allowed_payment_domains: string;
  tz: string;
  send_window_start: number;
  send_window_end: number;
  max_contacts_per_day: number;
  legal_monto_tolerancia_cents: number;
  legal_horario_en_respuestas: number;
  rate_limit_rpm: number;
  dedupe_window_hours: number;
  score_amount_ceiling_cents: number;
  agent_mode: string;
  agent_auto_threshold_cents: number;
  dry_run: number;
  cron_auto_fire: number;
  is_default: number;
  clerk_org_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TenantChannelRow {
  id: string;
  tenant_id: string;
  channel: string;
  provider_account_id: string | null;
  credentials: string | null;
  status: string;
  created_at: string;
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    status: row.status as TenantStatus,
    config_mode: row.config_mode as TenantConfigMode,
    razon_social: row.razon_social ?? '',
    condusef_registro: row.condusef_registro ?? '',
    allowed_payment_domains: row.allowed_payment_domains ?? '',
    tz: row.tz,
    send_window_start: Number(row.send_window_start),
    send_window_end: Number(row.send_window_end),
    max_contacts_per_day: Number(row.max_contacts_per_day),
    legal_monto_tolerancia_cents: Number(row.legal_monto_tolerancia_cents),
    legal_horario_en_respuestas: Number(row.legal_horario_en_respuestas),
    rate_limit_rpm: Number(row.rate_limit_rpm),
    dedupe_window_hours: Number(row.dedupe_window_hours),
    score_amount_ceiling_cents: Number(row.score_amount_ceiling_cents),
    agent_mode: row.agent_mode,
    agent_auto_threshold_cents: Number(row.agent_auto_threshold_cents),
    dry_run: Number(row.dry_run),
    cron_auto_fire: Number(row.cron_auto_fire),
    is_default: Number(row.is_default),
    clerk_org_id: row.clerk_org_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapChannel(row: TenantChannelRow): TenantChannel {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    channel: row.channel as TenantChannel['channel'],
    provider_account_id: row.provider_account_id,
    credentials: parseJson<TenantChannelCredentials | null>(row.credentials, null),
    status: row.status === 'inactive' ? 'inactive' : 'active',
    created_at: row.created_at,
  };
}

/**
 * ¿El error es "la tabla X no existe"?
 *
 * Acotado a las tablas concretas: un fallo real de D1 (permisos, esquema
 * corrupto, otra tabla ausente) no debe convertirse en un modo degradado
 * silencioso con la configuración de la plataforma.
 */
export function esErrorDeTablaFaltante(error: unknown, tablas: string[]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return tablas.some((tabla) => new RegExp(`no such table:\\s*${tabla}\\b`, 'i').test(message));
}

export async function getTenantById(env: Env, tenantId: string): Promise<Tenant | null> {
  const row = await env.DB.prepare(SQL_TENANT_POR_ID).bind(tenantId).first<TenantRow>();
  return row ? mapTenant(row) : null;
}

export async function getTenantBySlug(env: Env, slug: string): Promise<Tenant | null> {
  const row = await env.DB.prepare(SQL_TENANT_POR_SLUG).bind(slug).first<TenantRow>();
  return row ? mapTenant(row) : null;
}

export async function getDefaultTenant(env: Env): Promise<Tenant | null> {
  const row = await env.DB.prepare(SQL_TENANT_POR_DEFECTO).first<TenantRow>();
  return row ? mapTenant(row) : null;
}

export async function listTenantChannels(env: Env, tenantId: string): Promise<TenantChannel[]> {
  const result = await env.DB.prepare(SQL_CANALES_DEL_TENANT)
    .bind(tenantId)
    .all<TenantChannelRow>();
  return (result.results ?? []).map(mapChannel);
}

/**
 * Resuelve el tenant de un webhook entrante por su identificador de enrutado
 * (`phone_number_id` de Meta, `messaging_profile_id` de Telnyx, dominio receptor
 * de Resend). Es la pieza que permite que un mismo teléfono deudor sea de dos
 * empresas sin confusion.
 *
 * Si la tabla `tenant_channels` todavía no existe (migración 0004 sin aplicar)
 * no hay enrutado por tenant y se devuelve `null`: el mensaje se atribuye al
 * tenant por defecto, que es el comportamiento pre-multi-tenant.
 */
export async function getTenantByProviderAccountId(
  env: Env,
  channel: TenantChannel['channel'],
  providerAccountId: string
): Promise<Tenant | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT t.* FROM tenants t
       JOIN tenant_channels c ON c.tenant_id = t.id
       WHERE c.channel = ? AND c.provider_account_id = ? AND c.status = 'active'
       LIMIT 1`
    )
      .bind(channel, providerAccountId)
      .first<TenantRow>();
    return row ? mapTenant(row) : null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_channels'])) return null;
    throw error;
  }
}

/**
 * Lista todos los tenants activos (para el cron contable multi-tenant).
 */
export async function listTenants(env: Env): Promise<Tenant[]> {
  const result = await env.DB.prepare('SELECT * FROM tenants WHERE status = ? ORDER BY created_at ASC')
    .bind('active')
    .all<TenantRow>();
  return (result.results ?? []).map(mapTenant);
}

/**
 * ¿Es el usuario un administrador de plataforma?
 *
 * Los admins de plataforma tienen alcance transversal: pueden actuar sobre
 * cualquier tenant sin necesidad de ser miembro de su Organization. Su rol en
 * el Principal es `platform_admin` y su `tenantId` es null.
 *
 * Si la tabla `platform_users` todavía no existe (migración 0005 sin aplicar)
 * devolvemos `false`: nadie es admin de plataforma hasta que el esquema lo
 * permita. No es un error, es el estado pre-migración.
 */
export async function getPlatformUser(env: Env, userId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(SQL_USUARIOS_PLATAFORMA).bind(userId).first<unknown>();
    return row != null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['platform_users'])) return false;
    throw error;
  }
}

/**
 * Resuelve el tenant por su Organization ID de Clerk.
 *
 * Es el puente entre la identidad de Clerk (orgId) y el catálogo de tenants
 * de Arkangel. Sin coincidencia no hay tenant para esa Organization: la
 * petición cae a `null` y el flujo de auth la trata como "sin rol".
 */
export async function getTenantByClerkOrgId(env: Env, orgId: string): Promise<Tenant | null> {
  try {
    const row = await env.DB.prepare(SQL_TENANT_POR_CLERK_ORG_ID).bind(orgId).first<TenantRow>();
    return row ? mapTenant(row) : null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenants'])) return null;
    throw error;
  }
}

/**
 * Rol del usuario dentro del tenant, concedido por D1.
 *
 * Estar en la Organization de Clerk NO basta: el rol lo concede esta tabla.
 * Si la fila no existe, el usuario no tiene rol en ese tenant → `null`.
 *
 * Si la tabla `tenant_users` todavía no existe (migración 0005 sin aplicar)
 * devolvemos `null`: un tenant sin tabla de roles no puede tener roles.
 */
export async function getTenantUser(
  env: Env,
  userId: string,
  tenantId: string
): Promise<{ role: Role } | null> {
  try {
    const row = await env.DB.prepare(SQL_USUARIOS_TENANT)
      .bind(userId, tenantId)
      .first<{ role: string }>();
    if (!row) return null;
    return { role: row.role as Role };
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_users'])) return null;
    throw error;
  }
}
