import { describe, expect, it } from 'vitest';
import {
  resolveTenantContext,
  resolveTenantIdForInbound,
  routingIdDeInbound,
  TenantNoEncontradoError,
  TenantSuspendidoError,
  tenantRefDesdeRequest,
} from '../src/tenancy/context';
import { TENANT_POR_DEFECTO_ID } from '../src/tenancy/config';
import type { Tenant, TenantChannel } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

function filaTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't_alfa',
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
    clerk_org_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function filaCanal(overrides: Partial<TenantChannel> = {}): TenantChannel {
  return {
    id: 'ch_1',
    tenant_id: 't_alfa',
    channel: 'whatsapp',
    provider_account_id: '998877',
    credentials: null,
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

interface FakeD1Opciones {
  /** Simula que la tabla no existe todavía (migración 0004 sin aplicar). */
  sinTablaTenants?: boolean;
  sinTablaCanales?: boolean;
  tenants?: Tenant[];
  canales?: TenantChannel[];
  /** Error de D1 que no debe ocultarse detrás del fallback. */
  error?: Error | null;
}

class FakeD1 {
  constructor(private opciones: FakeD1Opciones = {}) {}

  private responde(sql: string, args: unknown[]): unknown[] {
    if (this.opciones.error) throw this.opciones.error;
    if (sql.includes('FROM tenants t')) {
      if (this.opciones.sinTablaCanales)
        throw new Error('D1_ERROR: no such table: tenant_channels');
      const [canal, cuenta] = args as [string, string];
      const fila = (this.opciones.tenants ?? []).find((t) =>
        (this.opciones.canales ?? []).some(
          (c) =>
            c.tenant_id === t.id &&
            c.channel === canal &&
            c.provider_account_id === cuenta &&
            c.status === 'active'
        )
      );
      return fila ? [fila] : [];
    }
    if (sql.includes('FROM tenant_channels')) {
      if (this.opciones.sinTablaCanales)
        throw new Error('D1_ERROR: no such table: tenant_channels');
      const [tenantId] = args as [string];
      return (this.opciones.canales ?? []).filter(
        (c) => c.tenant_id === tenantId && c.status === 'active'
      );
    }
    if (sql.includes('FROM tenants')) {
      if (this.opciones.sinTablaTenants) throw new Error('D1_ERROR: no such table: tenants');
      const tenants = this.opciones.tenants ?? [];
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

    const preparado = {
      all: async () => ({ results: responde([]) }),
      first: async () => responde([])[0] ?? null,
      run: async () => ({ success: true }),
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: responde(args) }),
        first: async () => responde(args)[0] ?? null,
        run: async () => ({ success: true }),
      }),
    };
    return preparado;
  };
}

const ENV_BASE = {
  LEGAL_RAZON_SOCIAL: 'Legacy, S.A. de C.V.',
  LEGAL_CONDUSEF_REGISTRO: '777',
  ALLOWED_PAYMENT_DOMAINS: 'prestamoclaro.com',
  SEND_WINDOW_START: '8',
  SEND_WINDOW_END: '22',
  TZ: 'America/Mexico_City',
  DRY_RUN: 'false',
} as unknown as Env;

function envCon(d1: FakeD1, extra: Record<string, unknown> = {}): Env {
  return { ...ENV_BASE, DB: d1 as unknown as D1Database, ...extra } as unknown as Env;
}

describe('resolución del tenant', () => {
  it('sin tabla `tenants` cae al tenant de respaldo con la config del entorno', async () => {
    const ctx = await resolveTenantContext(envCon(new FakeD1({ sinTablaTenants: true })));

    expect(ctx.tenantId).toBe(TENANT_POR_DEFECTO_ID);
    expect(ctx.tenant.config_mode).toBe('platform_env');
    expect(ctx.config.razonSocial).toBe('Legacy, S.A. de C.V.');
  });

  it('el tenant de respaldo conserva el id del backfill: el namespace de KV no cambia', () => {
    expect(TENANT_POR_DEFECTO_ID).toBe('t_arkangel');
  });

  it('un tenant explícito NO hereda la config de la plataforma si falta la tabla', async () => {
    await expect(
      resolveTenantContext(envCon(new FakeD1({ sinTablaTenants: true })), { tenantId: 't_alfa' })
    ).rejects.toBeInstanceOf(TenantNoEncontradoError);
  });

  it('un tenant explícito inexistente no se sustituye por el de la plataforma', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant({ id: 't_otro' })] });
    await expect(resolveTenantContext(envCon(d1), { tenantId: 't_alfa' })).rejects.toBeInstanceOf(
      TenantNoEncontradoError
    );
  });

  it('un tenant suspendido no opera', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant({ status: 'suspended' })] });
    await expect(resolveTenantContext(envCon(d1), { tenantId: 't_alfa' })).rejects.toBeInstanceOf(
      TenantSuspendidoError
    );
  });

  it('en modo `db` la identidad viene de la fila, no del entorno', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant()] });
    const ctx = await resolveTenantContext(envCon(d1), { tenantId: 't_alfa' });

    expect(ctx.config.razonSocial).toBe('Alfa, S.A. de C.V.');
    expect(ctx.config.condusef).toBe('111');
    expect(ctx.config.razonSocial).not.toContain('Legacy');
  });

  it('en modo `platform_env` la identidad viene del entorno', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant({ config_mode: 'platform_env' })] });
    const ctx = await resolveTenantContext(envCon(d1), { tenantId: 't_alfa' });

    expect(ctx.config.razonSocial).toBe('Legacy, S.A. de C.V.');
  });

  it('sin tabla `tenant_channels` los canales quedan vacíos, no hay error', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant()], sinTablaCanales: true });
    const ctx = await resolveTenantContext(envCon(d1), { tenantId: 't_alfa' });

    expect(ctx.channels).toEqual([]);
  });

  it('sólo se cargan los canales del propio tenant', async () => {
    const d1 = new FakeD1({
      tenants: [filaTenant()],
      canales: [filaCanal(), filaCanal({ id: 'ch_otro', tenant_id: 't_beta' })],
    });
    const ctx = await resolveTenantContext(envCon(d1), { tenantId: 't_alfa' });

    expect(ctx.channels).toHaveLength(1);
    expect(ctx.channels[0]?.id).toBe('ch_1');
  });

  it('otros errores de D1 no se esconden detrás del fallback', async () => {
    const d1 = new FakeD1({ error: new Error('D1_ERROR: disk I/O error') });
    await expect(resolveTenantContext(envCon(d1), { tenantId: 't_alfa' })).rejects.toThrow(
      /disk I\/O error/
    );
  });
});

