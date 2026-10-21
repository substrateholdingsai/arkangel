import type { Context } from 'hono';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import type { Principal } from '../auth/principal';
import type { OrigenPrincipal } from '../auth/guards';
import { logger } from '../lib/logger';
import {
  resolveTenantContextDeRequest,
  TenantMismatchError,
  TenantNoEncontradoError,
  TenantSuspendidoError,
} from '../tenancy/context';
import type { TenantContext } from '../tenancy/types';

export type TenantContextResult =
  { ok: true; ctx: TenantContext } | { ok: false; response: Response };

/**
 * Resuelve el contexto del tenant que pide la llamada.
 *
 * El tenant llega en la cabecera X-Tenant-Id (o X-Tenant-Slug); sin
 * cabecera se usa el tenant por defecto de la plataforma. Si el tenant no
 * existe, se responde 404 en lugar de operar con la configuración de otro:
 * un id equivocado no puede convertirse en un envío a nombre de la empresa
 * equivocada.
 *
 * Si la cabecera apunta a un tenant que **no** es el del principal (un
 * despacho en el que el usuario no es miembro), la respuesta es 403
 * 	enant_mismatch: es suplantación, no un id mal escrito. Antes esto
 * reventaba como 500.
 *
 * principal es el principal ya resuelto por la guardia de la ruta: pasarlo
 * evita volver a autenticar la petición y garantiza que el tenant con el que
 * se opera es el del principal que se autorizó.
 */
export async function tenantContextDeRequest(
  c: Context<{ Bindings: Env; Variables: AuthVars }>,
  principal?: Principal,
  origen?: OrigenPrincipal
): Promise<TenantContextResult> {
  try {
    const ctx = await resolveTenantContextDeRequest(
      c.env,
      c.req.raw,
      principal ? { principal, origen } : {}
    );
    return { ok: true, ctx };
  } catch (error) {
    if (error instanceof TenantNoEncontradoError) {
      return { ok: false, response: c.json({ error: 'tenant_not_found' }, 404) };
    }
    if (error instanceof TenantMismatchError) {
      // Es un intento de cruzar tenants: queda registrado para poder auditarlo.
      logger.warn('Cabecera de tenant que no corresponde al principal: se rechaza', {
        tenantDelPrincipal: error.tenantDelPrincipal,
        tenantSolicitado: error.tenantSolicitado,
      });
      return { ok: false, response: c.json({ error: 'tenant_mismatch' }, 403) };
    }
    if (error instanceof TenantSuspendidoError) {
      return { ok: false, response: c.json({ error: 'tenant_suspended' }, 403) };
    }
    throw error;
  }
}
