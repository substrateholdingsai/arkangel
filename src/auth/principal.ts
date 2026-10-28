/**
 * Principal: quién está actuando.
 *
 * Es la respuesta a la pregunta "¿qué puede hacer esta llamada?". El tenant
 * viaja *dentro* del principal porque se deduce de la credencial que lo
 * autentica, nunca de un dato que el cliente pueda elegir.
 */

import { scopesForRole, type Role, type Scope } from './scopes';

export type PrincipalKind = 'platform' | 'user' | 'apikey';

export interface Principal {
  kind: PrincipalKind;
  /** Identidad del actor para auditoría: id de usuario, id de API key o 'platform'. */
  actorId: string;
  /** `null` = alcance de plataforma (todos los tenants). */
  tenantId: string | null;
  role: Role;
  scopes: ReadonlySet<Scope>;
}

/** Principal de plataforma: alcance transversal, siempre auditado. */
export function platformPrincipal(actorId = 'platform'): Principal {
  return {
    kind: 'platform',
    actorId,
    tenantId: null,
    role: 'platform_admin',
    scopes: scopesForRole('platform_admin'),
  };
}

/** Principal de tenant: humano o servicio, siempre acotado a un tenant. */
export function tenantPrincipal(
  kind: Exclude<PrincipalKind, 'platform'>,
  actorId: string,
  tenantId: string,
  role: Role,
  scopes?: Iterable<Scope>
): Principal {
  return {
    kind,
    actorId,
    tenantId,
    role,
    scopes: scopes ? new Set(scopes) : scopesForRole(role),
  };
}

/** ¿El principal tiene este scope? */
export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}

/** ¿El principal tiene al menos uno de estos scopes? */
export function hasAnyScope(principal: Principal, scopes: readonly Scope[]): boolean {
  return scopes.some((scope) => principal.scopes.has(scope));
}

/**
 * ¿El principal puede operar sobre este tenant?
 *
 * Plataforma sí (y queda registrado como impersonación); un principal de tenant
 * sólo sobre su propio tenant.
 */
export function canActOnTenant(principal: Principal, tenantId: string): boolean {
  return principal.tenantId === null || principal.tenantId === tenantId;
}

/** ¿El principal es de plataforma? */
export function isPlatform(principal: Principal): boolean {
  return principal.kind === 'platform';
}
