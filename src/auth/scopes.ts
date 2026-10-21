/**
 * Catálogo de scopes y roles del modelo multi-tenant.
 *
 * Reglas del modelo:
 *   · El **tenant se deduce de la credencial**, nunca de un header del cliente.
 *     Un `X-Tenant-Id` confiado desde el navegador es suplantación trivial.
 *   · El **scope** decide *qué* puede hacer el principal dentro de su tenant.
 *   · El **rol** es un preset de scopes que la plataforma asigna al usuario.
 *   · Los servicios (API keys) nunca reciben un rol de humano: reciben scopes.
 */

/** Permisos atómicos sobre un recurso. */
export const SCOPES = [
  // Casos de cobranza
  'cases:read',
  'cases:write',
  'cases:dispatch',
  'cases:release',
  // Clientes (deudores)
  'clients:read',
  'clients:write',
  // Mensajes
  'messages:read',
  'messages:send',
  // Promesas de pago
  'promises:read',
  'promises:write',
  // Métricas
  'metrics:read',
  // Cumplimiento
  'legal:read',
  'legal:config',
  'legal:evidence',
  // Contabilidad
  'accounting:read',
  'accounting:sync',
  // Plataforma (fuera del tenant)
  'tenants:read',
  'tenants:write',
  'impersonate',
  // Administración del tenant
  'keys:manage',
  'users:manage',
  // Servicios
  'ingest:write',
  'agent:read',
  'agent:decide',
  'agent:dispatch',
  'agent:audit',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Roles de humano y roles de servicio. */
export const ROLES = [
  'platform_admin',
  'owner',
  'compliance',
  'operator',
  'viewer',
  'service_ingest',
  'service_agent',
  'service_readonly',
] as const;

export type Role = (typeof ROLES)[number];

/** Todo lo que un tenant puede hacer sobre sí mismo. */
const TENANT_SCOPES = [
  'cases:read',
  'cases:write',
  'cases:dispatch',
  'cases:release',
  'clients:read',
  'clients:write',
  'messages:read',
  'messages:send',
  'promises:read',
  'promises:write',
  'metrics:read',
  'legal:read',
  'legal:config',
  'legal:evidence',
  'accounting:read',
  'accounting:sync',
  'keys:manage',
  'users:manage',
  'ingest:write',
  'agent:read',
  'agent:decide',
  'agent:dispatch',
  'agent:audit',
] as const satisfies readonly Scope[];

/**
 * Presets por rol.
 *
 * `compliance` (nivel 2) está separado de `operator` (nivel 3) a propósito: quien
 * edita la config legal y exporta la evidencia no debería ser la misma persona
 * que presiona "enviar". En un procedimiento ante CONDUSEF o PROFECO esa
 * separación de funciones es la defensa estándar.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  platform_admin: [...TENANT_SCOPES, 'tenants:read', 'tenants:write', 'impersonate'],
  owner: TENANT_SCOPES,
  compliance: [
    'cases:read',
    'cases:release',
    'clients:read',
    'messages:read',
    'promises:read',
    'metrics:read',
    'legal:read',
    'legal:config',
    'legal:evidence',
    'accounting:read',
  ],
  operator: [
    'cases:read',
    'cases:write',
    'cases:dispatch',
    'clients:read',
    'clients:write',
    'messages:read',
    'messages:send',
    'promises:read',
    'promises:write',
    'metrics:read',
    'legal:read',
  ],
  viewer: [
    'cases:read',
    'clients:read',
    'messages:read',
    'promises:read',
    'metrics:read',
    'legal:read',
    'accounting:read',
  ],
  service_ingest: ['ingest:write'],
  service_agent: ['agent:read', 'agent:decide', 'agent:dispatch', 'agent:audit'],
  service_readonly: [
    'cases:read',
    'clients:read',
    'messages:read',
    'promises:read',
    'metrics:read',
    'legal:read',
    'accounting:read',
  ],
};

export const ALL_SCOPES: readonly Scope[] = SCOPES;

/** Scopes de un rol, como conjunto consultable. */
export function scopesForRole(role: Role): Set<Scope> {
  return new Set(ROLE_SCOPES[role] ?? []);
}
