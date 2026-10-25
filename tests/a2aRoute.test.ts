import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { a2a } from '../src/routes/a2a';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

class FakeRouteD1 {
  cases = [
    {
      id: 'cas_500',
      tenant_id: 't_arkangel',
      client_id: 'cli_500',
      amount_cents: 2000000, // $20,000.00 MXN
      status: 'ready',
      name: 'Carlos Slim Helú',
      phone: '+525500001111',
      email: 'carlos@ejemplo.com',
    },
  ];

  clients = [
    {
      id: 'cli_500',
      tenant_id: 't_arkangel',
      name: 'Carlos Slim Helú',
      phone: '+525500001111',
      email: 'carlos@ejemplo.com',
      curp: 'SLHC400128HDFLLN00',
      rfc: 'SLHC400128ABC',
      auth_pin: '7788',
    },
  ];

  tenants = [
    {
      id: 't_arkangel',
      slug: 'arkangel',
      nombre: 'Cobranza Arkangel',
      status: 'active',
      config_mode: 'db',
      razon_social: 'Cobranza Arkangel S.A. de C.V.',
      condusef_registro: 'CONDUSEF-2026-99',
      allowed_payment_domains: 'arkangel.site',
      tz: 'America/Mexico_City',
      send_window_start: 7,
      send_window_end: 21,
      max_contacts_per_day: 3,
      legal_monto_tolerancia_cents: 0,
      legal_horario_en_respuestas: 0,
      rate_limit_rpm: 60,
      dedupe_window_hours: 24,
      score_amount_ceiling_cents: 500000,
      agent_mode: 'supervised',
      agent_auto_threshold_cents: 200000,
      dry_run: 0,
      cron_auto_fire: 0,
      is_default: 1,
      a2a_enabled: 1,
      a2a_max_discount_pct: 35, // 35% descuento máx.
      a2a_max_installments: 3,
      a2a_min_down_payment_pct: 40,
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
    },
  ];

  contracts = [
    {
      id: 'con_500',
      tenant_id: 't_arkangel',
      client_id: 'cli_500',
      monto_pactado_cents: 2000000,
      tasa_pct: 2.0,
      clabe: '646180999988887776',
      nombre_legal: 'Cobranza Arkangel S.A. de C.V.',
      condusef: 'CONDUSEF-2026-99',
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
    },
  ];

  agreements: Record<string, any>[] = [];
  promises: Record<string, any>[] = [];

  prepare = (sql: string) => {
    const clean = sql.replace(/\s+/g, ' ').trim();
    const run = (args: any[]) => ({
      first: async () => this.first(clean, args),
      all: async () => ({ results: this.all(clean, args) }),
      run: async () => {
        this.exec(clean, args);
        return { success: true };
      },
    });
    return { ...run([]), bind: (...args: any[]) => run(args) };
  };

  first(sql: string, args: any[]): any {
    if (sql.includes('FROM tenants')) {
      if (sql.includes('is_default = 1') || sql.includes('WHERE id = ?')) {
        return this.tenants[0] ?? null;
      }
      return this.tenants.find((t) => t.id === args[0] || t.slug === args[0]) ?? null;
    }
    if (sql.includes('FROM cases WHERE tenant_id = ? AND id = ?')) {
      return this.cases.find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
    }
    if (sql.includes('FROM clients WHERE tenant_id = ? AND id = ?')) {
      return this.clients.find((c) => c.tenant_id === args[0] && c.id === args[1]) ?? null;
    }
    if (sql.includes('FROM contracts WHERE tenant_id = ? AND client_id = ?')) {
      return this.contracts.find((c) => c.tenant_id === args[0] && c.client_id === args[1]) ?? null;
    }
    if (sql.includes('FROM a2a_agreements WHERE tenant_id = ? AND id = ?')) {
      return this.agreements.find((a) => a.tenant_id === args[0] && a.id === args[1]) ?? null;
    }
    return null;
  }

  all(sql: string, _args: any[]): any[] {
    if (sql.includes('FROM tenant_channels')) {
      return [];
    }
    return [];
  }

  exec(sql: string, args: any[]) {
    if (sql.includes('INSERT INTO a2a_agreements')) {
      const [
        id,
        tenant_id,
        case_id,
        client_id,
        original_amount_cents,
        agreed_amount_cents,
        discount_pct,
        installments,
        clabe,
        expires_at,
        agent_id,
        one_click_url,
        created_at,
        updated_at,
      ] = args;
      this.agreements.push({
        id,
        tenant_id,
        case_id,
        client_id,
        original_amount_cents,
        agreed_amount_cents,
        discount_pct,
        installments,
        status: 'pending',
        clabe,
        expires_at,
        agent_id,
        one_click_url,
        created_at,
        updated_at,
      });
    }
    if (sql.includes('INSERT INTO promises')) {
      this.promises.push({ args });
    }
  }
}

function createTestApp(db: FakeRouteD1) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  app.route('/api/v1/a2a', a2a);
  return {
    fetch: (req: Request) =>
      app.fetch(req, {
        DB: db as any,
        ADMIN_TOKEN: 'adm_sec',
        INTAKE_TOKEN: 'int_sec',
        GROK_BOT_TOKEN: 'grk_sec',
      } as any),
  };
}

