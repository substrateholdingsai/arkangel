/**
 * Integración de Clerk con las rutas: quién es el actor y qué puede hacer.
 *
 * La verificación de la sesión se sustituye (`sessionVerifier.fn`) para no
 * tocar la red: lo que se prueba aquí es la traducción de "sesión de Clerk" a
 * "principal con scope" y la respuesta de cada ruta cuando falta la
 * credencial, falta el scope, o la cabecera de tenant no cuadra con la
 * Organization del usuario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clerkActivo, sessionVerifier, type SesionClerk } from '../src/auth/clerk';
import { exigeScope, exigeTenant, resolverPrincipal } from '../src/auth/guards';
import { hasScope, platformPrincipal, tenantPrincipal } from '../src/auth/principal';
import type { Role } from '../src/auth/scopes';
import { api } from '../src/routes/api';
import { agent } from '../src/routes/agent';
import { contabilidad } from '../src/routes/contabilidad';
import { ingest } from '../src/routes/ingest';
import type { Tenant, TenantChannel } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

const TENANT_ALFA = 't_alfa';
const TENANT_BETA = 't_beta';
const TENANT_DEFECTO = 't_arkangel';
const ORG_ALFA = 'org_alfa';
const ORG_DESCONOCIDA = 'org_desconocida';
const USER_ALFA = 'user_alfa';
const USER_PLATAFORMA = 'user_plataforma';

const TOKEN_ADMIN = 'admin-token';
const TOKEN_INGESTA = 'intake-token';
const TOKEN_BOT = 'grok-token';

// ── Datos de prueba ────────────────────────────────────────────────────────────

function filaTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ALFA,
    slug: 'alfa',
    nombre: 'Alfa',
    status: 'active',
    config_mode: 'db',
    razon_social: 'Alfa, S.A. de C.V.',
    condusef_registro: '111',
    allowed_payment_domains: 'paga.alfa.mx',
    tz: 'America/Mexico_City',
    send_window_start: 8,
    send_window_end: 22,
    max_contacts_per_day: 3,
    legal_monto_tolerancia_cents: 0,
    legal_horario_en_respuestas: 0,
    rate_limit_rpm: 42,
    dedupe_window_hours: 24,
    score_amount_ceiling_cents: 200000,
    agent_mode: 'supervised',
    agent_auto_threshold_cents: 200000,
    dry_run: 0,
    cron_auto_fire: 0,
    is_default: 0,
    clerk_org_id: ORG_ALFA,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function filaCanal(overrides: Partial<TenantChannel> = {}): TenantChannel {
  return {
    id: 'ch_alfa',
    tenant_id: TENANT_ALFA,
    channel: 'whatsapp',
    provider_account_id: '998877',
    credentials: null,
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

interface UsuarioTenant {
  userId: string;
  tenantId: string;
  role: Role;
}

interface FakeD1Opciones {
  tenants?: Tenant[];
  canales?: TenantChannel[];
  usuariosTenant?: UsuarioTenant[];
  usuariosPlataforma?: string[];
}

class FakeD1 {
  constructor(private opciones: FakeD1Opciones = {}) {}

  private responde(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM platform_users')) {
      const [userId] = args as [string];
      return (this.opciones.usuariosPlataforma ?? []).includes(userId) ? [{ '1': 1 }] : [];
    }
    if (sql.includes('FROM tenant_users')) {
      const [userId, tenantId] = args as [string, string];
      const fila = (this.opciones.usuariosTenant ?? []).find(
        (u) => u.userId === userId && u.tenantId === tenantId
      );
      return fila ? [{ role: fila.role }] : [];
    }
    if (sql.includes('FROM tenant_channels')) {
      const [tenantId] = args as [string];
      return (this.opciones.canales ?? []).filter(
        (c) => c.tenant_id === tenantId && c.status === 'active'
      );
    }
    if (sql.includes('FROM tenants')) {
      const tenants = this.opciones.tenants ?? [];
      if (sql.includes('WHERE clerk_org_id = ?')) {
        const [orgId] = args as [string];
        return tenants.filter((t) => t.clerk_org_id === orgId);
      }
      if (sql.includes('WHERE id = ?')) {
        const [id] = args as [string];
        return tenants.filter((t) => t.id === id);
      }
      if (sql.includes('WHERE slug = ?')) {
        const [slug] = args as [string];
        return tenants.filter((t) => t.slug === slug);
      }
      if (sql.includes('is_default = 1')) return tenants.filter((t) => t.is_default === 1);
      return tenants;
    }
    return [];
  }

  prepare = (sql: string) => {
    const limpio = sql.replace(/\s+/g, ' ').trim();
    const responde = (args: unknown[]) => this.responde(limpio, args);

    return {
      all: async () => ({ results: responde([]) }),
      first: async () => responde([])[0] ?? null,
      run: async () => ({ success: true }),
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: responde(args) }),
        first: async () => responde(args)[0] ?? null,
        run: async () => ({ success: true }),
      }),
    };
  };
}

const ENV_BASE = {
  ENVIRONMENT: 'test',
  ADMIN_TOKEN: TOKEN_ADMIN,
  INTAKE_TOKEN: TOKEN_INGESTA,
  GROK_BOT_TOKEN: TOKEN_BOT,
  CLERK_SECRET_KEY: 'sk_test_arkangel',
  CLERK_PUBLISHABLE_KEY: 'pk_test_arkangel',
  TZ: 'America/Mexico_City',
  LEGAL_RAZON_SOCIAL: 'Alfa, S.A. de C.V.',
  R2: { list: async () => ({ objects: [] }), get: async () => null },
} as unknown as Env;

function envCon(d1: FakeD1, extra: Record<string, unknown> = {}): Env {
  return { ...ENV_BASE, DB: d1 as unknown as D1Database, ...extra } as unknown as Env;
}

/** Tenant por defecto + tenant de Alfa (mapeado a la Organization de Clerk). */
function d1Base(extra: FakeD1Opciones = {}): FakeD1 {
  return new FakeD1({
    tenants: [
      filaTenant(),
      filaTenant({
        id: TENANT_BETA,
        slug: 'beta',
        nombre: 'Beta',
        clerk_org_id: 'org_beta',
      }),
      filaTenant({
        id: TENANT_DEFECTO,
        slug: 'arkangel',
        nombre: 'Arkangel',
        config_mode: 'platform_env',
        is_default: 1,
        clerk_org_id: null,
      }),
    ],
    canales: [filaCanal()],
    ...extra,
  });
}

