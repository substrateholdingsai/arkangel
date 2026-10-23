/**
 * Construcción del contexto de tenant.
 *
 * `TenantContext` es lo que se pasa explícitamente a las funciones que
 * necesitan saber *de quién* es el trabajo. Al ir en la firma (y no por `env`),
 * el compilador obliga a propagarlo: es el sustituto de las RLS que D1 no tiene.
 *
 * El tenant ya no se deduce de una cabecera confiada: se deduce del
 * **principal** (la sesión nativa y sus membresías). La cabecera `X-Tenant-Id`
 * sólo acota y nunca amplía: si apunta a un tenant distinto del del
 * principal, la petición se rechaza con `tenant_mismatch` (fail-closed).
 */

import { resolverPrincipal, type OrigenPrincipal } from '../auth/guards';
import { getCookie, SESSION_COOKIE } from '../auth/native';
import { platformPrincipal, type Principal } from '../auth/principal';
import type { InboundMessage } from '../channels/types';
import { logger } from '../lib/logger';
import { extractToken } from '../routes/auth';
import { logEventForTenant } from '../services/eventos';
import type { Env } from '../types/env';
import {
  configDesdeEntorno,
  resolveTenantConfig,
  tenantListoParaOperar,
  TENANT_POR_DEFECTO_ID,
} from './config';
import { tenantRefDesdeRequest, type ReferenciaTenant } from './referencia';
import {
  esErrorDeTablaFaltante,
  getDefaultTenant,
  getTenantById,
  getTenantByProviderAccountId,
  getTenantBySlug,
  listTenantChannels,
} from './repository';
import type { Tenant, TenantContext } from './types';

/**
 * Referencia al tenant al que se refiere la llamada.
 *
 * Va en la cabecera y no en el cuerpo: la cabecera la pone la plataforma (el
 * CRM, el panel), que es quien sabe de qué cliente es el tráfico. Sin cabecera
 * se usa el tenant por defecto de la plataforma.
 *
 * **La cabecera está acotada por el principal.** El tenant se deduce de la
 * identidad del usuario y de sus membresías; la cabecera ya no amplía el
 * alcance, sólo puede confirmar el tenant del principal. Si apunta a otro
 * tenant, la petición se rechaza con `tenant_mismatch` (403): un
 * `X-Tenant-Id` confiado desde el navegador es suplantación. Para la
 * plataforma (admin) y para los servicios la cabecera sí decide el tenant, y
 * en el caso de la plataforma queda auditado como impersonación.
 */
export { tenantRefDesdeRequest } from './referencia';

export class TenantNoEncontradoError extends Error {
  constructor(referencia: string) {
    super(`Tenant no encontrado: ${referencia}`);
    this.name = 'TenantNoEncontradoError';
  }
}

export class TenantSuspendidoError extends Error {
  constructor(tenantId: string) {
    super(`Tenant suspendido: ${tenantId}`);
    this.name = 'TenantSuspendidoError';
  }
}

/**
 * El principal no puede operar en el tenant que pide la petición.
 *
 * Es el 403 de `tenant_mismatch`: la cabecera de tenant apunta a un tenant
 * ajeno al del principal y se rechaza en lugar de operar con los datos de otro
 * cliente. El error vive aquí (y no en la ruta) para que la capa de tenancy
 * no dependa de las rutas.
 */
export class TenantMismatchError extends Error {
  constructor(
    /** Tenant del principal. `null` si el principal no tiene tenant. */
    readonly tenantDelPrincipal: string | null,
    /** Tenant que pedía la cabecera. `null` si no se pudo resolver. */
    readonly tenantSolicitado: string | null
  ) {
    super(
      `El principal no puede operar en el tenant solicitado: ${tenantSolicitado ?? 'desconocido'}`
    );
    this.name = 'TenantMismatchError';
  }
}

export interface ResolverTenantOptions {
  tenantId?: string;
  tenantSlug?: string;
  principal?: Principal;
}