describe('enrutado del inbound por tenant', () => {
  it('WhatsApp se enruta por `phone_number_id`', () => {
    expect(
      routingIdDeInbound({
        channel: 'whatsapp',
        providerId: 'wamid.1',
        from: '+525511110001',
        body: 'hola',
        receivedAt: '2026-10-20T00:00:00Z',
        meta: { phone_number_id: '998877' },
      })
    ).toBe('998877');
  });

  it('SMS se enruta por `messaging_profile_id`', () => {
    expect(
      routingIdDeInbound({
        channel: 'sms',
        providerId: 'tel_1',
        from: '+525511110001',
        body: 'hola',
        receivedAt: '2026-10-20T00:00:00Z',
        meta: { messaging_profile_id: 'tg_1' },
      })
    ).toBe('tg_1');
  });

  it('el email se enruta por el dominio receptor', () => {
    expect(
      routingIdDeInbound({
        channel: 'email',
        providerId: 'res_1',
        from: 'juan@example.com',
        to: 'cobranza@arksystems.site',
        body: 'hola',
        receivedAt: '2026-10-20T00:00:00Z',
      })
    ).toBe('arksystems.site');
  });

  it('sin dato de enrutado no hay atribución', () => {
    expect(
      routingIdDeInbound({
        channel: 'whatsapp',
        providerId: 'wamid.1',
        from: '+525511110001',
        body: 'hola',
        receivedAt: '2026-10-20T00:00:00Z',
      })
    ).toBeNull();
  });

  it('el inbound se atribuye al tenant cuyo enrutado coincide', async () => {
    const d1 = new FakeD1({
      tenants: [filaTenant(), filaTenant({ id: 't_beta', slug: 'beta' })],
      canales: [filaCanal(), filaCanal({ id: 'ch_beta', tenant_id: 't_beta' })],
    });

    const tenantId = await resolveTenantIdForInbound(envCon(d1), {
      channel: 'whatsapp',
      providerId: 'wamid.1',
      from: '+525511110001',
      body: 'hola',
      receivedAt: '2026-10-20T00:00:00Z',
      meta: { phone_number_id: '998877' },
    });

    expect(tenantId).toBe('t_alfa');
  });

  it('un enrutado desconocido deja el inbound en el tenant por defecto', async () => {
    const d1 = new FakeD1({ tenants: [filaTenant()], canales: [filaCanal()] });

    const tenantId = await resolveTenantIdForInbound(envCon(d1), {
      channel: 'whatsapp',
      providerId: 'wamid.1',
      from: '+525511110001',
      body: 'hola',
      receivedAt: '2026-10-20T00:00:00Z',
      meta: { phone_number_id: 'desconocido' },
    });

    expect(tenantId).toBeUndefined();
  });
});

describe('referencia de tenant en la petición', () => {
  it('lee `X-Tenant-Id`', () => {
    const request = new Request('https://arkangel.test/api/v1/cases/today', {
      headers: { 'x-tenant-id': 't_alfa' },
    });
    expect(tenantRefDesdeRequest(request)).toEqual({ tenantId: 't_alfa' });
  });

  it('lee `X-Tenant-Slug` cuando no hay id', () => {
    const request = new Request('https://arkangel.test/api/v1/cases/today', {
      headers: { 'x-tenant-slug': 'alfa' },
    });
    expect(tenantRefDesdeRequest(request)).toEqual({ tenantSlug: 'alfa' });
  });

  it('sin cabecera se usa el tenant por defecto', () => {
    const request = new Request('https://arkangel.test/api/v1/cases/today');
    expect(tenantRefDesdeRequest(request)).toEqual({});
  });
});