function peticion(headers: Record<string, string> = {}): Request {
  return new Request('https://arkangel.test/api/v1/cases/today', { headers });
}

async function cuerpo(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── Sesión de Clerk simulada ───────────────────────────────────────────────────

const verificadorOriginal = sessionVerifier.fn;
let sesionActual: SesionClerk | null = null;

beforeEach(() => {
  sesionActual = null;
  sessionVerifier.fn = async () => sesionActual;
});

afterEach(() => {
  sessionVerifier.fn = verificadorOriginal;
  sesionActual = null;
});

describe('sesión de Clerk → principal', () => {
  it('la sesión con Organization mapeada da el tenant de esa Organization y el rol de D1', async () => {
    sesionActual = {
      userId: USER_ALFA,
      sessionId: 'sess_1',
      orgId: ORG_ALFA,
      orgRole: 'admin',
    };
    const env = envCon(
      d1Base({ usuariosTenant: [{ userId: USER_ALFA, tenantId: TENANT_ALFA, role: 'operator' }] })
    );

    const resuelto = await resolverPrincipal(env, peticion());

    expect(resuelto?.origen).toBe('session');
    expect(resuelto?.principal.kind).toBe('user');
    expect(resuelto?.principal.tenantId).toBe(TENANT_ALFA);
    expect(resuelto?.principal.role).toBe('operator');
    expect(hasScope(resuelto!.principal, 'cases:read')).toBe(true);
    expect(hasScope(resuelto!.principal, 'cases:dispatch')).toBe(true);
  });

  it('un usuario en la Organization sin fila en tenant_users recibe 401 y no cae al token', async () => {
    sesionActual = {
      userId: 'user_huerfano',
      sessionId: 'sess_1',
      orgId: ORG_ALFA,
      orgRole: 'admin',
    };
    const env = envCon(d1Base());

    // La sesión manda: aunque venga el token de administración, no hay principal.
    const resuelto = await resolverPrincipal(
      env,
      peticion({ authorization: `Bearer ${TOKEN_ADMIN}` })
    );
    expect(resuelto).toBeNull();

    const res = await api.request(
      '/cases/today',
      { headers: { authorization: `Bearer ${TOKEN_ADMIN}` } },
      env
    );
    expect(res.status).toBe(401);
    expect((await cuerpo(res)).error).toBe('sin_acceso');
  });

  it('un platform_users es principal de plataforma: todos los scopes y tenantId null', async () => {
    sesionActual = {
      userId: USER_PLATAFORMA,
      sessionId: 'sess_2',
      orgId: null,
      orgRole: null,
    };
    const env = envCon(d1Base({ usuariosPlataforma: [USER_PLATAFORMA] }));

    const resuelto = await resolverPrincipal(env, peticion());

    expect(resuelto?.principal.kind).toBe('platform');
    expect(resuelto?.principal.tenantId).toBeNull();
    expect(hasScope(resuelto!.principal, 'tenants:write')).toBe(true);
    expect(hasScope(resuelto!.principal, 'cases:dispatch')).toBe(true);
  });

  it('una Organization sin tenant responde 401 org_sin_tenant', async () => {
    sesionActual = {
      userId: USER_ALFA,
      sessionId: 'sess_1',
      orgId: ORG_DESCONOCIDA,
      orgRole: 'admin',
    };
    const env = envCon(d1Base());

    // La SPA manda el JWT de sesión en `Authorization`: la petición se ve
    // autenticada aunque la Organization no exista en el catálogo.
    const res = await api.request(
      '/cases/today',
      { headers: { authorization: 'Bearer jwt-de-sesion' } },
      env
    );

    expect(res.status).toBe(401);
    expect((await cuerpo(res)).error).toBe('org_sin_tenant');
  });
});

describe('tokens de máquina', () => {
  it('el INTAKE_TOKEN da un principal apikey acotado al tenant de la cabecera, nunca plataforma', async () => {
    const env = envCon(d1Base());

    const resuelto = await resolverPrincipal(
      env,
      peticion({ authorization: `Bearer ${TOKEN_INGESTA}`, 'x-tenant-id': TENANT_ALFA })
    );

    expect(resuelto?.origen).toBe('token');
    expect(resuelto?.principal.kind).toBe('apikey');
    expect(resuelto?.principal.tenantId).toBe(TENANT_ALFA);
    expect(resuelto?.principal.role).toBe('service_ingest');
    expect(hasScope(resuelto!.principal, 'ingest:write')).toBe(true);
    expect(hasScope(resuelto!.principal, 'tenants:write')).toBe(false);
  });

  it('el INTAKE_TOKEN sin cabecera tampoco es plataforma: queda sin acotar', async () => {
    const env = envCon(d1Base());

    const resuelto = await resolverPrincipal(
      env,
      peticion({ authorization: `Bearer ${TOKEN_INGESTA}` })
    );

    expect(resuelto?.principal.kind).toBe('apikey');
    expect(resuelto?.principal.tenantId).toBeNull();
  });

  it('el token del bot sigue pudiendo usar las rutas del agente', async () => {
    const env = envCon(d1Base());

    const res = await agent.request(
      '/audit',
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN_BOT}` } },
      env
    );

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).ok).toBe(true);
  });

  it('el INTAKE_TOKEN sigue pudiendo usar la ingesta', async () => {
    const env = envCon(d1Base());

    const res = await ingest.request(
      '/ingest/csv',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN_INGESTA}`, 'content-type': 'text/csv' },
        body: 'nombre,telefono,monto\nJuan Perez,5511110001,1000\n',
      },
      env
    );

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).ok).toBe(true);
  });
});

