/**
 * Puente con Clerk: la identidad humana de la petición.
 *
 * Clerk es el proveedor de autenticación: la sesión llega como cookie (o como
 * JWT) y de ella salen el `userId`, la `sessionId` y la Organization activa.
 * El *rol* dentro del tenant no lo da Clerk: lo concede D1 (`tenant_users`).
 * Un usuario puede estar en la Organization y no tener rol → no hay principal.
 *
 * Por qué degrada a `null` y no lanza: si el Worker no tiene clave de Clerk
 * configurada, o la sesión no es válida, lo que hay que responder es 401, no
 * un 500. La ausencia de identidad es un dato, no un fallo.
 */

import { createClerkClient, type ClerkClient } from '@clerk/backend';
import { logger } from '../lib/logger';
import { getPlatformUser, getTenantByClerkOrgId, getTenantUser } from '../tenancy/repository';
import type { Env } from '../types/env';
import { platformPrincipal, tenantPrincipal, type Principal } from './principal';

/** Identidad que se puede extraer de una sesión de Clerk. */
export interface SesionClerk {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
}

/** Cliente de Clerk cacheado por clave: recrearlo en cada petición es caro. */
let clienteCache: { clave: string; cliente: ClerkClient } | null = null;

/** ¿Hay Clerk configurado en este entorno? */
export function clerkActivo(env: Env): boolean {
  return Boolean(env.CLERK_SECRET_KEY);
}

/**
 * Verificación de la sesión.
 *
 * Se expone como objeto para que las pruebas puedan sustituirla sin tocar el
 * resto del código (`sessionVerifier.fn = ...`).
 */
export const sessionVerifier: {
  fn: (env: Env, request: Request) => Promise<SesionClerk | null>;
} = {
  fn: verificarSesionConClerk,
};

/**
 * Verifica la sesión de Clerk de la petición.
 *
 * `null` si no hay sesión (no hay cookie, o la sesión no es válida).
 */
export async function verificarSesion(env: Env, request: Request): Promise<SesionClerk | null> {
  if (!clerkActivo(env)) return null;
  return sessionVerifier.fn(env, request);
}

/**
 * Principal de una sesión de Clerk.
 *
 * · Administrador de plataforma (`platform_users`): alcance transversal, su
 *   `tenantId` es `null`.
 * · Usuario de un tenant: su Organization mapeada a un tenant y con fila en
 *   `tenant_users`. El rol es el de D1, no el `orgRole` de Clerk.
 * · Cualquier otro caso: `null` (401). No hay un "usuario sin tenant" que
 *   pueda operar: sin tenant no hay a qué cliente se responde.
 */
export async function principalDeSesion(env: Env, sesion: SesionClerk): Promise<Principal | null> {
  const userId = sesion.userId;
  if (!userId) return null;

  if (await getPlatformUser(env, userId)) {
    return platformPrincipal(userId);
  }

  if (!sesion.orgId) return null;

  const tenant = await getTenantByClerkOrgId(env, sesion.orgId);
  if (!tenant) return null;

  const usuario = await getTenantUser(env, userId, tenant.id);
  if (!usuario) return null;

  return tenantPrincipal('user', userId, tenant.id, usuario.role);
}

/** Verificación cruda contra el backend de Clerk. */
async function verificarSesionConClerk(env: Env, request: Request): Promise<SesionClerk | null> {
  const cliente = clienteDeClerk(env);
  if (!cliente) return null;

  try {
    const estado = await cliente.authenticateRequest(request, opcionesDeVerificacion(env));
    if (!estado.isSignedIn) return null;

    const auth = estado.toAuth();
    if (!auth.isAuthenticated) return null;

    return {
      userId: auth.userId ?? null,
      sessionId: auth.sessionId ?? null,
      orgId: auth.orgId ?? null,
      orgRole: auth.orgRole ?? null,
    };
  } catch (error) {
    logger.warn('No se pudo verificar la sesión de Clerk', {
      motivo: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Cliente de Clerk para este entorno (cacheado por clave). */
function clienteDeClerk(env: Env): ClerkClient | null {
  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) return null;

  if (clienteCache?.clave === secretKey) return clienteCache.cliente;

  const cliente = createClerkClient({
    secretKey,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    jwtKey: env.CLERK_JWT_KEY,
  });
  clienteCache = { clave: secretKey, cliente };
  return cliente;
}

/**
 * Opciones de verificación.
 *
 * Con `CLERK_JWT_KEY` la verificación es local (sin red); `authorizedParties`
 * acota los orígenes autorizados de la sesión (claim `azp`).
 */
function opcionesDeVerificacion(env: Env): {
  jwtKey?: string;
  authorizedParties?: string[];
} {
  const opciones: { jwtKey?: string; authorizedParties?: string[] } = {};

  if (env.CLERK_JWT_KEY) opciones.jwtKey = env.CLERK_JWT_KEY;

  const partes = (env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => parte !== '');
  if (partes.length > 0) opciones.authorizedParties = partes;

  return opciones;
}
