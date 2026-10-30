import { describe, expect, it } from 'vitest';
import {
  registrarConsentimiento,
  registrarOptOut,
  estaSuprimido,
  obtenerHechoConsentimiento,
  procesarInboundOptOut,
} from '../src/services/comunicacion';
import type { Env } from '../src/types/env';

interface MockStore {
  comm_consents: any[];
  comm_suppressions: any[];
  comm_templates: any[];
  comm_envios: any[];
  tenants: any[];
}

function mockEnvWithD1(): { env: Env; store: MockStore } {
  const store: MockStore = {
    comm_consents: [],
    comm_suppressions: [],
    comm_templates: [],
    comm_envios: [],
    tenants: [
      {
        id: 'canaco_merida',
        nombre: 'CANACO SERVYTUR Mérida',
        marca_comercial: 'CANACO SERVYTUR Mérida',
        comm_max_por_semana: 2,
        comm_optout_scope: 'marca',
        parent_tenant_id: null,
      },
    ],
  };

  const env = {
    DB: {
      prepare: (sql: string) => {
        return {
          bind: (...args: any[]) => {
            return {
              first: async <T>() => {
                if (sql.includes('FROM comm_consents')) {
                  const [tid, contacto, channel, cat] = args;
                  const found = store.comm_consents.find(
                    (c) =>
                      c.tenant_id === tid &&
                      c.contacto === contacto &&
                      c.channel === channel &&
                      c.categoria === cat
                  );
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM comm_suppressions')) {
                  const [tid, contacto] = args;
                  const found = store.comm_suppressions.find(
                    (s) => s.tenant_id === tid && s.contacto === contacto
                  );
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM comm_envios')) {
                  const [contacto] = args;
                  const found = [...store.comm_envios]
                    .reverse()
                    .find((e) => e.contacto === contacto);
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM tenants WHERE id = ?')) {
                  const [tid] = args;
                  const found = store.tenants.find((t) => t.id === tid);
                  return (found ?? null) as T;
                }
                return null as T;
              },
              all: async <T>() => {
                if (sql.includes('WHERE parent_tenant_id = ?')) {
                  const [pid] = args;
                  const matches = store.tenants.filter((t) => t.parent_tenant_id === pid);
                  return { results: matches.map((m) => ({ id: m.id })) as T[] };
                }
                return { results: [] };
              },
              run: async () => {
                if (sql.includes('INSERT INTO comm_consents')) {
                  const [id, tid, contacto, channel, cat, optInAt, src, evidence] = args;
                  const idx = store.comm_consents.findIndex(
                    (c) =>
                      c.tenant_id === tid &&
                      c.contacto === contacto &&
                      c.channel === channel &&
                      c.categoria === cat
                  );
                  const row = {
                    id,
                    tenant_id: tid,
                    contacto,
                    channel,
                    categoria: cat,
                    opt_in_at: optInAt,
                    opt_in_source: src,
                    evidence,
                    revoked_at: null,
                  };
                  if (idx >= 0) {
                    store.comm_consents[idx] = row;
                  } else {
                    store.comm_consents.push(row);
                  }
                }
                if (sql.includes('INSERT OR IGNORE INTO comm_suppressions')) {
                  const [id, tid, contacto, reason, detail, created_at] = args;
                  const exists = store.comm_suppressions.some(
                    (s) => s.tenant_id === tid && s.contacto === contacto
                  );
                  if (!exists) {
                    store.comm_suppressions.push({
                      id,
                      tenant_id: tid,
                      contacto,
                      reason,
                      detail,
                      created_at,
                    });
                  }
                }
                if (sql.includes('UPDATE comm_consents') && sql.includes('SET revoked_at')) {
                  const [revokedAt, src, tid, contacto] = args;
                  for (const c of store.comm_consents) {
                    if (c.tenant_id === tid && c.contacto === contacto) {
                      c.revoked_at = revokedAt;
                      c.revoked_source = src;
                    }
                  }
                }
                return { success: true };
              },
            };
          },
        };
      },
    } as any,
  } as Env;

  return { env, store };
}

describe('Servicios y Gobernanza de Opt-in / Opt-out', () => {
  it('registra y consulta consentimiento verificado', async () => {
    const { env } = mockEnvWithD1();

    await registrarConsentimiento(env, {
      tenantId: 'canaco_merida',
      contacto: '+529991234567',
      channel: 'whatsapp',
      categoria: 'marketing',
      optInSource: 'web_form_siem',
      evidence: { ip: '187.12.34.56' },
    });

    const hecho = await obtenerHechoConsentimiento(
      env,
      'canaco_merida',
      '+529991234567',
      'whatsapp',
      'marketing'
    );
    expect(hecho).not.toBeNull();
    expect(hecho?.optInSource).toBe('web_form_siem');
    expect(hecho?.revokedAt).toBeNull();
  });

  it('procesa Opt-out de baja directa suprimiendo el contacto y revocando consentimiento', async () => {
    const { env, store } = mockEnvWithD1();

    // 1. Dar de alta consentimiento previo
    await registrarConsentimiento(env, {
      tenantId: 'canaco_merida',
      contacto: '+529991234567',
      channel: 'whatsapp',
      categoria: 'marketing',
      optInSource: 'web_form',
    });

    // Simular que recibió un mensaje previo de esa marca
    store.comm_envios.push({
      contacto: '+529991234567',
      tenant_id: 'canaco_merida',
      org_tenant_id: 'canaco_merida',
    });

    // 2. El usuario envía "BAJA" por WhatsApp
    const res = await procesarInboundOptOut(env, '+529991234567', '  BAJA  ');
    expect(res.handled).toBe(true);

    // 3. Verificar que está suprimido
    const suprimido = await estaSuprimido(env, 'canaco_merida', '+529991234567');
    expect(suprimido).toBe(true);

    // 4. Verificar que el opt-in quedó revocado
    const hecho = await obtenerHechoConsentimiento(
      env,
      'canaco_merida',
      '+529991234567',
      'whatsapp',
      'marketing'
    );
    expect(hecho?.revokedAt).toBeDefined();
    expect(hecho?.revokedAt).not.toBeNull();
  });

  it('Opt-out con scope organización aplica la baja a la cámara y a todos sus socios', async () => {
    const { env, store } = mockEnvWithD1();
    // Añadir dos socios que cuelgan de canaco_merida
    store.tenants.push(
      { id: 'socio_1', parent_tenant_id: 'canaco_merida' },
      { id: 'socio_2', parent_tenant_id: 'canaco_merida' }
    );

    const afectados = await registrarOptOut(env, {
      contacto: '+529998887766',
      tenantId: 'socio_1',
      orgId: 'canaco_merida',
      scope: 'organizacion',
      reason: 'opt_out',
    });

    expect(afectados).toEqual(['canaco_merida', 'socio_1', 'socio_2']);
    expect(await estaSuprimido(env, 'socio_1', '+529998887766')).toBe(true);
    expect(await estaSuprimido(env, 'socio_2', '+529998887766')).toBe(true);
    expect(await estaSuprimido(env, 'canaco_merida', '+529998887766')).toBe(true);
  });
});
