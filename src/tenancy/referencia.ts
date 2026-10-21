/**
 * Referencia al tenant que trae la petición en sus cabeceras.
 *
 * La cabecera la pone la plataforma (el CRM, el panel), que es quien sabe de
 * qué cliente es el tráfico. Sin cabecera se usa el tenant por defecto de la
 * plataforma.
 *
 * Desde la integración con Clerk la cabecera **acota** la vista, no amplía el
 * alcance: el tenant se deduce de la credencial y, si la cabecera apunta a un
 * tenant distinto del del principal, la petición se rechaza con
 * `tenant_mismatch` (fail-closed). Un `X-Tenant-Id` confiado desde el
 * navegador es suplantación.
 *
 * Por qué vive en su propio módulo: lo necesitan las dos capas —la de
 * autenticación (`src/auth/guards.ts`) y la de tenancy— y compartirlo evita un
 * ciclo de importaciones entre ambas.
 */

/** Referencia de tenant que puede traer la petición. */
export interface ReferenciaTenant {
  /** Id del tenant (`X-Tenant-Id`). */
  tenantId?: string;
  /** Slug del tenant (`X-Tenant-Slug`). */
  tenantSlug?: string;
}

/** Lee la referencia de tenant de las cabeceras de la petición. */
export function tenantRefDesdeRequest(request: Request): ReferenciaTenant {
  const tenantId = request.headers.get('x-tenant-id')?.trim();
  if (tenantId) return { tenantId };

  const tenantSlug = request.headers.get('x-tenant-slug')?.trim();
  if (tenantSlug) return { tenantSlug };

  return {};
}
