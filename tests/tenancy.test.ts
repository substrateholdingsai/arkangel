import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  ROLE_SCOPES,
  ROLES,
  SCOPES,
  scopesForRole,
  type Scope,
} from '../src/auth/scopes';
import {
  canActOnTenant,
  hasAnyScope,
  hasScope,
  isPlatform,
  platformPrincipal,
  tenantPrincipal,
} from '../src/auth/principal';
import { TENANT_PREFIX, tenantDoName, tenantKvKey, tenantR2Key } from '../src/tenancy/keys';
import { IdempotencyKey } from '../src/lib/idempotencia';

describe('catálogo de scopes', () => {
  it('no tiene scopes duplicados', () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
  });

  it('todo scope asignado a un rol existe en el catálogo', () => {
    for (const role of ROLES) {
      for (const scope of ROLE_SCOPES[role]) {
        expect(SCOPES).toContain(scope);
      }
    }
  });

  it('todo rol declara scopes', () => {
    for (const role of ROLES) {
      expect(ROLE_SCOPES[role].length).toBeGreaterThan(0);
    }
  });
});

describe('matriz de niveles de acceso', () => {
  it('plataforma tiene todos los scopes y puede impersonar', () => {
    const platform = platformPrincipal();
    expect(platform.tenantId).toBeNull();
    expect(isPlatform(platform)).toBe(true);
    for (const scope of ALL_SCOPES) {
      expect(hasScope(platform, scope)).toBe(true);
    }
  });

  it('compliance edita la config legal y exporta evidencia, pero no dispara envíos', () => {
    const compliance = tenantPrincipal('user', 'u1', 't_a', 'compliance');
    expect(hasScope(compliance, 'legal:config')).toBe(true);
    expect(hasScope(compliance, 'legal:evidence')).toBe(true);
    expect(hasScope(compliance, 'cases:release')).toBe(true);
    expect(hasScope(compliance, 'cases:dispatch')).toBe(false);
    expect(hasScope(compliance, 'messages:send')).toBe(false);
    expect(hasScope(compliance, 'keys:manage')).toBe(false);
    expect(hasScope(compliance, 'users:manage')).toBe(false);
  });

  it('operator dispara y registra promesas, pero no edita la config legal', () => {
    const operator = tenantPrincipal('user', 'u2', 't_a', 'operator');
    expect(hasScope(operator, 'cases:dispatch')).toBe(true);
    expect(hasScope(operator, 'messages:send')).toBe(true);
    expect(hasScope(operator, 'promises:write')).toBe(true);
    expect(hasScope(operator, 'legal:config')).toBe(false);
    expect(hasScope(operator, 'legal:evidence')).toBe(false);
    expect(hasScope(operator, 'keys:manage')).toBe(false);
  });

  it('viewer sólo lee el negocio, sin scopes de bot ni de plataforma', () => {
    const viewer = tenantPrincipal('user', 'u3', 't_a', 'viewer');
    const esperados: Scope[] = [
      'cases:read',
      'clients:read',
      'messages:read',
      'promises:read',
      'metrics:read',
      'legal:read',
      'accounting:read',
    ];
    for (const scope of SCOPES) {
      expect(hasScope(viewer, scope)).toBe(esperados.includes(scope));
    }
  });

  it('owner puede todo dentro del tenant pero nada de plataforma', () => {
    const owner = tenantPrincipal('user', 'u4', 't_a', 'owner');
    expect(hasScope(owner, 'cases:dispatch')).toBe(true);
    expect(hasScope(owner, 'users:manage')).toBe(true);
    expect(hasScope(owner, 'tenants:write')).toBe(false);
    expect(hasScope(owner, 'impersonate')).toBe(false);
  });

  it('los servicios sólo tienen su scope', () => {
    const ingest = tenantPrincipal('apikey', 'k1', 't_a', 'service_ingest');
    expect(hasScope(ingest, 'ingest:write')).toBe(true);
    expect(hasScope(ingest, 'cases:read')).toBe(false);
    expect(hasScope(ingest, 'legal:evidence')).toBe(false);

    const agent = tenantPrincipal('apikey', 'k2', 't_a', 'service_agent');
    expect(hasScope(agent, 'agent:dispatch')).toBe(true);
    expect(hasScope(agent, 'cases:dispatch')).toBe(false);
  });

  it('un API key con scopes explícitos manda sobre el preset del rol', () => {
    const key = tenantPrincipal('apikey', 'k3', 't_a', 'service_ingest', ['cases:read']);
    expect(hasScope(key, 'cases:read')).toBe(true);
    expect(hasScope(key, 'ingest:write')).toBe(false);
  });

  it('scopesForRole devuelve el mismo conjunto que la matriz', () => {
    for (const role of ROLES) {
      expect([...scopesForRole(role)].sort()).toEqual([...ROLE_SCOPES[role]].sort());
    }
  });
});

