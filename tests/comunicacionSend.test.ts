import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { comunicacion } from '../src/routes/comunicacion';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

interface MockStore {
  comm_consents: any[];
  comm_suppressions: any[];
  comm_templates: any[];
  comm_envios: any[];
  tenants: any[];
}

function createMockEnv(): { env: Env; store: MockStore } {
  const store: MockStore = {
    comm_consents: [],
    comm_suppressions: [],
    comm_templates: [
      {
        id: 'tmpl_order_confirmation',
        tenant_id: 'temozonia',
        channel: 'whatsapp',
        nombre: 'Confirmación de Orden',
        meta_name: 'order_confirmation_v1',
        lang: 'es_MX',
        categoria: 'transaccional',
        status: 'APPROVED',
        subject: null,
        body_preview:
          'Hola {{nombre}}, tu pedido #{{orden}} por {{total}} ha sido confirmado en {{marca}}.',
        variables_json: JSON.stringify(['nombre', 'orden', 'total']),
        shared: 0,
      },
    ],
    comm_envios: [],
    tenants: [
      {
        id: 'temozonia',
        slug: 'temozonia',
        nombre: 'Temozonia Carnes Ahumadas',
        status: 'active',
        config_mode: 'db',
        razon_social: 'TEMOZONIA CARNES AHUMADAS ARTESANALES S.A. DE C.V.',
        condusef_registro: 'COM-TEM-2026',
        allowed_payment_domains: 'tiendas.arksystems.site',
        tz: 'America/Merida',
        send_window_start: 8,
        send_window_end: 20,
        max_contacts_per_day: 5,
        legal_monto_tolerancia_cents: 0,
        legal_horario_en_respuestas: 0,
        rate_limit_rpm: 60,
        dedupe_window_hours: 24,
        score_amount_ceiling_cents: 100000,
        agent_mode: 'auto',
        agent_auto_threshold_cents: 50000,
      },
    ],
  };

  const env = {
    ADMIN_TOKEN: 'secret_admin_token_123',
    TELNYX_API_KEY: 'KEY_TELNYX_TEST',
    TELNYX_WHATSAPP_FROM: '+15550001111',
    DRY_RUN: 'true',
    DB: {
      prepare: (sql: string) => {
        return {
          bind: (...args: any[]) => {
            return {
              first: async <T>() => {
                if (sql.includes('FROM tenants WHERE id = ?')) {
                  const [tid] = args;
                  const found = store.tenants.find((t) => t.id === tid);
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM tenants WHERE slug = ?')) {
                  const [slug] = args;
                  const found = store.tenants.find((t) => t.slug === slug);
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM comm_suppressions')) {
                  const [tid, contacto] = args;
                  const found = store.comm_suppressions.find(
                    (s) => s.tenant_id === tid && s.contacto === contacto
                  );
                  return (found ?? null) as T;
                }
                if (sql.includes('FROM comm_templates')) {
                  const [id, tid] = args;
                  const found = store.comm_templates.find(
                    (t) => t.id === id && t.tenant_id === tid
                  );
                  return (found ?? null) as T;
                }
                return null as T;
              },
              all: async <T>() => {
                if (sql.includes('FROM tenants WHERE parent_tenant_id = ?')) {
                  return { results: [] as T[] };
                }
                return { results: [] as T[] };
              },
              run: async () => {
                if (sql.includes('INSERT INTO comm_consents')) {
                  const [id, tid, contacto, channel, cat, optInAt, optInSource, evidence] = args;
                  store.comm_consents.push({
                    id,
                    tenant_id: tid,
                    contacto,
                    channel,
                    categoria: cat,
                    opt_in_at: optInAt,
                    opt_in_source: optInSource,
                    evidence,
                  });
                }
                if (sql.includes('INSERT INTO comm_envios')) {
                  const [
                    id,
                    tid,
                    orgId,
                    contacto,
                    channel,
                    templateId,
                    proposito,
                    status,
                    motivo,
                    providerId,
                    createdAt,
                    updatedAt,
                  ] = args;
                  store.comm_envios.push({
                    id,
                    tenant_id: tid,
                    org_tenant_id: orgId,
                    contacto,
                    channel,
                    template_id: templateId,
                    categoria: proposito,
                    status,
                    motivo,
                    provider_id: providerId,
                    created_at: createdAt,
                    updated_at: updatedAt,
                  });
                }
                return { success: true };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, store };
}

describe('POST /comunicacion/send — Tubería Transaccional para Ark Commerce', () => {
  it('rechaza llamadas sin token de autorización (401)', async () => {
    const { env } = createMockEnv();
    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/', comunicacion);

    const res = await app.request(
      '/comunicacion/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'temozonia',
          to: '+529991234567',
          channel: 'whatsapp',
        }),
      },
      env
    );

    expect(res.status).toBe(401);
  });

  it('procesa una confirmación de orden transaccional e inserta en comm_envios y comm_consents', async () => {
    const { env, store } = createMockEnv();
    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/', comunicacion);

    const payload = {
      version: 'TRANSACTIONAL_DISPATCH_V1',
      tenant_id: 'temozonia',
      channel: 'whatsapp',
      to: '9991234567',
      proposito: 'transaccional',
      tipo: 'order_confirmation',
      order_id: 'ORD-8812',
      body: '¡Hola Carlos! Tu pedido #ORD-8812 de Temozonia fue confirmado por $950.00 MXN.',
      dry_run: true,
      variables: {
        nombre: 'Carlos',
        orden: 'ORD-8812',
        total: '$950.00 MXN',
      },
    };

    const res = await app.request(
      '/comunicacion/send',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret_admin_token_123',
          'X-Tenant-Id': 'temozonia',
        },
        body: JSON.stringify(payload),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.channel).toBe('whatsapp');
    expect(body.status).toBe('sent');
    expect(body.message_id).toBeDefined();

    // Validar que se registró el consentimiento automático de la transacción
    expect(store.comm_consents.length).toBe(1);
    expect(store.comm_consents[0].tenant_id).toBe('temozonia');
    expect(store.comm_consents[0].contacto).toBe('+529991234567');
    expect(store.comm_consents[0].opt_in_source).toBe('ecommerce_order');

    // Validar bitácora comm_envios
    expect(store.comm_envios.length).toBe(1);
    expect(store.comm_envios[0].contacto).toBe('+529991234567');
    expect(store.comm_envios[0].status).toBe('sent');
  });

  it('bloquea el envío si el contacto está en la lista de supresión / opt-out (403)', async () => {
    const { env, store } = createMockEnv();
    store.comm_suppressions.push({
      id: 'supp_1',
      tenant_id: 'temozonia',
      contacto: '+529991234567',
      reason: 'opt_out',
    });

    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/', comunicacion);

    const payload = {
      tenant_id: 'temozonia',
      channel: 'whatsapp',
      to: '+529991234567',
      proposito: 'transaccional',
      tipo: 'order_confirmation',
      order_id: 'ORD-8813',
      body: 'Tu orden está lista',
      dry_run: true,
    };

    const res = await app.request(
      '/comunicacion/send',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret_admin_token_123',
          'X-Tenant-Id': 'temozonia',
        },
        body: JSON.stringify(payload),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.motivo).toBe('suprimido');
  });
});