describe('tenant y cabeceras', () => {
  it('una cabecera de tenant que no coincide con la Organization da 403 tenant_mismatch', async () => {
    sesionActual = {
      userId: USER_ALFA,
      sessionId: 'sess_1',
      orgId: ORG_ALFA,
      orgRole: 'admin',
    };
    const env = envCon(
      d1Base({ usuariosTenant: [{ userId: USER_ALFA, tenantId: TENANT_ALFA, role: 'owner' }] })
    );

    const res = await api.request('/cases/today', { headers: { 'x-tenant-id': TENANT_BETA } }, env);

    expect(res.status).toBe(403);
    expect((await cuerpo(res)).error).toBe('tenant_mismatch');
  });

  it('una cabecera de tenant que sí coincide con la Organization deja pasar', async () => {
    sesionActual = {
      userId: USER_ALFA,
      sessionId: 'sess_1',
      orgId: ORG_ALFA,
      orgRole: 'admin',
    };
    const env = envCon(
      d1Base({ usuariosTenant: [{ userId: USER_ALFA, tenantId: TENANT_ALFA, role: 'owner' }] })
    );

    const res = await api.request('/cases/today', { headers: { 'x-tenant-id': TENANT_ALFA } }, env);

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).ok).toBe(true);
  });
});

describe('autenticación y scopes en las rutas', () => {
  it('sin credencial la ruta responde 401 unauthorized', async () => {
    const env = envCon(d1Base());

    const res = await api.request('/cases/today', {}, env);

    expect(res.status).toBe(401);
    expect((await cuerpo(res)).error).toBe('unauthorized');
  });

  it('un principal con scope insuficiente recibe 403 forbidden', async () => {
    const env = envCon(d1Base());

    // El token de ingesta puede escribir, pero no despachar casos.
    const res = await api.request(
      '/disparar',
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN_INGESTA}` } },
      env
    );

    expect(res.status).toBe(403);
    const body = await cuerpo(res);
    expect(body.error).toBe('forbidden');
    expect(body.scope).toBe('cases:dispatch');
  });

  it('un viewer puede leer pero no despachar', async () => {
    sesionActual = {
      userId: USER_ALFA,
      sessionId: 'sess_1',
      orgId: ORG_ALFA,
      orgRole: 'admin',
    };
    const env = envCon(
      d1Base({ usuariosTenant: [{ userId: USER_ALFA, tenantId: TENANT_ALFA, role: 'viewer' }] })
    );

    const lectura = await api.request('/cases/today', {}, env);
    expect(lectura.status).toBe(200);

    const disparo = await api.request('/disparar', { method: 'POST' }, env);
    expect(disparo.status).toBe(403);
    expect((await cuerpo(disparo)).scope).toBe('cases:dispatch');
  });

  it('el resumen contable exige accounting:read', async () => {
    const env = envCon(d1Base());

    const denegado = await contabilidad.request(
      '/contabilidad/resumen',
      { headers: { authorization: `Bearer ${TOKEN_INGESTA}` } },
      env
    );
    expect(denegado.status).toBe(403);
    expect((await cuerpo(denegado)).scope).toBe('accounting:read');

    // El administrador de plataforma sí pasa la guardia (aquí no hay corte
    // publicado en R2, así que la ruta responde 404 y no 401/403).
    const permitido = await contabilidad.request(
      '/contabilidad/resumen',
      { headers: { authorization: `Bearer ${TOKEN_ADMIN}` } },
      env
    );
    expect(permitido.status).toBe(404);
    expect((await cuerpo(permitido)).error).toBe('sin_payload');
  });

  it('sin CLERK_SECRET_KEY, Clerk queda deshabilitado y el Worker sigue con tokens', async () => {
    const env = envCon(d1Base(), { CLERK_SECRET_KEY: undefined });

    expect(clerkActivo(env)).toBe(false);

    const res = await api.request(
      '/legal/catalogo',
      { headers: { authorization: `Bearer ${TOKEN_ADMIN}` } },
      env
    );

    expect(res.status).toBe(200);
    expect((await cuerpo(res)).ok).toBe(true);
  });
});

describe('guardas de scope y de tenant', () => {
  it('exigeScope y exigeTenant devuelven null cuando hay permiso', () => {
    const plataforma = platformPrincipal(USER_PLATAFORMA);
    expect(exigeScope(plataforma, 'cases:read')).toBeNull();
    expect(exigeTenant(plataforma, TENANT_ALFA)).toBeNull();

    const vista = tenantPrincipal('user', USER_ALFA, TENANT_ALFA, 'viewer');
    expect(exigeScope(vista, 'cases:read')).toBeNull();
    expect(exigeTenant(vista, TENANT_ALFA)).toBeNull();
  });

  it('exigeScope responde 403 forbidden con el scope pedido', async () => {
    const vista = tenantPrincipal('user', USER_ALFA, TENANT_ALFA, 'viewer');

    const res = exigeScope(vista, 'cases:dispatch');

    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(await cuerpo(res!)).toEqual({ error: 'forbidden', scope: 'cases:dispatch' });
  });

  it('exigeTenant responde 403 tenant_forbidden si el tenant no es el del principal', async () => {
    const vista = tenantPrincipal('user', USER_ALFA, TENANT_ALFA, 'viewer');

    const res = exigeTenant(vista, TENANT_BETA);

    expect(res?.status).toBe(403);
    expect(await cuerpo(res!)).toEqual({ error: 'tenant_forbidden' });
  });
});