/**
 * Tenant de respaldo: el que se construye con el entorno del Worker.
 *
 * Sólo se usa cuando la tabla `tenants` no existe todavía (migración 0004 sin
 * aplicar). En ese estado no puede haber más de un tenant, así que no hay riesgo
 * de que un tenant herede la identidad de otro: es el estado pre-multi-tenant.
 *
 * El id es el mismo que crea la migración 0004 a propósito: si el id cambiara,
 * las claves de KV (`t:{tenantId}:...`) quedarían huérfanas al aplicar la
 * migración y se perderían las ventanas de dedupe ya reservadas.
 */
export function tenantDeEntorno(env: Env): Tenant {
  const config = configDesdeEntorno(env);
  return {
    id: TENANT_POR_DEFECTO_ID,
    slug: 'arkangel',
    nombre: 'Configuración del entorno',
    status: 'active',
    config_mode: 'platform_env',
    razon_social: config.razonSocial,
    condusef_registro: config.condusef,
    allowed_payment_domains: config.dominiosPermitidos.join(','),
    tz: config.tz,
    send_window_start: config.horaInicio,
    send_window_end: config.horaFin,
    max_contacts_per_day: config.maxContactos24h,
    legal_monto_tolerancia_cents: config.montoToleranciaCents,
    legal_horario_en_respuestas: config.horarioEnRespuestas ? 1 : 0,
    rate_limit_rpm: config.rateLimitRpm,
    dedupe_window_hours: config.dedupeWindowHours,
    score_amount_ceiling_cents: config.scoreAmountCeilingCents,
    agent_mode: config.agentMode,
    agent_auto_threshold_cents: config.agentAutoThresholdCents,
    dry_run: config.dryRun ? 1 : 0,
    cron_auto_fire: config.cronAutoFire ? 1 : 0,
    is_default: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function cargarTenant(env: Env, options: ResolverTenantOptions): Promise<Tenant> {
  const explicito = Boolean(options.tenantId || options.tenantSlug);

  try {
    let tenant: Tenant | null = null;

    if (options.tenantId) {
      tenant = await getTenantById(env, options.tenantId);
    } else if (options.tenantSlug) {
      tenant = await getTenantBySlug(env, options.tenantSlug);
    } else {
      tenant = await getDefaultTenant(env);
    }

    if (!tenant) {
      if (options.tenantId) throw new TenantNoEncontradoError(options.tenantId);
      if (options.tenantSlug) throw new TenantNoEncontradoError(options.tenantSlug);
      throw new TenantNoEncontradoError('default (no hay ningún tenant con is_default = 1)');
    }
    if (tenant.status === 'suspended') {
      throw new TenantSuspendidoError(tenant.id);
    }
    return tenant;
  } catch (error) {
    if (error instanceof TenantNoEncontradoError || error instanceof TenantSuspendidoError) {
      throw error;
    }
    if (esErrorDeTablaFaltante(error, ['tenants'])) {
      if (explicito) {
        throw new TenantNoEncontradoError(options.tenantId ?? options.tenantSlug ?? 'default');
      }
      logger.warn('Tabla `tenants` ausente: se opera con la configuración del entorno', {
        motivo: error instanceof Error ? error.message : String(error),
      });
      return tenantDeEntorno(env);
    }
    throw error;
  }
}

async function cargarCanales(env: Env, tenantId: string) {
  try {
    return await listTenantChannels(env, tenantId);
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_channels'])) {
      return [];
    }
    throw error;
  }
}

/**
 * Resuelve el contexto del tenant con el que se va a trabajar.
 *
 * Sin `tenantId` ni `tenantSlug` se usa el tenant por defecto de la plataforma
 * (el que existía antes del multi-tenant). Con `tenantId`, el tenant tiene que
 * existir y estar activo: no hay herencia silenciosa.
 *
 * El tenant final depende de **quién** es el principal:
 *   · Usuario de sesión → el tenant de su membresía activa. La cabecera sólo
 *     puede confirmar ese tenant; si apunta a otro, `TenantMismatchError`.
 *   · Plataforma (admin) → el de la cabecera si viene; si no, el por defecto.
 *   · Servicio (API key) → el de la cabecera si viene; si no, el por defecto.
 */
export async function resolveTenantContext(
  env: Env,
  options: ResolverTenantOptions = {}
): Promise<TenantContext> {
  const principal = options.principal ?? platformPrincipal();
  const ref: ReferenciaTenant = { tenantId: options.tenantId, tenantSlug: options.tenantSlug };

  const tenant = await tenantDelPrincipal(env, principal, ref);
  const channels = await cargarCanales(env, tenant.id);
  const config = resolveTenantConfig(env, tenant);

  if (!tenantListoParaOperar(config)) {
    logger.warn('El tenant no tiene razón social efectiva: el motor legal bloqueará sus mensajes', {
      tenantId: tenant.id,
      configMode: tenant.config_mode,
    });
  }

  return {
    env,
    tenantId: tenant.id,
    tenant,
    config,
    channels,
    principal: acotarPrincipal(principal, tenant),
  };
}

/**
 * Contexto del tenant que pide la llamada, deducido del principal.
 *
 * Si el llamador ya resolvió el principal, se usa el que pasa (`opts.principal`);
 * si no, se resuelve aquí con `resolverPrincipal` (sesión nativa primero,
 * tokens de máquina después).
 */
export async function resolveTenantContextDeRequest(
  env: Env,
  request: Request,
  opts: { principal?: Principal; origen?: OrigenPrincipal } = {}
): Promise<TenantContext> {
  const ref = tenantRefDesdeRequest(request);

  const resuelto = opts.principal
    ? { principal: opts.principal, origen: opts.origen ?? origenInferido(request) }
    : await resolverPrincipal(env, request);

  const principal = resuelto?.principal ?? platformPrincipal();
  const ctx = await resolveTenantContext(env, { ...ref, principal });

  // Una plataforma que opera sobre un tenant concreto es una impersonación:
  // se registra para poder reconstruir quién tocó los datos de qué cliente.
  if (resuelto && principal.kind === 'platform' && (ref.tenantId || ref.tenantSlug)) {
    await auditarImpersonacion(env, principal, ctx.tenantId, resuelto.origen);
  }

  return ctx;
}

/**
 * Tenant con el que se opera, según quién sea el principal.
 */
async function tenantDelPrincipal(
  env: Env,
  principal: Principal,
  ref: ReferenciaTenant
): Promise<Tenant> {
  // Usuario de sesión: su tenant es el de su membresía activa. La cabecera
  // puede confirmar ese tenant, nunca sustituirlo.
  if (principal.kind === 'user') {
    if (!principal.tenantId) {
      throw new TenantMismatchError(null, ref.tenantId ?? ref.tenantSlug ?? null);
    }

    if (!ref.tenantId && !ref.tenantSlug) {
      return cargarTenant(env, { tenantId: principal.tenantId });
    }

    const solicitado = await tenantDeCabecera(env, ref);
    if (!solicitado || solicitado.id !== principal.tenantId) {
      throw new TenantMismatchError(principal.tenantId, solicitado?.id ?? null);
    }
    if (solicitado.status === 'suspended') {
      throw new TenantSuspendidoError(solicitado.id);
    }
    return solicitado;
  }

  // Plataforma y servicios: la cabecera acota el trabajo; sin cabecera, el
  // tenant por defecto de la plataforma.
  return cargarTenant(env, ref);
}

/**
 * Tenant al que apunta la cabecera, sin validar su estado.
 *
 * Para comparar sólo importa el id: un tenant que no existe, o que está
 * suspendido, no puede ser el tenant del principal.
 */
async function tenantDeCabecera(env: Env, ref: ReferenciaTenant): Promise<Tenant | null> {
  try {
    if (ref.tenantId) return await getTenantById(env, ref.tenantId);
    if (ref.tenantSlug) return await getTenantBySlug(env, ref.tenantSlug);
    return null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenants'])) return null;
    throw error;
  }
}

/**
 * Acota el principal al tenant con el que se va a trabajar.
 *
 * Un token de servicio llega sin tenant (la cabecera puede no estar); al
 * resolver el contexto se le asigna el tenant efectivo, de modo que a partir
 * de aquí no puede operar en otro. La plataforma conserva `tenantId = null`:
 * su alcance es transversal por diseño (y queda auditado).
 */
function acotarPrincipal(principal: Principal, tenant: Tenant): Principal {
  if (principal.kind !== 'apikey') return principal;
  if (principal.tenantId === tenant.id) return principal;
  return { ...principal, tenantId: tenant.id };
}

/**
 * Origen del principal cuando el llamador no lo dice.
 *
 * Si la petición trae la cookie de sesión, el principal viene de la sesión;
 * si trae un token de máquina, del token.
 */
function origenInferido(request: Request): OrigenPrincipal {
  if (getCookie(request, SESSION_COOKIE)) return 'session';
  return extractToken(request) ? 'token' : 'session';
}

/**
 * Registro de impersonación: un principal de plataforma que opera sobre un
 * tenant concreto. Queda como evento para poder reconstruir quién tocó los
 * datos de qué cliente.
 */
async function auditarImpersonacion(
  env: Env,
  principal: Principal,
  tenantId: string,
  origen: OrigenPrincipal
): Promise<void> {
  try {
    await logEventForTenant(env, tenantId, 'auth.impersonacion', {
      payload: {
        actorId: principal.actorId,
        tenantSolicitado: tenantId,
        origen,
      },
    });
  } catch (error) {
    // Auditar no puede tumbar la petición, pero el fallo sí debe verse.
    logger.warn('No se pudo auditar la impersonación', {
      actorId: principal.actorId,
      tenantId,
      motivo: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Identificador de enrutado del proveedor, por canal.
 *
 * Es el dato que dice "este mensaje entró por la cuenta de este cliente":
 * el `phone_number_id` de Meta, el `messaging_profile_id` de Telnyx o el
 * dominio receptor de Resend.
 */
export function routingIdDeInbound(message: InboundMessage): string | null {
  if (message.channel === 'whatsapp') {
    const id =
      (typeof message.meta?.phone_number_id === 'string' && message.meta.phone_number_id.trim()) ||
      (typeof message.to === 'string' && message.to.trim()) ||
      (typeof message.meta?.messaging_profile_id === 'string' &&
        message.meta.messaging_profile_id.trim()) ||
      null;
    return id;
  }
  if (message.channel === 'sms') {
    const id = message.meta?.messaging_profile_id;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  }
  if (message.channel === 'email') {
    const destinatario = message.to?.trim().toLowerCase();
    if (!destinatario) return null;
    const dominio = destinatario.split('@')[1];
    return dominio ?? null;
  }
  return null;
}

/**
 * Tenant al que pertenece un mensaje entrante.
 *
 * Se deduce del identificador de enrutado del proveedor, nunca de un dato que
 * mande el cliente: el deudor no puede decidir de qué empresa es su mensaje.
 * Si el enrutado no está configurado se devuelve `undefined` y el mensaje se
 * atribuye al tenant por defecto de la plataforma.
 */
export async function resolveTenantIdForInbound(
  env: Env,
  message: InboundMessage
): Promise<string | undefined> {
  const routingId = routingIdDeInbound(message);
  if (!routingId) return undefined;

  const tenant = await getTenantByProviderAccountId(env, message.channel, routingId);
  if (tenant) {
    logger.info('Inbound atribuido a tenant por enrutado', {
      channel: message.channel,
      tenantId: tenant.id,
    });
    return tenant.id;
  }

  logger.warn('Inbound sin enrutado de tenant conocido: se atribuye al tenant por defecto', {
    channel: message.channel,
  });
  return undefined;
}
