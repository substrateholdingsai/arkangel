/**
 * Guardas de autorizaci�n: qui�n es el actor de la petici�n y qu� puede hacer.
 *
 * 
esolverPrincipal es la �nica puerta de entrada al backend: decide qui�n
 * es el principal (una sesi�n de Clerk o un token de m�quina) y con qu�
 * alcance. A partir de ah� todo el c�digo consume el Principal que sale de
 * aqu�; nadie vuelve a leer cabeceras de autenticaci�n.
 *
 * Por qu� el orden es sesi�n ? token: la sesi�n de Clerk es la identidad real
 * del humano y manda sobre cualquier otra credencial de la petici�n. Y si hay
 * sesi�n pero el usuario no tiene acceso a ning�n tenant, la respuesta es 401:
 * reinterpretar la petici�n como una llamada de m�quina convertir�a "no
 * autorizado" en "autorizado como otro actor".
 */

import { safeCompare } from '../lib/crypto';
import { logger } from '../lib/logger';
import { extractToken } from '../routes/auth';
import { tenantRefDesdeRequest, type ReferenciaTenant } from '../tenancy/referencia';
import {
  esErrorDeTablaFaltante,
  getTenantByClerkOrgId,
  getTenantBySlug,
} from '../tenancy/repository';
import type { Env } from '../types/env';
import { clerkActivo, principalDeSesion, verificarSesion, type SesionClerk } from './clerk';
import { canActOnTenant, hasScope, platformPrincipal, type Principal } from './principal';
import { scopesForRole, type Role, type Scope } from './scopes';

/** De d�nde sali� el principal de la petici�n. */
export type OrigenPrincipal = 'session' | 'token';

export interface PrincipalResuelto {
  principal: Principal;
  origen: OrigenPrincipal;
  /** Tenant al que queda acotado el principal, si lo tiene. */
  tenantId: string | null;
}

/** Motivo por el que una petici�n no llega a tener principal. */
export type MotivoSinAcceso = 'unauthorized' | 'org_sin_tenant' | 'sin_acceso';

export interface PrincipalResueltoDetallado {
  principal: Principal | null;
  origen?: OrigenPrincipal;
  tenantId?: string | null;
  motivo?: MotivoSinAcceso;
}

/**
 * Resuelve el principal de la petici�n: primero la sesi�n de Clerk,
 * despu�s los tokens de m�quina. null si no hay ninguna credencial v�lida.
 *
 * Wrapper fino para mantener compatibilidad con el resto del c�digo
 * (notablemente tenancy/context.ts). Usa 
esolverPrincipalDetallado para
 * evitar verificaciones dobles de Clerk.
 */
export async function resolverPrincipal(
  env: Env,
  request: Request
): Promise<PrincipalResuelto | null> {
  const detallado = await resolverPrincipalDetallado(env, request);
  if (!detallado.principal) return null;
  return {
    principal: detallado.principal,
    origen: detallado.origen as OrigenPrincipal,
    tenantId: detallado.tenantId ?? null,
  };
}

/**
 * Variante detallada que evita verificaciones dobles de Clerk: devuelve
 * el motivo cuando no hay principal (especialmente para sesiones v�lidas
 * sin acceso).
 */
export async function resolverPrincipalDetallado(
  env: Env,
  request: Request
): Promise<PrincipalResueltoDetallado> {
  if (clerkActivo(env)) {
    const sesion = await verificarSesion(env, request);
    if (sesion) {
      const principal = await principalDeSesion(env, sesion);
      if (!principal) {
        const motivo = await motivoDeSesionSinAcceso(env, sesion);
        logger.warn('Sesi�n de Clerk sin acceso: la petici�n se rechaza', {
          userId: sesion.userId,
          orgId: sesion.orgId,
          motivo,
        });
        return { principal: null, origen: 'session', motivo };
      }
      return { principal, origen: 'session', tenantId: principal.tenantId };
    }
    // No hay sesi�n v�lida de Clerk; seguir probando tokens de m�quina
  }

  const principalToken = await principalDeTokenDeMaquina(env, request);
  if (principalToken) {
    return {
      principal: principalToken.principal,
      origen: principalToken.origen,
      tenantId: principalToken.tenantId,
    };
  }
  return { principal: null, motivo: 'unauthorized' };
}

/**
 * 403 si al principal le falta el scope. null si lo tiene.
 */
export function exigeScope(principal: Principal, scope: Scope): Response | null {
  if (hasScope(principal, scope)) return null;
  return respuestaJson({ error: 'forbidden', scope }, 403);
}

/**
 * 403 si el principal no puede operar sobre ese tenant. null si puede.
 *
 * La plataforma es transversal. Los dem�s s�lo operan sobre su propio tenant:
 * un token de servicio que todav�a no est� acotado (	enantId = null) NO es
 * plataforma, as� que se rechaza hasta que el contexto lo acota. Por eso la
 * comprobaci�n mira el kind y no s�lo el 	enantId.
 */
export function exigeTenant(principal: Principal, tenantId: string): Response | null {
  const permitido =
    principal.kind === 'platform' ||
    (principal.tenantId !== null && canActOnTenant(principal, tenantId));
  if (permitido) return null;
  return respuestaJson({ error: 'tenant_forbidden' }, 403);
}

/**
 * Principal de un token de m�quina.
 *
 * El admin de plataforma es el �nico actor con alcance transversal. Los
 * tokens de servicio (ingesta, agente) son pikey con el rol de su servicio:
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

  logger.warn('Credencial de m�quina no reconocida: la petici�n se rechaza', {
    tieneToken: true,
  });
  return null;
}

/**
 * Principal de un token de servicio.
 *
 * El tenant sale de la cabecera (X-Tenant-Id / X-Tenant-Slug); sin
 * cabecera el principal queda **sin acotar** (	enantId: null) y se acota
 * cuando se resuelve el contexto.
 *
 * El Principal se arma a mano en vez de con 	enantPrincipal() porque �se
 * exige un tenant no nulo: aqu� el token puede llegar sin acotar y aun as�
 * debe seguir siendo pikey, nunca plataforma.
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
 * principal queda sin acotar y ser� la resoluci�n del contexto la que
 * rechace la llamada (	enant_not_found).
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

/**
 * Motivo por el que una sesi�n v�lida no llega a un principal.
 *
 * org_sin_tenant: la Organization de Clerk no est� mapeada a ning�n tenant.
 * sin_acceso: el tenant existe pero el usuario no tiene rol en �l.
 */
async function motivoDeSesionSinAcceso(
  env: Env,
  sesion: SesionClerk
): Promise<'org_sin_tenant' | 'sin_acceso'> {
  if (!sesion.orgId) return 'sin_acceso';

  try {
    const tenant = await getTenantByClerkOrgId(env, sesion.orgId);
    return tenant ? 'sin_acceso' : 'org_sin_tenant';
  } catch (error) {
    logger.debug('No se pudo comprobar el tenant de la Organization de Clerk', {
      orgId: sesion.orgId,
      motivo: error instanceof Error ? error.message : String(error),
    });
    return 'sin_acceso';
  }
}

/** Respuesta JSON plana: los errores de autorizaci�n no filtran datos. */
function respuestaJson(cuerpo: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
