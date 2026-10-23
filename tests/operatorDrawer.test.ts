import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { agent } from '../src/routes/agent';
import { api } from '../src/routes/api';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

class FakeOperatorD1 {
  cases = [
    {
      id: 'cas_1',
      tenant_id: 't_arkangel',
      case_date: '2026-10-22',
      client_id: 'cli_1',
      debt_id: 'deb_1',
      name: 'Juan Pérez',
      phone: '+525512345678',
      email: 'juan@ejemplo.com',
      amount_cents: 150000,
      status: 'human',
      score: 78,
      score_band: 'alta',
      channel_state: '{}',
      source: 'csv',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  clients = [
    {
      id: 'cli_1',
      tenant_id: 't_arkangel',
      name: 'Juan Pérez',
      phone: '+525512345678',
      email: 'juan@ejemplo.com',
      curp: 'PERJ800101HDFRNN01',
      whatsapp_opt_in: 1,
      sms_opt_in: 1,
      email_opt_in: 1,
      do_not_disturb: 0,
      source: 'csv',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  contracts = [
    {
      id: 'con_1',
      tenant_id: 't_arkangel',
      client_id: 'cli_1',
      monto_pactado_cents: 150000,
      tasa_pct: 12,
      clabe: '012180001234567899',
      nombre_legal: 'Arkangel S.A. de C.V.',
      condusef: 'REDECO-001',
      created_at: '2026-10-22T12:00:00Z',
      updated_at: '2026-10-22T12:00:00Z',
    },
  ];
  messages: Record<string, unknown>[] = [];
  promises: Record<string, unknown>[] = [];
  audits: Record<string, unknown>[] = [];
  tenants: Record<string, unknown>[] = [];
  users: Record<string, unknown>[] = [];
  memberships: Record<string, unknown>[] = [];
  tokens: Record<string, unknown>[] = [];
  tenantChannels: Record<string, unknown>[] = [];
  contractCfdis: Record<string, unknown>[] = [];

  prepare = (sql: string) => {
    const clean = sql.replace(/\s+/g, ' ').trim();
    const run = (args: unknown[]) => ({
      first: async () => this.first(clean, args),
      all: async () => ({ results: this.all(clean, args) }),
      run: async () => {
        this.exec(clean, args);
        return { success: true };
      },
    });
    return { ...run([]), bind: (...args: unknown[]) => run(args) };
  };

  first(sql: string, args: unknown[]): unknown {
    if (sql.includes('FROM tenants')) {
      if (this.tenants.length === 0) {
        throw new Error('D1_ERROR: no such table: tenants');
      }
      if (sql.includes('is_default = 1')) {
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
    if (sql.includes('FROM contract_cfdi WHERE tenant_id = ? AND contract_id = ?')) {
      return (
        this.contractCfdis.find(
          (row) => row.tenant_id === args[0] && row.contract_id === args[1]
        ) ?? null
      );
    }
    if (sql.includes('COUNT(*) AS total FROM messages')) {
      return { total: 1 };
    }
    if (sql.includes('COUNT(*) AS total FROM clients')) {
      return { total: this.clients.length };
    }
    if (sql.includes('SELECT row_hash FROM legal_audit')) {
      return null;
    }
    if (sql.includes('FROM users WHERE lower(email)')) {
      const email = String(args[0]).toLowerCase();
      const u = this.users.find((row) => String(row.email).toLowerCase() === email);
      if (!u) return null;
      return {
        id: u.id,
        email: u.email,
        fullName: u.full_name ?? '',
        passwordHash: u.password_hash ?? null,
        emailVerifiedAt: u.email_verified_at ?? null,
        platformRole: u.platform_role ?? 'user',
      };
    }
    return null;
  }

  all(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM tenant_memberships m JOIN users u')) {
      const tenantId = String(args[0]);
      return this.memberships
        .filter((m) => m.tenant_id === tenantId)
        .map((m) => {
          const u = this.users.find((row) => row.id === m.user_id);
          return {
            userId: m.user_id,
            email: u?.email ?? '',
            fullName: u?.full_name ?? '',
            role: m.role,
            active: u?.password_hash && u?.email_verified_at ? 1 : 0,
            createdAt: m.created_at ?? 0,
          };
        });
    }
    if (sql.includes('FROM debts WHERE tenant_id = ?')) {
      return [
        {
          id: 'deb_1',
          client_id: 'cli_1',
          amount_cents: 150000,
          currency: 'MXN',
          due_date: '2026-10-15',
          status: 'pending',
          created_at: '2026-10-22T12:00:00Z',
          updated_at: '2026-10-22T12:00:00Z',
        },
      ];
    }
    if (sql.includes('FROM messages WHERE tenant_id = ? AND client_id = ?')) {
      return this.messages.filter((m) => m.client_id === args[1]);
    }
    if (sql.includes('FROM tenant_channels WHERE tenant_id = ?')) {
      const tenantId = String(args[0]);
      if (sql.includes("status = 'active'")) {
        return this.tenantChannels.filter((c) => c.tenant_id === tenantId && c.status === 'active');
      }
      return this.tenantChannels.filter((c) => c.tenant_id === tenantId);
    }
    if (sql.includes('FROM cases WHERE tenant_id = ? AND case_date = ?')) {
      return this.cases.filter((c) => c.tenant_id === args[0] && c.case_date === args[1]);
    }
    return [];
  }

  exec(sql: string, args: unknown[]): void {
    if (sql.startsWith('INSERT INTO messages')) {
      this.messages.push({
        id: args[0],
        tenant_id: args[1],
        case_id: args[2],
        client_id: args[3],
        channel: args[4],
        direction: args[5],
        provider_id: args[6],
        body: args[7],
        status: args[8],
        error: args[9],
        meta: args[10],
        created_at: args[11],
      });
    }
    if (sql.startsWith('INSERT INTO promises')) {
      this.promises.push({
        id: args[0],
        tenant_id: args[1],
        case_id: args[2],
        client_id: args[3],
        amount_cents: args[4],
        promised_date: args[5],
      });
    }
    if (sql.startsWith("UPDATE messages SET status = 'promise_made'")) {
      const tenantId = String(args[0]);
      const caseId = String(args[1]);
      const outbound = [...this.messages]
        .reverse()
        .find(
          (m) =>
            m.tenant_id === tenantId &&
            m.case_id === caseId &&
            m.direction === 'outbound' &&
            ['sent', 'delivered', 'read'].includes(String(m.status))
        );
      if (outbound) outbound.status = 'promise_made';
    }
    if (sql.startsWith('INSERT INTO users')) {
      this.users.push({
        id: args[0],
        email: args[1],
        full_name: args[2],
        password_hash: null,
        email_verified_at: null,
        platform_role: 'user',
        created_at: args[3],
      });
    }
    if (sql.startsWith('INSERT INTO tenant_memberships')) {
      const existing = this.memberships.find(
        (m) => m.user_id === args[0] && m.tenant_id === args[1]
      );
      if (existing) {
        existing.role = args[2];
      } else {
        this.memberships.push({
          user_id: args[0],
          tenant_id: args[1],
          role: args[2],
          created_at: args[3],
        });
      }
    }
    if (sql.startsWith('DELETE FROM tenant_memberships')) {
      const tenantId = String(args[0]);
      const userId = String(args[1]);
      this.memberships = this.memberships.filter(
        (m) => !(m.tenant_id === tenantId && m.user_id === userId)
      );
    }
    if (sql.startsWith('INSERT INTO auth_tokens')) {
      this.tokens.push({
        token_hash: args[0],
        user_id: args[1],
        purpose: args[2],
        expires_at: args[3],
      });
    }
    if (sql.startsWith('UPDATE cases SET')) {
      const status = String(args[0]);
      const id = String(args[args.length - 1]);
      const c = this.cases.find((row) => row.id === id);
      if (c) c.status = status;
    }
    if (sql.startsWith('UPDATE clients SET do_not_disturb')) {
      const dnd = Number(args[0]);
      const id = String(args[3]);
      const cl = this.clients.find((row) => row.id === id);
      if (cl) cl.do_not_disturb = dnd;
    }
    if (sql.startsWith('INSERT INTO legal_audit')) {
      this.audits.push({ regla: args[4], accion: args[8] });
    }
    if (sql.startsWith('UPDATE tenants')) {
      const id = String(args[args.length - 1]);
      const t = this.tenants.find((row) => row.id === id);
      if (t) {
        t.nombre = args[0];
        t.config_mode = args[1];
        t.razon_social = args[2];
        t.condusef_registro = args[3];
        t.allowed_payment_domains = args[4];
        t.send_window_start = args[5];
        t.send_window_end = args[6];
        t.max_contacts_per_day = args[7];
        t.rate_limit_rpm = args[8];
        t.agent_mode = args[9];
        t.agent_auto_threshold_cents = args[10];
        t.dry_run = args[11];
      }
    }
    if (sql.startsWith('UPDATE contracts SET nombre_legal')) {
      const tenantId = String(args[2]);
      for (const c of this.contracts) {
        if (c.tenant_id === tenantId) {
          c.nombre_legal = String(args[0]);
          c.condusef = String(args[1]);
        }
      }
    }
    if (sql.startsWith('DELETE FROM tenant_channels WHERE tenant_id = ? AND channel = ?')) {
      const tenantId = String(args[0]);
      const channel = String(args[1]);
      this.tenantChannels = this.tenantChannels.filter(
        (c) => !(c.tenant_id === tenantId && c.channel === channel)
      );
    }
    if (sql.startsWith('INSERT INTO tenant_channels')) {
      this.tenantChannels.push({
        id: args[0],
        tenant_id: args[1],
        channel: args[2],
        provider_account_id: args[3],
        credentials: args[4],
        status: args[5],
        created_at: args[6],
        updated_at: args[7],
      });
    }
    if (sql.startsWith('DELETE FROM contract_cfdi WHERE tenant_id = ? AND contract_id = ?')) {
      const tenantId = String(args[0]);
      const contractId = String(args[1]);
      this.contractCfdis = this.contractCfdis.filter(
        (r) => !(r.tenant_id === tenantId && r.contract_id === contractId)
      );
    }
    if (sql.startsWith('INSERT INTO contract_cfdi')) {
      this.contractCfdis.push({
        id: args[0],
        tenant_id: args[1],
        contract_id: args[2],
        cfdi_uuid: args[3],
        created_at: args[4],
      });
    }
  }
}

function makeEnv(db: FakeOperatorD1): Env {
  return {
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database,
    ADMIN_TOKEN: 'adm_test_token',
    DRY_RUN: 'true',
    TZ: 'America/Mexico_City',
    SEND_WINDOW_START: '0',
    SEND_WINDOW_END: '24',
    MAX_CONTACTS_PER_DAY: '3',
    LEGAL_RAZON_SOCIAL: 'Arkangel S.A. de C.V.',
    LEGAL_CONDUSEF_REGISTRO: 'REDECO-001',
    ALLOWED_PAYMENT_DOMAINS: 'arksystems.site',
    LEGAL_MONTO_TOLERANCIA_CENTS: '0',
    LEGAL_HORARIO_EN_RESPUESTAS: 'false',
  } as unknown as Env;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  app.route('/api/v1', api);
  app.route('/api/v1', agent);
  return app;
}

const AUTH_HEADERS = {
  authorization: 'Bearer adm_test_token',
  'content-type': 'application/json',
};

describe('Drawer del Operador y Softphone (/api/v1/cases/:id/*)', () => {
  it('GET /cases/:id/workspace devuelve caso, cliente, contrato, deudas e historial', async () => {
    const db = new FakeOperatorD1();
    const res = await makeApp().request(
      '/api/v1/cases/cas_1/workspace',
      { headers: AUTH_HEADERS },
      makeEnv(db)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      case: { id: string; status: string };
      contract: { clabe: string };
      contactos_24h: number;
    };
    expect(body.ok).toBe(true);
    expect(body.case.id).toBe('cas_1');
    expect(body.contract.clabe).toBe('012180001234567899');
    expect(body.contactos_24h).toBe(1);
  });

  it('POST /cases/:id/reply bloquea con 422 si el operador humano escribe una amenaza o CLABE apócrifa', async () => {
    const db = new FakeOperatorD1();
    const res = await makeApp().request(
      '/api/v1/cases/cas_1/reply',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          channel: 'whatsapp',
          body: 'De Arkangel S.A. de C.V. (REDECO-001): deposita $1,500 a la CLABE 999999999999999999 hoy mismo.',
        }),
      },
      makeEnv(db)
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; regla: string };
    expect(body.ok).toBe(false);
    expect(body.regla).toBe('3.2');
    expect(db.messages).toHaveLength(0);
    expect(db.audits.length).toBeGreaterThan(0);
  });

  it('POST /cases/:id/reply envía y registra cuando el mensaje humano cumple el Motor Legal', async () => {
    const db = new FakeOperatorD1();
    const res = await makeApp().request(
      '/api/v1/cases/cas_1/reply',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          channel: 'whatsapp',
          body: 'Estimado Juan Pérez, le contactamos de Arkangel S.A. de C.V. (REDECO-001) sobre su saldo de $1,500.00. CLABE: 012180001234567899.',
        }),
      },
      makeEnv(db)
    );
    expect(res.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(String(db.messages[0]?.meta)).toContain('"human_operator":true');
  });

  it('POST /cases/:id/resolve registra promesa humana, cambia el estado a promised y promueve el mensaje saliente a promise_made', async () => {
    const db = new FakeOperatorD1();
    db.messages.push({
      id: 'msg_out_1',
      tenant_id: 't_arkangel',
      case_id: 'cas_1',
      client_id: 'cli_1',
      channel: 'whatsapp',
      direction: 'outbound',
      provider_id: 'wamid.1',
      body: 'Recordatorio de saldo Arkangel S.A. de C.V.',
      status: 'sent',
      error: null,
      meta: null,
      created_at: '2026-10-22T12:00:00Z',
    });

    const res = await makeApp().request(
      '/api/v1/cases/cas_1/resolve',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          action: 'promise',
          promised_date: '2026-10-25',
          promised_amount_cents: 150000,
        }),
      },
      makeEnv(db)
    );
    expect(res.status).toBe(200);
    expect(db.promises).toHaveLength(1);
    expect(db.cases[0]?.status).toBe('promised');
    expect(db.messages[0]?.status).toBe('promise_made');
  });

  it('POST /cases/:id/call inicia llamada auditada con guion CONDUSEF y registra el cierre', async () => {
    const db = new FakeOperatorD1();
    const app = makeApp();
    const env = makeEnv(db);

    const startRes = await app.request(
      '/api/v1/cases/cas_1/call',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ phase: 'start' }),
      },
      env
    );
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as { guion_obligatorio: string };
    expect(startBody.guion_obligatorio).toContain('Arkangel S.A. de C.V.');
    expect(startBody.guion_obligatorio).toContain('REDECO-001');

    const endRes = await app.request(
      '/api/v1/cases/cas_1/call',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          phase: 'complete',
          duration_seconds: 95,
          outcome: 'promesa',
          notes: 'Promete pagar el viernes por SPEI.',
        }),
      },
      env
    );
    expect(endRes.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(String(db.messages[0]?.body)).toContain('Llamada Softphone · 95s');
  });

  it('GET /system/status devuelve telemetría en vivo de D1, Workers AI, Cola, Motor Legal y RPM', async () => {
    const db = new FakeOperatorD1();
    const res = await makeApp().request(
      '/api/v1/system/status?date=2026-10-22',
      { headers: AUTH_HEADERS },
      makeEnv(db)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      d1: { ok: boolean; latency_ms: number; clients_total: number };
      legal_engine: { ok: boolean; reglas_activas: number; conductas_auditadas: number };
      rate_limit: { whatsapp_rpm: number; max_rpm: number };
    };
    expect(body.ok).toBe(true);
    expect(body.d1.ok).toBe(true);
    expect(body.d1.clients_total).toBe(1);
    expect(body.legal_engine.ok).toBe(true);
    expect(body.legal_engine.reglas_activas).toBe(12);
    expect(body.legal_engine.conductas_auditadas).toBe(48);
    expect(body.rate_limit.max_rpm).toBe(42);
  });

  it('POST /copilot/chat responde con contexto del Worker y genera borrador blindado cuando hay caso activo', async () => {
    const db = new FakeOperatorD1();
    const res = await makeApp().request(
      '/api/v1/copilot/chat',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          message: 'Soy nuevo y necesito redactar una respuesta para este caso abierto',
          active_case_id: 'cas_1',
        }),
      },
      makeEnv(db)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reply: string;
      suggested_draft: string | null;
      context_summary: { activeCaseName: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.reply.length).toBeGreaterThan(20);
    expect(body.suggested_draft).toContain('Arkangel S.A. de C.V.');
    expect(body.suggested_draft).toContain('012180001234567899');
    expect(body.context_summary.activeCaseName).toBe('Juan Pérez');
  });

  it('GET y PUT /tenant/settings permiten configurar identidad legal y parámetros operativos desde la UI', async () => {
    const db = new FakeOperatorD1();
    db.tenants.push({
      id: 't_arkangel',
      slug: 'arkangel-default',
      nombre: 'Arkangel Demo',
      razon_social: null,
      condusef_registro: null,
      allowed_payment_domains: 'arksystems.site',
      send_window_start: 8,
      send_window_end: 21,
      max_contacts_per_day: 3,
      rate_limit_rpm: 40,
      dry_run: 1,
      config_mode: 'env_fallback',
      agent_mode: 'assist',
      agent_auto_threshold_cents: 500000,
      status: 'active',
    });

    const app = makeApp();
    const env = makeEnv(db);

    const getRes = await app.request('/api/v1/tenant/settings', { headers: AUTH_HEADERS }, env);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      settings: { tenant_id: string; nombre: string };
      webhooks: { conekta: string; cobre: string };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.settings.tenant_id).toBe('t_arkangel');
    expect(getBody.webhooks.conekta).toContain('/webhooks/conekta');
    expect(getBody.webhooks.cobre).toContain('/webhooks/cobre');

    const putRes = await app.request(
      '/api/v1/tenant/settings',
      {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          nombre: 'Cobranza FinTech MX',
          razon_social: 'Cobranza FinTech S.A.P.I. de C.V.',
          condusef_registro: 'REDECO-2026-9988',
          allowed_payment_domains: 'conekta.com,cobre.co',
          send_window_start: 8,
          send_window_end: 20,
          max_contacts_per_day: 2,
          rate_limit_rpm: 35,
          agent_mode: 'autonomous',
          agent_auto_threshold_cents: 1200000,
          dry_run: false,
        }),
      },
      env
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      ok: boolean;
      settings: {
        razon_social: string;
        condusef_registro: string;
        config_mode: string;
        dry_run: boolean;
      };
    };
    expect(putBody.ok).toBe(true);
    expect(putBody.settings.razon_social).toBe('Cobranza FinTech S.A.P.I. de C.V.');
    expect(putBody.settings.condusef_registro).toBe('REDECO-2026-9988');
    expect(putBody.settings.config_mode).toBe('db');
    expect(putBody.settings.dry_run).toBe(false);
    expect(db.contracts[0]?.nombre_legal).toBe('Cobranza FinTech S.A.P.I. de C.V.');
    expect(db.contracts[0]?.condusef).toBe('REDECO-2026-9988');
  });

  it('POST /tenant/members/invite, GET /tenant/members y DELETE /tenant/members/:userId gestionan el equipo con protección del último owner', async () => {
    const db = new FakeOperatorD1();
    const app = makeApp();
    const env = makeEnv(db);

    // Invitar a un propietario inicial (owner)
    const inviteOwner = await app.request(
      '/api/v1/tenant/members/invite',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          email: 'owner@despacho.mx',
          full_name: 'Propietario Principal',
          role: 'owner',
        }),
      },
      env
    );
    expect(inviteOwner.status).toBe(200);
    const ownerBody = (await inviteOwner.json()) as {
      ok: boolean;
      invited: { user_id: string; email: string; role: string };
      invite_url: string;
      members: Array<{ userId: string; email: string; role: string }>;
    };
    expect(ownerBody.ok).toBe(true);
    expect(ownerBody.invited.role).toBe('owner');
    expect(ownerBody.invite_url).toContain('auth=restablecer&token=');
    expect(ownerBody.members).toHaveLength(1);

    // Invitar a un operador (admin)
    const inviteOp = await app.request(
      '/api/v1/tenant/members/invite',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          email: 'operador@despacho.mx',
          full_name: 'Ana Operadora',
          role: 'admin',
        }),
      },
      env
    );
    expect(inviteOp.status).toBe(200);
    const opBody = (await inviteOp.json()) as {
      invited: { user_id: string; role: string };
      members: Array<{ userId: string; email: string; role: string }>;
    };
    expect(opBody.invited.role).toBe('admin');
    expect(opBody.members).toHaveLength(2);

    // No permite revocar al único owner del despacho
    const delOwnerRes = await app.request(
      `/api/v1/tenant/members/${ownerBody.invited.user_id}`,
      {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      },
      env
    );
    expect(delOwnerRes.status).toBe(400);

    // Sí permite revocar al operador
    const delOpRes = await app.request(
      `/api/v1/tenant/members/${opBody.invited.user_id}`,
      {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      },
      env
    );
    expect(delOpRes.status).toBe(200);
    const afterDelBody = (await delOpRes.json()) as {
      members: Array<{ userId: string }>;
    };
    expect(afterDelBody.members).toHaveLength(1);
  });

  it('PUT /tenant/channels configura los canales del despacho y bloquea con 422 si el operador intenta usar un canal apagado', async () => {
    const db = new FakeOperatorD1();
    db.tenants.push({
      id: 't_arkangel',
      slug: 'arkangel',
      nombre: 'Arkangel',
      status: 'active',
      config_mode: 'db',
      razon_social: 'Arkangel S.A. de C.V.',
      condusef_registro: 'REDECO-001',
      allowed_payment_domains: 'arksystems.site',
      tz: 'America/Mexico_City',
      send_window_start: 0,
      send_window_end: 24,
      max_contacts_per_day: 3,
      legal_monto_tolerancia_cents: 0,
      legal_horario_en_respuestas: 0,
      rate_limit_rpm: 42,
      dedupe_window_hours: 24,
      score_amount_ceiling_cents: 200000,
      agent_mode: 'supervised',
      agent_auto_threshold_cents: 200000,
      dry_run: 1,
      cron_auto_fire: 0,
      is_default: 1,
      created_at: '2026-10-22T00:00:00Z',
      updated_at: '2026-10-22T00:00:00Z',
    });

    const app = makeApp();
    const env = makeEnv(db);

    // No permite apagar los 3 canales al mismo tiempo
    const allOffRes = await app.request(
      '/api/v1/tenant/channels',
      {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          channels: [
            { channel: 'whatsapp', status: 'inactive' },
            { channel: 'sms', status: 'inactive' },
            { channel: 'email', status: 'inactive' },
          ],
        }),
      },
      env
    );
    expect(allOffRes.status).toBe(400);

    // El Manager activa solo WhatsApp y Email (apaga SMS)
    const putChRes = await app.request(
      '/api/v1/tenant/channels',
      {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          channels: [
            {
              channel: 'whatsapp',
              status: 'active',
              provider_account_id: '10928374650',
              template_name: 'recordatorio_mx',
            },
            {
              channel: 'sms',
              status: 'inactive',
              provider_account_id: '',
              from_number: '',
            },
            {
              channel: 'email',
              status: 'active',
              provider_account_id: 'cobranza.arksystems.site',
              from_address: 'avisos@arksystems.site',
            },
          ],
        }),
      },
      env
    );
    expect(putChRes.status).toBe(200);
    const putChBody = (await putChRes.json()) as {
      ok: boolean;
      enabled_channels: string[];
    };
    expect(putChBody.ok).toBe(true);
    expect(putChBody.enabled_channels).toEqual(['whatsapp', 'email']);

    // Si el operador intenta responder por SMS (apagado por el Manager), recibe 422
    const smsReply = await app.request(
      '/api/v1/cases/cas_1/reply',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          channel: 'sms',
          body: 'Estimado Juan Pérez, le contactamos de Arkangel S.A. de C.V. (REDECO-001) sobre su saldo de $1,500.00.',
        }),
      },
      env
    );
    expect(smsReply.status).toBe(422);
    const smsBody = (await smsReply.json()) as { regla: string };
    expect(smsBody.regla).toBe('canal_inactivo');
  });

  it('PUT /cases/:id/cfdi valida y vincula el UUID fiscal SAT al contrato del caso', async () => {
    const db = new FakeOperatorD1();
    const app = makeApp();
    const env = makeEnv(db);

    // UUID inválido -> 400
    const badRes = await app.request(
      '/api/v1/cases/cas_1/cfdi',
      {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ cfdi_uuid: 'no-es-un-uuid' }),
      },
      env
    );
    expect(badRes.status).toBe(400);

    // UUID SAT válido -> 200
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const okRes = await app.request(
      '/api/v1/cases/cas_1/cfdi',
      {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ cfdi_uuid: validUuid }),
      },
      env
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      ok: boolean;
      contract_id: string;
      cfdi_uuid: string;
    };
    expect(okBody.ok).toBe(true);
    expect(okBody.contract_id).toBe('con_1');
    expect(okBody.cfdi_uuid).toBe(validUuid.toUpperCase());

    // Verificar que workspace expone cfdi_uuid
    const wsRes = await app.request(
      '/api/v1/cases/cas_1/workspace',
      { headers: AUTH_HEADERS },
      env
    );
    const wsBody = (await wsRes.json()) as {
      cfdi_uuid: string;
      contract: { cfdi_uuid: string };
    };
    expect(wsBody.cfdi_uuid).toBe(validUuid.toUpperCase());
    expect(wsBody.contract.cfdi_uuid).toBe(validUuid.toUpperCase());
  });

  it('POST /bot/classify y POST /scoring/calibrate ejecutan clasificación en tiempo real y calibración continua de Grok Bot', async () => {
    const db = new FakeOperatorD1();
    const app = makeApp();
    const env = makeEnv(db);

    const classifyRes = await app.request(
      '/api/v1/bot/classify',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          case_id: 'cas_1',
          channel: 'whatsapp',
          inbound: 'Hola, te prometo que el viernes pago los 1500 pesos sin falta',
          apply: true,
        }),
      },
      env
    );
    expect(classifyRes.status).toBe(200);
    const classifyBody = (await classifyRes.json()) as {
      ok: boolean;
      classification: { intent: string };
      recommended_action: string;
      case_status: string;
      applied: boolean;
    };
    expect(classifyBody.ok).toBe(true);
    expect(classifyBody.classification.intent).toBe('promete');
    expect(classifyBody.recommended_action).toBe('record_promise');
    expect(classifyBody.case_status).toBe('promised');
    expect(classifyBody.applied).toBe(true);
    expect(db.promises).toHaveLength(1);

    const calibrateRes = await app.request(
      '/api/v1/scoring/calibrate',
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          date: '2026-10-22',
          apply: true,
        }),
      },
      env
    );
    expect(calibrateRes.status).toBe(200);
    const calibrateBody = (await calibrateRes.json()) as {
      ok: boolean;
      applied: boolean;
      calibrated: {
        score_amount_ceiling_cents: number;
        agent_auto_threshold_cents: number;
      };
    };
    expect(calibrateBody.ok).toBe(true);
    expect(calibrateBody.applied).toBe(true);
    expect(calibrateBody.calibrated.score_amount_ceiling_cents).toBeGreaterThan(200000);
  });
});
