/**
 * Guardias de autorización: quién es el actor de la petición y qué puede hacer.
 *
 * `resolverPrincipal` es la única puerta de entrada al backend: decide quién
 * es el principal (una sesión nativa o un token de máquina) y con qué
 * alcance. A partir de ahí todo el código consume el Principal que sale de
 * aquí; nadie vuelve a leer cabeceras de autenticación.
 *
 * Por qué el orden es sesión → token: la sesión es la identidad real del
 * humano y manda sobre cualquier otra credencial de la petición. Y si hay
 * sesión pero el usuario no tiene acceso, la respuesta es 401: reinterpretar
 * la petición como una llamada de máquina convertiría "no autorizado" en
 * "autorizado como otro actor".
 */

import { safeCompare } from '../lib/crypto';
import { logger } from '../lib/logger';
import { extractToken } from '../routes/auth';
import { tenantRefDesdeRequest, type ReferenciaTenant } from '../tenancy/referencia';
import { esErrorDeTablaFaltante, getTenantBySlug } from '../tenancy/repository';
import type { Env } from '../types/env';
import { ROLE_POR_MEMBRESIA, validateSession, type Membership, type NativeSession } from './native';
import {
  canActOnTenant,
  hasScope,
  platformPrincipal,
  tenantPrincipal,
  type Principal,
} from './principal';
import { scopesForRole, type Role, type Scope } from './scopes';

/** De dónde salió el principal de la petición. */
export type OrigenPrincipal = 'session' | 'token';

export interface PrincipalResuelto {
  principal: Principal;
  origen: OrigenPrincipal;
  /** Tenant al que queda acotado el principal, si lo tiene. */
  tenantId: string | null;
}

/**
 * Motivo por el que una petición no llega a tener principal.
 *
 * · `unauthorized`      → no hay ninguna credencial válida.
 * · `sin_membresia`     → la sesión es válida pero el usuario no pertenece a
 *                         ningún despacho: no hay contra qué operar.
 * · `tenant_forbidden`  → el usuario pidió un despacho del que no es miembro.
 */
export type MotivoSinAcceso = 'unauthorized' | 'sin_membresia' | 'tenant_forbidden';

export interface PrincipalResueltoDetallado {
  principal: Principal | null;
  origen?: OrigenPrincipal;
  tenantId?: string | null;
  motivo?: MotivoSinAcceso;
  /** Código HTTP con el que se responde (401 o 403). */
  status?: 401 | 403;
}

/**
 * Resuelve el principal de la petición: primero la sesión nativa, después
 * los tokens de máquina. `null` si no hay ninguna credencial válida.
 *
 * Wrapper fino para mantener compatibilidad con el resto del código
 * (notablemente tenancy/context.ts). Usa `resolverPrincipalDetallado` para
 * evitar verificaciones dobles contra D1.
 */
export async function resolverPrincipal(
  env: Env,
  request: Request,
  sesion?: NativeSession | null
): Promise<PrincipalResuelto | null> {
  const detallado = await resolverPrincipalDetallado(env, request, sesion);
  if (!detallado.principal) return null;
  return {
    principal: detallado.principal,
    origen: detallado.origen as OrigenPrincipal,
    tenantId: detallado.tenantId ?? null,
  };
}

/**
 * Variante detallada que evita verificaciones dobles: devuelve el motivo
 * cuando no hay principal (y si la respuesta es 401 o 403).
 *
 * `sesion` es la sesión ya resuelta por el middleware. `undefined` significa
 * "resuélvela tú" (la cookie no se ha mirado todavía); `null` significa
 * "ya se resolvió y no hay sesión".
 */
export async function resolverPrincipalDetallado(
  env: Env,
  request: Request,
  sesion?: NativeSession | null
): Promise<PrincipalResueltoDetallado> {
  const resuelta = sesion === undefined ? await validateSession(env, request) : sesion;
  if (resuelta) {
    return principalDeSesion(request, resuelta);
  }
  // No hay sesión válida; seguir probando tokens de máquina
  const principalToken = await principalDeTokenDeMaquina(env, request);
  if (principalToken) {
    return {
      principal: principalToken.principal,
      origen: principalToken.origen,
      tenantId: principalToken.tenantId,
    };
  }
  return { principal: null, motivo: 'unauthorized', status: 401 };
}

/**
 * Principal de una sesión nativa.
 *
 * · Administrador de plataforma (`platform_role = 'super_admin'`): alcance
 *   transversal, su `tenantId` es `null`.
 * · Usuario de un tenant: su despachos, según la cabecera `X-Tenant-Id` o
 *   `X-Tenant-Slug` (que sólo *selecciona* entre sus membresías) y, si no
 *   viene cabecera, el primero. El rol es el de la membresía.
 * · Cualquier otro caso: `null`. Sin membresía no hay contra qué operar.
 */
