import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { comunicacion } from '../src/routes/comunicacion';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

describe('Ark Commerce ↔ Arkangel E2E Integration Bridge', () => {
  it('permite que un worker de commerce invoque Arkangel vía internal-service token', async () => {
    const store = {
      comm_consents: [] as any[],
      comm_suppressions: [] as any[],
      comm_templates: [] as any[],
      comm_envios: [] as any[],
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

    const arkangelEnv = {
      ADMIN_TOKEN: 'secret_admin_token',
      TELNYX_API_KEY: 'KEY_TELNYX_MOCK',
      TELNYX_WHATSAPP_FROM: '+15551234567',
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
                    return null as T;
                  }
                  return null as T;
                },
                all: async <T>() => {
                  return { results: [] as T[] };
                },
                run: async () => {
                  if (sql.includes('INSERT INTO comm_consents')) {
                    store.comm_consents.push(args);
                  }
                  if (sql.includes('INSERT INTO comm_envios')) {
                    store.comm_envios.push(args);
                  }
                  return { success: true };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;

    // 1. Simular la app Hono de Arkangel
    const arkangelApp = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    arkangelApp.route('/api/v1', comunicacion);

    // 2. Simular el Service Binding ARKANGEL disponible en ark-commerce
    const mockArkangelBinding = {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const reqUrl =
          typeof url === 'string' ? new URL(url) : url instanceof URL ? url : new URL(url.url);
        return arkangelApp.request(reqUrl.pathname, init, arkangelEnv);
      },
    };

    // 3. Simular el entorno de ark-commerce llamando a notificarArkangel
    const commerceEnv = {
      ARKANGEL: mockArkangelBinding,
      ARKANGEL_ADMIN_TOKEN: 'arkangel_internal_service',
    };

    // 4. Ejecutar el checkout notification exactamente como lo hace ark-commerce
    const orderPayload = {
      version: 'TRANSACTIONAL_DISPATCH_V1' as const,
      tenant_id: 'temozonia',
      channel: 'whatsapp' as const,
      proposito: 'transaccional' as const,
      tipo: 'order_confirmation' as const,
      order_id: 'ORD-TEST-999',
      to: '+529994918221',
      body: '¡Hola Juan! Tu pedido #ORD-TEST-999 en Temozonia ha sido confirmado por un total de $750.00 MXN.',
      dry_run: true,
      variables: {
        nombre: 'Juan',
        orden: 'ORD-TEST-999',
        total: '$750.00 MXN',
      },
    };

    const res = await commerceEnv.ARKANGEL.fetch('http://arkangel/api/v1/comunicacion/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${commerceEnv.ARKANGEL_ADMIN_TOKEN}`,
        'X-Tenant-Id': orderPayload.tenant_id,
      },
      body: JSON.stringify(orderPayload),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.channel).toBe('whatsapp');
    expect(data.status).toBe('sent');
    expect(data.message_id).toBeDefined();

    // 5. Verificar que Arkangel auditó el envío y registró el consentimiento
    expect(store.comm_consents.length).toBe(1);
    expect(store.comm_envios.length).toBe(1);
  });
});
