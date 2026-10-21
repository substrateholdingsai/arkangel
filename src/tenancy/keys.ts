/**
 * Claves de tenant para KV, R2 y Durable Objects.
 *
 * D1 no tiene RLS y KV no tiene namespaces: el aislamiento entre tenants se
 * construye en el nombre de la clave. Regla de oro: **toda** clave de tenant
 * lleva el prefijo `t:{tenantId}:`.
 *
 * Estas funciones son puras y centralizadas para que nadie escriba el prefijo
 * a mano (y para que el test pueda verificar que no se cuela ninguna clave sin
 * tenant).
 */

/** Prefijo común de las claves de tenant. */
export const TENANT_PREFIX = 't';

/** Clave de KV con prefijo de tenant: `t:{tenantId}:{...}`. */
export function tenantKvKey(tenantId: string, ...parts: string[]): string {
  return [TENANT_PREFIX, tenantId, ...parts].join(':');
}

/** Clave de objeto R2 con prefijo de tenant: `t/{tenantId}/{...}`. */
export function tenantR2Key(tenantId: string, ...parts: string[]): string {
  return [TENANT_PREFIX, tenantId, ...parts].join('/');
}

/** Nombre de instancia de Durable Object con prefijo de tenant. */
export function tenantDoName(tenantId: string, ...parts: string[]): string {
  return [TENANT_PREFIX, tenantId, ...parts].join(':');
}