function principalDeSesion(request: Request, sesion: NativeSession): PrincipalResueltoDetallado {
  const { user, memberships } = sesion;

  if (user.platformRole === 'super_admin') {
    return { principal: platformPrincipal(user.id), origen: 'session', tenantId: null };
  }

  if (memberships.length === 0) {
    logger.warn('Sesión sin membresías: la petición se rechaza', { userId: user.id });
    return {
      principal: null,
      origen: 'session',
      motivo: 'sin_membresia',
      status: 401,
    };
  }

  const ref = tenantRefDesdeRequest(request);
  const membresia = membresiaDe(ref, memberships);

  if (!membresia) {
    logger.warn('El usuario pidió un despacho del que no es miembro: se rechaza', {
      userId: user.id,
      tenantSolicitado: ref.tenantId ?? ref.tenantSlug ?? null,
    });
    return {
      principal: null,
      origen: 'session',
      motivo: 'tenant_forbidden',
      status: 403,
    };
  }

  const rol = ROLE_POR_MEMBRESIA[membresia.role] ?? 'viewer';
  return {
    principal: tenantPrincipal('user', user.id, membresia.tenantId, rol),
    origen: 'session',
    tenantId: membresia.tenantId,
  };
}

/**
 * Membresía que corresponde a la referencia de la petición.
 *
 * Sin cabecera se toma la primera: es el comportamiento de "el panel acaba de
 * abrir y aún no ha elegido despacho". Con cabecera, sólo puede ser una de
 * las membresías del usuario: `null` significa que pidió un tenant ajeno.
 */
function membresiaDe(ref: ReferenciaTenant, memberships: Membership[]): Membership | undefined {
  if (ref.tenantId) return memberships.find((m) => m.tenantId === ref.tenantId);
  if (ref.tenantSlug) return memberships.find((m) => m.tenantSlug === ref.tenantSlug);
  return memberships[0];
}

/**
 * 403 si al principal le falta el scope. `null` si lo tiene.
 */
export function exigeScope(principal: Principal, scope: Scope): Response | null {
  if (hasScope(principal, scope)) return null;
  return respuestaJson({ error: 'forbidden', scope }, 403);
}

/**
 * 403 si el principal no puede operar sobre ese tenant. `null` si puede.
 *
 * La plataforma es transversal. Los demás sólo operan sobre su propio tenant:
 * un token de servicio que todavía no está acotado (tenantId = null) NO es
 * plataforma, así que se rechaza hasta que el contexto lo acota. Por eso la
 * comprobación mira el kind y no sólo el tenantId.
 */
export function exigeTenant(principal: Principal, tenantId: string): Response | null {
  const permitido =
    principal.kind === 'platform' ||
    (principal.tenantId !== null && canActOnTenant(principal, tenantId));
  if (permitido) return null;
  return respuestaJson({ error: 'tenant_forbidden' }, 403);
}

/**
 * Principal de un token de máquina.
 *
 * El admin de plataforma es el único actor con alcance transversal. Los
 * tokens de servicio (ingesta, agente) son apikey con el rol de su servicio:
 * nunca obtienen alcance de plataforma aunque no traigan cabecera de tenant.
 */
async function principalDeTokenDeMaquina(
  env: Env,
  request: Request
): Promise<PrincipalResuelto | null> {
  const token = extractToken(request);
  if (!token) return null;

  if (safeCompare(token, env.ADMIN_TOKEN)) {
    return { principal: platformPrincipal('admin-token'), origen: 'token', tenantId: null };
  }

  const ref = tenantRefDesdeRequest(request);

  if (safeCompare(token, env.INTAKE_TOKEN)) {
    return principalDeServicio(env, ref, 'intake-token', 'service_ingest');
  }

  if (env.GROK_BOT_TOKEN && safeCompare(token, env.GROK_BOT_TOKEN)) {
    return principalDeServicio(env, ref, 'agent-token', 'service_agent');
  }

  logger.warn('Credencial de máquina no reconocida: la petición se rechaza', {
    tieneToken: true,
  });
  return null;
}

/**
 * Principal de un token de servicio.
 *
 * El tenant sale de la cabecera (X-Tenant-Id / X-Tenant-Slug); sin
 * cabecera el principal queda **sin acotar** (tenantId = null) y se acota
 * cuando se resuelve el contexto.
 *
 * El Principal se arma a mano en vez de con tenantPrincipal() porque aquí
 * se exige un tenant no nulo: aquí el token puede llegar sin acotar y aun así
 * debe seguir siendo apikey, nunca plataforma.
 */
async function principalDeServicio(
  env: Env,
  ref: ReferenciaTenant,
  actorId: string,
  role: Role
): Promise<PrincipalResuelto> {
  const tenantId = await tenantDeReferencia(env, ref);
  const principal: Principal = {
    kind: 'apikey',
    actorId,
    tenantId,
    role,
    scopes: scopesForRole(role),
  };
  return { principal, origen: 'token', tenantId };
}

/**
 * Id del tenant al que apunta la cabecera.
 *
 * El slug se resuelve contra D1 porque el principal necesita un *id* para
 * poder compararse con el tenant del contexto. Si el slug no existe, el
 * principal queda sin acotar y será la resolución del contexto la que
 * rechace la llamada (tenant_not_found).
 */
async function tenantDeReferencia(env: Env, ref: ReferenciaTenant): Promise<string | null> {
  if (ref.tenantId) return ref.tenantId;
  if (!ref.tenantSlug) return null;

  try {
    const tenant = await getTenantBySlug(env, ref.tenantSlug);
    return tenant?.id ?? null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenants'])) return null;
    throw error;
  }
}

/** Respuesta JSON plana: los errores de autorización no filtran datos. */
function respuestaJson(cuerpo: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
