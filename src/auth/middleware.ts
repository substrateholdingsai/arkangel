/**
 * Middlewares de autenticación nativa.
 *
 * Se appliqueron al grupo de rutas de negocio (`/api/v1/*`): su trabajo es
 * resolver **una vez** quién es el que llama y dejar su identidad en el
 * contexto, para que la capa de autorización no tenga que volver a preguntarle
 * a D1 lo mismo.
 *
 * Por qué `authenticateRequest` no bloquea: no todas las rutas de negocio son
 * de panel. La ingesta del CRM y la API del agente se autentican con tokens
 * de máquina, no con sesión de usuario. Bloquear aquí sin cookie dejaría sin
 * puerta a esos dos actores. Quien decide si la llamada vale es la guardia de
 * cada ruta (`exigePrincipalConScope`), que sí distingue "no hay identidad"
 * (401) de "no tiene permisos" (403).
 */

import type { Context, MiddlewareHandler } from 'hono';
import { tenantRefDesdeRequest } from '../tenancy/referencia';
import type { Env } from '../types/env';
import { validateSession, type NativeSession } from './native';

/** Variables que el middleware deja en el contexto de Hono. */
export interface AuthVars {
  /**
   * Sesión nativa resuelta.
   * `undefined` = no se ha resuelto todavía; `null` = resuelto y no hay
   * sesión; objeto = la sesión del usuario.
   */
  sesionNativa: NativeSession | null | undefined;
}

/** Contexto de Hono con los bindings del Worker y la sesión resuelta. */
export type ContextoAuth = Context<{ Bindings: Env; Variables: AuthVars }>;

/**
 * Resuelve la sesión de la cookie `ark_session` y la adjunta al contexto.
 *
 * No rechaza la petición: la deja pasar con la identidad resuelta (o sin ella)
 * para que sea la guardia de la ruta la que decida.
 */
export const authenticateRequest: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVars;
}> = async (c, next) => {
  const sesion = await validateSession(c.env, c.req.raw);
  c.set('sesionNativa', sesion);
  await next();
};

/**
 * Exige que el usuario sea miembro del tenant que pide la cabecera.
 *
 * La cabecera `X-Tenant-Id` **selecciona** entre los despachos del usuario:
 * puede elegir cualquiera de sus membresías y sólo esa. Pedir un tenant ajeno
 * no es un id mal escrito, es un intento de cruzar el aislamiento: 403.
 *
 * Sin sesión (tokens de máquina) o sin cabecera, la petición sigue: quien
 * tiene que comprobar el alcance es la guardia de la ruta.
 */
export const requireTenantMembership: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVars;
}> = async (c, next) => {
  const sesion = c.get('sesionNativa');
  if (!sesion) {
    await next();
    return;
  }

  const ref = tenantRefDesdeRequest(c.req.raw);
  if (!ref.tenantId && !ref.tenantSlug) {
    await next();
    return;
  }

  const miembro = ref.tenantId
    ? sesion.memberships.find((m) => m.tenantId === ref.tenantId)
    : sesion.memberships.find((m) => m.tenantSlug === ref.tenantSlug);

  if (!miembro) {
    return c.json({ error: 'tenant_forbidden' }, 403);
  }

  await next();
};
