/**
 * Guardias de autorización de las rutas.
 *
 * Cada ruta declara qué necesita: un **principal** (quién llama) y un
 * **scope** (qué puede hacer). La guardia resuelve el principal una sola vez
 * y lo devuelve, para que la ruta pueda resolver el contexto de tenant sin
 * volver a autenticarlo: si se resolviera dos veces, el tenant con el que se
 * opera podría no ser el del principal que la ruta ya autorizó.
 *
 * Antes esto era un isAdmin global por router: cualquier token de
 * administración entraba en todo. Ahora cada ruta pide su scope, que es lo
 * que distingue a un `viewer` (lee) de un `operator` (despara).
 *
 * Por qué el 401 dice el motivo: el panel necesita distinguir tres situaciones
 * —sesión caducada (unauthorized), Organization sin tenant (org_sin_tenant)
 * y usuario sin rol en el tenant (sin_acceso)— porque el mensaje al usuario
 * es distinto. Para el servidor las tres son lo mismo: no hay identidad con la
 * que operar, así que la petición se rechaza y **no** se cae al token de
 * máquina (reinterpretar la llamada convertiría "no autorizado" en "autorizado
 * como otro actor"). Una sola verificación evita llamadas dobles a Clerk.
 */

import type { Context } from 'hono';
import { exigeScope, resolverPrincipalDetallado, type OrigenPrincipal } from '../auth/guards';
import type { Principal } from '../auth/principal';
import type { Scope } from '../auth/scopes';
import type { Env } from '../types/env';

/** Contexto de Hono con los bindings del Worker. */
export type ContextoRuta = Context<{ Bindings: Env }>;

/**
 * Resultado de una guardia: o hay principal autorizado, o hay una respuesta
 * lista para devolver (401/403). Nunca undefined: quien llama tiene que
 * decidir, no puede "continuar sin principal".
 */
export type ResultadoGuardia =
  { ok: true; principal: Principal; origen: OrigenPrincipal } | { ok: false; response: Response };

/**
 * Resuelve el principal de la petición y exige un scope concreto.
 *
 * 401 si no hay credencial válida (o si hay sesión de Clerk pero el usuario no
 * tiene acceso: no se cae al token). 403 si el principal no tiene el scope.
 */
export async function exigePrincipalConScope(
  c: ContextoRuta,
  scope: Scope
): Promise<ResultadoGuardia> {
  const resuelto = await resolverPrincipalDetallado(c.env, c.req.raw);
  if (!resuelto.principal) {
    const motivo = resuelto.motivo ?? 'unauthorized';
    return { ok: false, response: c.json({ error: motivo }, 401) };
  }

  const denegado = exigeScope(resuelto.principal, scope);
  if (denegado) return { ok: false, response: denegado };

  return {
    ok: true,
    principal: resuelto.principal,
    origen: resuelto.origen as OrigenPrincipal,
  };
}