describe('Rutas HTTP y MCP Protocolo A2A (/api/v1/a2a)', () => {
  it('POST /auth rechaza llamadas sin credenciales o incorrectas (401)', async () => {
    const db = new FakeRouteD1();
    const app = createTestApp(db);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/a2a/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: 'cas_500', pin: '0000' }),
      })
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.verified).toBe(false);
    expect(json.error).toBe('auth_failed');
  });

  it('POST /auth autentica con PIN correcto y devuelve resumen protegido (200)', async () => {
    const db = new FakeRouteD1();
    const app = createTestApp(db);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/a2a/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: 'cas_500', pin: '7788' }),
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.verified).toBe(true);
    expect(json.sessionToken).toBeDefined();
    expect(json.debtorSummary.totalDebtCents).toBe(2000000);
    expect(json.debtorSummary.maskedName).toBe('C***** S*** H***');
  });

  it('GET /terms/:caseId devuelve opciones de negociación autorizadas', async () => {
    const db = new FakeRouteD1();
    const app = createTestApp(db);

    const res = await app.fetch(
      new Request('http://localhost/api/v1/a2a/terms/cas_500', {
        method: 'GET',
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.totalDebtCents).toBe(2000000);
    expect(json.maxDiscountPct).toBe(35);
    expect(json.minSettlementCents).toBe(1300000); // 35% de descuento en $20,000 = $13,000
  });

  it('POST /negotiate formaliza acuerdo cuando la oferta del agente es viable', async () => {
    const db = new FakeRouteD1();
    const app = createTestApp(db);

    // Mínimo aceptable $13,000. El agente ofrece $14,000 en 1 pago.
    const res = await app.fetch(
      new Request('http://localhost/api/v1/a2a/negotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: 'cas_500',
          proposedAmountCents: 1400000,
          installments: 1,
          agentId: 'claude-desktop-user-proxy',
        }),
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.accepted).toBe(true);
    expect(json.status).toBe('agreement_accepted');
    expect(json.agreement.agreedAmountCents).toBe(1400000);
    expect(json.agreement.clabe).toBe('646180999988887776');
    expect(json.agreement.oneClickConfirmationUrl).toContain('/pay/');
  });

  it('POST /negotiate devuelve contraoferta matemática si la propuesta está por debajo del umbral', async () => {
    const db = new FakeRouteD1();
    const app = createTestApp(db);

    // El agente propone pagar $5,000 MXN en una deuda de $20,000 (75% de descuento, fuera de política).
    const res = await app.fetch(
      new Request('http://localhost/api/v1/a2a/negotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: 'cas_500',
          proposedAmountCents: 500000,
          installments: 1,
          agentId: 'lowball-bot',
        }),
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.accepted).toBe(false);
    expect(json.status).toBe('counter_offer');
    expect(json.counterOffer.minSinglePaymentCents).toBe(1300000);
  });

  describe('Model Context Protocol (MCP) Interface (POST /api/v1/a2a/mcp)', () => {
    it('tools/list entrega el catálogo de tools para clientes de IA', async () => {
      const db = new FakeRouteD1();
      const app = createTestApp(db);

      const res = await app.fetch(
        new Request('http://localhost/api/v1/a2a/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          }),
        })
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.result.tools).toHaveLength(4);
      const toolNames = json.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('arkangel_a2a_auth');
      expect(toolNames).toContain('arkangel_a2a_get_terms');
      expect(toolNames).toContain('arkangel_a2a_submit_offer');
      expect(toolNames).toContain('arkangel_a2a_get_agreement');
    });

    it('tools/call ejecuta arkangel_a2a_auth y devuelve formato de contenido MCP', async () => {
      const db = new FakeRouteD1();
      const app = createTestApp(db);

      const res = await app.fetch(
        new Request('http://localhost/api/v1/a2a/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'arkangel_a2a_auth',
              arguments: {
                caseId: 'cas_500',
                pin: '7788',
              },
            },
          }),
        })
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.result.content[0].type).toBe('text');
      const textParsed = JSON.parse(json.result.content[0].text);
      expect(textParsed.verified).toBe(true);
      expect(textParsed.debtorSummary.totalDebtCents).toBe(2000000);
    });

    it('tools/call ejecuta arkangel_a2a_submit_offer generando el convenio', async () => {
      const db = new FakeRouteD1();
      const app = createTestApp(db);

      const res = await app.fetch(
        new Request('http://localhost/api/v1/a2a/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'arkangel_a2a_submit_offer',
              arguments: {
                caseId: 'cas_500',
                proposedAmountCents: 1500000,
                installments: 1,
                agentId: 'openai-custom-gpts',
              },
            },
          }),
        })
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      const parsed = JSON.parse(json.result.content[0].text);
      expect(parsed.accepted).toBe(true);
      expect(parsed.agreement.clabe).toBe('646180999988887776');
    });
  });
});