describe('alcance del principal', () => {
  it('un principal de tenant sólo opera sobre su tenant', () => {
    const op = tenantPrincipal('user', 'u1', 't_a', 'operator');
    expect(canActOnTenant(op, 't_a')).toBe(true);
    expect(canActOnTenant(op, 't_b')).toBe(false);
  });

  it('plataforma opera sobre cualquier tenant', () => {
    const platform = platformPrincipal('admin');
    expect(canActOnTenant(platform, 't_a')).toBe(true);
    expect(canActOnTenant(platform, 't_b')).toBe(true);
  });

  it('hasAnyScope responde con semántica de OR', () => {
    const viewer = tenantPrincipal('user', 'u3', 't_a', 'viewer');
    expect(hasAnyScope(viewer, ['cases:write', 'cases:read'])).toBe(true);
    expect(hasAnyScope(viewer, ['cases:write', 'cases:dispatch'])).toBe(false);
    expect(hasAnyScope(viewer, [])).toBe(false);
  });
});

describe('claves con prefijo de tenant', () => {
  it('KV, R2 y DO llevan el tenant en el nombre', () => {
    expect(tenantKvKey('t_acme', 'cobranza', 'case_1', 'whatsapp')).toBe(
      't:t_acme:cobranza:case_1:whatsapp'
    );
    expect(tenantR2Key('t_acme', 'contabilidad', '2026-10-20.json')).toBe(
      't/t_acme/contabilidad/2026-10-20.json'
    );
    expect(tenantDoName('t_acme', 'client', 'cli_1')).toBe('t:t_acme:client:cli_1');
    expect(TENANT_PREFIX).toBe('t');
  });

  it('dos tenants nunca comparten clave', () => {
    expect(tenantKvKey('t_a', 'cobranza', 'case_1', 'whatsapp')).not.toBe(
      tenantKvKey('t_b', 'cobranza', 'case_1', 'whatsapp')
    );
  });
});

describe('claves de idempotencia por tenant', () => {
  it('aíslan dedupe, throttle e ingesta entre tenants', () => {
    expect(IdempotencyKey.forTenantCase('t_a', 'case_1', 'whatsapp')).toBe(
      't:t_a:cobranza:case_1:whatsapp'
    );
    expect(IdempotencyKey.forTenantInbound('t_a', 'whatsapp', 'wamid.1')).toBe(
      't:t_a:inbound:whatsapp:wamid.1'
    );
    expect(IdempotencyKey.forTenantRateLimit('t_a', 'sms', 1764000000)).toBe(
      't:t_a:rl:sms:1764000000'
    );
  });

  it('las claves legacy (sin tenant) siguen intactas', () => {
    expect(IdempotencyKey.forCase('case_1', 'whatsapp')).toBe('cobranza:case_1:whatsapp');
    expect(IdempotencyKey.forInbound('whatsapp', 'wamid.1')).toBe('inbound:whatsapp:wamid.1');
  });
});
