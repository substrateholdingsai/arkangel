import { describe, expect, it, vi } from 'vitest';
import { authenticateCobre, parseCobreWebhook, verifyCobreHmac } from '../src/channels/cobre';
import { parsePaymentCsv, reconcilePayment } from '../src/services/pagos';
import type { TenantContext } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

class FakePaymentD1 {
  debts = [
    {
      id: 'deb_1',
      tenant_id: 't_arkangel',
      client_id: 'cli_1',
      amount_cents: 845000,
      currency: 'MXN',
      due_date: '2026-09-18',
      status: 'pending',
      description: 'Folio 8841',
      created_at: '2026-10-22T00:00:00Z',
      updated_at: '2026-10-22T00:00:00Z',
    },
  ];
  cases = [
    {
      id: 'cas_1',
      tenant_id: 't_arkangel',
      client_id: 'cli_1',
      case_date: '2026-10-22',
      amount_cents: 845000,
      status: 'human',
    },
  ];
  contracts = [
    {
      id: 'con_1',
      tenant_id: 't_arkangel',
      client_id: 'cli_1',
      clabe: '646180157000000101',
      monto_pactado_cents: 845000,
    },
  ];
  promises = [
    {
      id: 'prm_1',
      tenant_id: 't_arkangel',
      client_id: 'cli_1',
      status: 'open',
    },
  ];
  events: Array<{ type: string; payload: string }> = [];
  messages: unknown[] = [];

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
    if (sql.includes("FROM events WHERE tenant_id = ? AND type = 'pago.conciliado'")) {
      const needle = String(args[1]).replace(/%/g, '');
      return this.events.find((e) => e.payload.includes(needle)) ? { id: 'evt_dup' } : null;
    }
    if (sql.includes('FROM contracts WHERE tenant_id = ? AND clabe = ?')) {
      return this.contracts.find((c) => c.tenant_id === args[0] && c.clabe === args[1]) ?? null;
    }
    if (sql.includes('SELECT name FROM clients')) {
      return { name: 'Carlos Mendoza' };
    }
    if (sql.includes('FROM cases WHERE tenant_id = ? AND client_id = ?')) {
      return this.cases.find((c) => c.tenant_id === args[0] && c.client_id === args[1]) ?? null;
    }
    return null;
  }

  all(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM debts WHERE tenant_id = ? AND client_id = ?')) {
      return this.debts.filter(
        (d) => d.tenant_id === args[0] && d.client_id === args[1] && d.status !== 'paid'
      );
    }
    return [];
  }

  exec(sql: string, args: unknown[]): void {
    if (sql.startsWith('UPDATE debts SET status = ?')) {
      const d = this.debts.find((row) => row.id === args[3]);
      if (d) d.status = String(args[0]);
    }
    if (sql.startsWith("UPDATE cases SET status = 'paid'")) {
      const c = this.cases.find((row) => row.id === args[2]);
      if (c) c.status = 'paid';
    }
    if (sql.startsWith("UPDATE promises SET status = 'fulfilled'")) {
      for (const p of this.promises) {
        if (p.client_id === args[1]) p.status = 'fulfilled';
      }
    }
    if (sql.startsWith('INSERT INTO events')) {
      this.events.push({ type: String(args[2]), payload: String(args[5] ?? '') });
    }
    if (sql.startsWith('INSERT INTO messages')) {
      this.messages.push({ body: args[7] });
    }
  }
}

describe('Motor de Conciliación Canónico y Cobre SPEI', () => {
  it('parseCobreWebhook normaliza money_movements.status.completed con CLABE virtual y clave de rastreo', () => {
    const payload = {
      event: 'money_movements.status.completed',
      data: {
        id: 'mm_99812',
        amount: 8450.0,
        currency: 'MXN',
        cep_tracking_key: '20261022COBRE99812',
        destination: {
          account_number: '646180157000000101',
        },
        completed_at: '2026-10-22T21:00:00Z',
      },
    };

    const parsed = parseCobreWebhook(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.clabe).toBe('646180157000000101');
    expect(parsed?.amountCents).toBe(845000);
    expect(parsed?.trackingKey).toBe('20261022COBRE99812');
    expect(parsed?.source).toBe('cobre_spei');
  });

  it('verifyCobreHmac verifica firmas HMAC-SHA256 válidas y rechaza alteraciones', async () => {
    const secret = 'whsec_cobre_test_123';
    const rawBody = '{"event":"accounts.balance.credit","data":{"amount":1500}}';
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const hex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(await verifyCobreHmac(secret, rawBody, `sha256=${hex}`)).toBe(true);
    expect(await verifyCobreHmac(secret, `${rawBody}x`, hex)).toBe(false);
  });

  it('authenticateCobre intercambia credenciales en /v1/auth y cachea el JWT en KV', async () => {
    const kvStore = new Map<string, string>();
    const fakeEnv = {
      COBRE_BASE_URL: 'https://api.qa.cobre.co',
      COBRE_USER_ID: 'usr_cobre_1',
      COBRE_SECRET: 'sec_cobre_1',
      KV: {
        get: async (k: string) => kvStore.get(k) ?? null,
        put: async (k: string, v: string) => {
          kvStore.set(k, v);
        },
      },
    } as unknown as Env;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'jwt_cobre_live_token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const token1 = await authenticateCobre(fakeEnv, 't_arkangel');
    expect(token1).toBe('jwt_cobre_live_token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Segunda llamada lee de KV sin golpear la red
    const token2 = await authenticateCobre(fakeEnv, 't_arkangel');
    expect(token2).toBe('jwt_cobre_live_token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('reconcilePayment liquida deuda, cierra el caso en paid, cumple la promesa y es idempotente por trackingKey', async () => {
    const db = new FakePaymentD1();
    const ctx = {
      tenantId: 't_arkangel',
      env: { DB: db } as unknown as Env,
      config: { tz: 'America/Mexico_City' },
    } as unknown as TenantContext;

    const first = await reconcilePayment(ctx, {
      clabe: '646180157000000101',
      amountCents: 845000,
      trackingKey: '20261022COBRE99812',
      source: 'cobre_spei',
    });

    expect(first.status).toBe('reconciled');
    expect(first.matchedBy).toBe('clabe');
    expect(first.fullyPaid).toBe(true);
    expect(db.debts[0]?.status).toBe('paid');
    expect(db.cases[0]?.status).toBe('paid');
    expect(db.promises[0]?.status).toBe('fulfilled');

    // Reintento del mismo webhook SPEI devuelve duplicate
    const second = await reconcilePayment(ctx, {
      clabe: '646180157000000101',
      amountCents: 845000,
      trackingKey: '20261022COBRE99812',
      source: 'cobre_spei',
    });
    expect(second.status).toBe('duplicate');
  });

  it('parsePaymentCsv detecta columnas bancarias legacy y normaliza los importes', () => {
    const csv = [
      'clabe,monto,clave_rastreo,referencia',
      '"646180157000000101","$8,450.00","20261022BBVA001","Folio 8841"',
      '"646180157000000202","$15,200.00","20261022BBVA002","Folio 7712"',
    ].join('\n');

    const rows = parsePaymentCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.clabe).toBe('646180157000000101');
    expect(rows[0]?.amountCents).toBe(845000);
    expect(rows[0]?.trackingKey).toBe('20261022BBVA001');
    expect(rows[1]?.amountCents).toBe(1520000);
  });
});
