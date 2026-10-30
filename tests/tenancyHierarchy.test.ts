import { describe, expect, it } from 'vitest';
import {
  resolverOrganizacion,
  canalesEfectivos,
  idsDeLaOrganizacion,
  JerarquiaInvalidaError,
} from '../src/tenancy/jerarquia';
import type { Tenant, TenantChannel } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

function mockTenant(overrides: Partial<Tenant>): Tenant {
  return {
    id: 't_base',
    slug: 'base',
    nombre: 'Base',
    status: 'active',
    config_mode: 'db',
    razon_social: 'Base S.A.',
    condusef_registro: '123',
    allowed_payment_domains: '',
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
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
    tenant_level: 'organizacion',
    ...overrides,
  };
}

function mockEnvWithTenants(
  tenants: Record<string, Tenant>,
  channels: Record<string, TenantChannel[]> = {},
  sociosByParent: Record<string, string[]> = {}
): Env {
  return {
    DB: {
      prepare: (sql: string) => {
        return {
          bind: (...args: any[]) => {
            return {
              first: async <T>() => {
                if (sql.includes('FROM tenants WHERE id = ?')) {
                  const id = args[0];
                  return (tenants[id] ?? null) as T;
                }
                return null as T;
              },
              all: async <T>() => {
                if (sql.includes('FROM tenant_channels WHERE tenant_id = ?')) {
                  const id = args[0];
                  return { results: (channels[id] ?? []) as T[] };
                }
                if (sql.includes('WHERE parent_tenant_id = ?')) {
                  const parentId = args[0];
                  const ids = (sociosByParent[parentId] ?? []).map((id) => ({ id }));
                  return { results: ids as T[] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    } as any,
  } as Env;
}

describe('Jerarquía de Tenants (Cámara -> Socio)', () => {
  it('una organización sin padre es su propia organización', async () => {
    const camara = mockTenant({
      id: 'canaco_merida',
      tenant_level: 'organizacion',
      parent_tenant_id: null,
    });
    const env = mockEnvWithTenants({ canaco_merida: camara });

    const res = await resolverOrganizacion(env, camara);
    expect(res.id).toBe('canaco_merida');
  });

  it('un socio resuelve a su cámara u organización padre', async () => {
    const camara = mockTenant({ id: 'canaco_merida', tenant_level: 'organizacion' });
    const socio = mockTenant({
      id: 'socio_zapateria',
      tenant_level: 'socio',
      parent_tenant_id: 'canaco_merida',
    });
    const env = mockEnvWithTenants({ canaco_merida: camara, socio_zapateria: socio });

    const res = await resolverOrganizacion(env, socio);
    expect(res.id).toBe('canaco_merida');
  });

  it('falla fail-closed si el padre del socio no existe o está suspendido', async () => {
    const socioSinPadre = mockTenant({
      id: 's1',
      tenant_level: 'socio',
      parent_tenant_id: 'padre_fantasma',
    });
    const env1 = mockEnvWithTenants({ s1: socioSinPadre });
    await expect(resolverOrganizacion(env1, socioSinPadre)).rejects.toThrow(JerarquiaInvalidaError);

    const padreSuspendido = mockTenant({
      id: 'p_susp',
      status: 'suspended',
      tenant_level: 'organizacion',
    });
    const socioConPadreSusp = mockTenant({
      id: 's2',
      tenant_level: 'socio',
      parent_tenant_id: 'p_susp',
    });
    const env2 = mockEnvWithTenants({ p_susp: padreSuspendido, s2: socioConPadreSusp });
    await expect(resolverOrganizacion(env2, socioConPadreSusp)).rejects.toThrow(
      JerarquiaInvalidaError
    );
  });

  it('falla fail-closed si hay un ciclo en la jerarquía', async () => {
    const cicloA = mockTenant({ id: 'a', tenant_level: 'socio', parent_tenant_id: 'b' });
    const cicloB = mockTenant({ id: 'b', tenant_level: 'socio', parent_tenant_id: 'a' });
    const env = mockEnvWithTenants({ a: cicloA, b: cicloB });
    await expect(resolverOrganizacion(env, cicloA)).rejects.toThrow(JerarquiaInvalidaError);
  });

  it('canalesEfectivos: socio hereda canales de la cámara si no tiene propios', async () => {
    const camara = mockTenant({ id: 'canaco_merida', tenant_level: 'organizacion' });
    const socio = mockTenant({
      id: 'socio_1',
      tenant_level: 'socio',
      parent_tenant_id: 'canaco_merida',
    });

    const chCamaraWa: TenantChannel = {
      id: 'tc_c_wa',
      tenant_id: 'canaco_merida',
      channel: 'whatsapp',
      provider_account_id: 'waba_camara',
      credentials: null,
      status: 'active',
      created_at: '2026-10-20',
    };
    const chCamaraSms: TenantChannel = {
      id: 'tc_c_sms',
      tenant_id: 'canaco_merida',
      channel: 'sms',
      provider_account_id: 'prof_camara',
      credentials: null,
      status: 'active',
      created_at: '2026-10-20',
    };

    const env = mockEnvWithTenants(
      { canaco_merida: camara, socio_1: socio },
      {
        canaco_merida: [chCamaraWa, chCamaraSms],
        socio_1: [],
      }
    );

    const canales = await canalesEfectivos(env, socio, camara);
    expect(canales).toHaveLength(2);
    expect(canales.map((c) => c.channel)).toEqual(['whatsapp', 'sms']);
  });

  it('canalesEfectivos: canal propio del socio sobreescribe al de la cámara', async () => {
    const camara = mockTenant({ id: 'canaco_merida', tenant_level: 'organizacion' });
    const socio = mockTenant({
      id: 'socio_1',
      tenant_level: 'socio',
      parent_tenant_id: 'canaco_merida',
    });

    const chCamaraWa: TenantChannel = {
      id: 'tc_c_wa',
      tenant_id: 'canaco_merida',
      channel: 'whatsapp',
      provider_account_id: 'waba_camara',
      credentials: null,
      status: 'active',
      created_at: '2026-10-20',
    };
    const chSocioWa: TenantChannel = {
      id: 'tc_s_wa',
      tenant_id: 'socio_1',
      channel: 'whatsapp',
      provider_account_id: 'waba_propio_socio',
      credentials: null,
      status: 'active',
      created_at: '2026-10-21',
    };

    const env = mockEnvWithTenants(
      { canaco_merida: camara, socio_1: socio },
      {
        canaco_merida: [chCamaraWa],
        socio_1: [chSocioWa],
      }
    );

    const canales = await canalesEfectivos(env, socio, camara);
    expect(canales).toHaveLength(1);
    expect(canales[0]?.provider_account_id).toBe('waba_propio_socio');
  });

  it('idsDeLaOrganizacion: incluye a la cámara y a todos sus socios', async () => {
    const env = mockEnvWithTenants({}, {}, { canaco_merida: ['s1', 's2', 's3'] });
    const ids = await idsDeLaOrganizacion(env, 'canaco_merida');
    expect(ids).toEqual(['canaco_merida', 's1', 's2', 's3']);
  });
});
