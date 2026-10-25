import { describe, expect, it } from 'vitest';
import {
  maskName,
  verifyDebtorIdentity,
  getA2ASettlementTerms,
  evaluateA2AOffer,
  getA2AAgreement,
} from '../src/services/a2a';
import type { TenantContext } from '../src/tenancy/types';

class FakeA2AD1 {
  cases = [
    {
      id: 'cas_100',
      tenant_id: 't_arkangel',
      client_id: 'cli_100',
      amount_cents: 1000000, // $10,000.00 MXN
      status: 'ready',
      name: 'Roberto Gómez Bolaños',
      phone: '+525512345678',
      email: 'roberto@ejemplo.com',
    },
    {
      id: 'cas_paid',
      tenant_id: 't_arkangel',
      client_id: 'cli_paid',
      amount_cents: 500000,
      status: 'paid',
      name: 'Ana María Alvarado',
      phone: '+525598765432',
      email: 'ana@ejemplo.com',
    },
  ];

  clients = [
    {
      id: 'cli_100',
      tenant_id: 't_arkangel',
      name: 'Roberto Gómez Bolaños',
      phone: '+525512345678',
      email: 'roberto@ejemplo.com',
      curp: 'GOBR700101HDFRNN09',
      rfc: 'GOBR700101A18',
      auth_pin: '4321',
    },
    {
      id: 'cli_paid',
      tenant_id: 't_arkangel',
      name: 'Ana María Alvarado',
      phone: '+525598765432',
      email: 'ana@ejemplo.com',
      curp: 'ALVA850505MDFRNN01',
      rfc: null,
      auth_pin: '9999',
    },
  ];

  tenants = [
    {
      id: 't_arkangel',
      razon_social: 'Cobranza Arkangel S.A. de C.V.',
      condusef_registro: 'CONDUSEF-2026-99',
      a2a_enabled: 1,
      a2a_max_discount_pct: 30, // Máximo 30% de descuento permitido
      a2a_max_installments: 3, // Máximo 3 parcialidades
      a2a_min_down_payment_pct: 40,
    },
  ];

  contracts = [
    {
      id: 'con_100',
      tenant_id: 't_arkangel',
      client_id: 'cli_100',
      monto_pactado_cents: 1000000,
      tasa_pct: 2.5,
      clabe: '646180111122223334',
      nombre_legal: 'Cobranza Arkangel S.A. de C.V.',
      condusef: 'CONDUSEF-2026-99',
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
    },
  ];

  agreements: Record<string, any>[] = [];
  promises: Record<string, any>[] = [];
  messages: Record<string, any>[] = [];

  prepare = (sql: string) => {
    return {
      bind: (...args: any[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            if (sql.includes('FROM cases WHERE tenant_id = ? AND id = ?')) {
              const [tenantId, caseId] = args;
              const found = this.cases.find((c) => c.tenant_id === tenantId && c.id === caseId);
              return (found as unknown as T) ?? null;
            }
            if (sql.includes('FROM clients WHERE tenant_id = ? AND id = ?')) {
              const [tenantId, clientId] = args;
              const found = this.clients.find((c) => c.tenant_id === tenantId && c.id === clientId);
              return (found as unknown as T) ?? null;
            }
            if (sql.includes('FROM tenants WHERE id = ?')) {
              const [tenantId] = args;
              const found = this.tenants.find((t) => t.id === tenantId);
              return (found as unknown as T) ?? null;
            }
            if (sql.includes('FROM contracts WHERE tenant_id = ? AND client_id = ?')) {
              const [tenantId, clientId] = args;
              const found = this.contracts.find(
                (c) => c.tenant_id === tenantId && c.client_id === clientId
              );
              return (found as unknown as T) ?? null;
            }
            if (sql.includes('FROM a2a_agreements WHERE tenant_id = ? AND id = ?')) {
              const [tenantId, agreementId] = args;
              const found = this.agreements.find(
                (a) => a.tenant_id === tenantId && a.id === agreementId
              );
              return (found as unknown as T) ?? null;
            }
            return null;
          },
          all: async <T>(): Promise<{ results: T[] }> => {
            return { results: [] };
          },
          run: async (): Promise<{ success: boolean }> => {
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
            return { success: true };
          },
        };
      },
    };
  };
}

function makeContext(db: FakeA2AD1): TenantContext {
  const tenant = {
    id: 't_arkangel',
    slug: 'arkangel',
    nombre: 'Cobranza Arkangel',
    status: 'active' as const,
    config_mode: 'db' as const,
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
    a2a_max_discount_pct: 30,
    a2a_max_installments: 3,
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
  };

  return {
    tenantId: 't_arkangel',
    tenant,
    config: {
      razonSocial: tenant.razon_social,
      condusef: tenant.condusef_registro,
    } as any,
    channels: {} as any,
    principal: { kind: 'platform' } as any,
    env: { DB: db as any } as any,
  };
}

describe('Protocolo A2A (Agent-to-Agent Collections & Negotiation)', () => {
  it('enmascara nombres para protección de datos personales ante terceros (CONDUSEF 4.1/4.2)', () => {
    expect(maskName('Roberto Gómez')).toBe('R****** G****');
    expect(maskName('Ana María Alvarado')).toBe('A** M**** A*******');
    expect(maskName('')).toBe('***');
  });

  describe('verifyDebtorIdentity', () => {
    it('falla fail-closed si el caso no existe', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      const res = await verifyDebtorIdentity(ctx, { caseId: 'cas_inexistente', pin: '1234' });
      expect(res.verified).toBe(false);
      expect(res.error).toBe('case_not_found');
    });

    it('rechaza consultas sobre casos ya pagados / liquidados', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      const res = await verifyDebtorIdentity(ctx, { caseId: 'cas_paid', pin: '9999' });
      expect(res.verified).toBe(false);
      expect(res.error).toBe('account_closed');
    });

    it('rechaza con auth_failed si el PIN o RFC no coinciden', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      const res = await verifyDebtorIdentity(ctx, {
        caseId: 'cas_100',
        pin: '0000',
        rfcLast4: 'XXXX',
      });
      expect(res.verified).toBe(false);
      expect(res.error).toBe('auth_failed');
    });

    it('autentica exitosamente mediante PIN de 4 dígitos', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      const res = await verifyDebtorIdentity(ctx, { caseId: 'cas_100', pin: '4321' });
      expect(res.verified).toBe(true);
      expect(res.sessionToken).toContain('a2a_tok_');
      expect(res.debtorSummary?.totalDebtCents).toBe(1000000);
      expect(res.debtorSummary?.maskedName).toBe('R****** G**** B******');
      expect(res.debtorSummary?.creditor.razonSocial).toBe('Cobranza Arkangel S.A. de C.V.');
      expect(res.debtorSummary?.standardOffers.length).toBeGreaterThanOrEqual(1);
    });

    it('autentica exitosamente mediante últimos 4 caracteres del RFC', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      // RFC en BD: "GOBR700101A18", terminación "1A18" o "A18"
      const res = await verifyDebtorIdentity(ctx, { caseId: 'cas_100', rfcLast4: 'A18' });
      expect(res.verified).toBe(true);
      expect(res.debtorSummary?.caseId).toBe('cas_100');
    });
  });

  describe('getA2ASettlementTerms', () => {
    it('calcula las ofertas estándar basadas en la política del despacho', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);
      const summary = await getA2ASettlementTerms(ctx, 'cas_100');

      expect(summary.totalDebtCents).toBe(1000000);
      expect(summary.maxDiscountPct).toBe(30);
      expect(summary.minSettlementCents).toBe(700000); // 30% de quita en $10,000 = $7,000

      const singleOffer = summary.standardOffers.find((o) => o.type === 'single_payment');
      expect(singleOffer).toBeDefined();
      expect(singleOffer?.totalCents).toBe(700000);
      expect(singleOffer?.discountPct).toBe(30);

      const installmentOffers = summary.standardOffers.filter((o) => o.type === 'installments');
      expect(installmentOffers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('evaluateA2AOffer (Motor Matemático Anti-Jailbreak)', () => {
    it('rechaza ofertas ridículas / jailbreaks ($1 peso) y devuelve contraoferta estructurada', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);

      // Agente hostil o jailbreak intentando pagar $10.00 MXN en una deuda de $10,000
      const res = await evaluateA2AOffer(ctx, {
        caseId: 'cas_100',
        proposedAmountCents: 1000, // $10.00 MXN
        installments: 1,
        agentId: 'adversarial-bot-v1',
      });

      expect(res.accepted).toBe(false);
      expect(res.status).toBe('counter_offer');
      expect(res.counterOffer).toBeDefined();
      expect(res.counterOffer?.minSinglePaymentCents).toBe(700000); // Mínimo $7,000 MXN
      expect(res.counterOffer?.explanation).toContain('está por debajo del umbral mínimo');
    });

    it('acepta una oferta de quita válida dentro del margen del acreedor y genera convenio con CLABE', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);

      // Deuda: $10,000 MXN. Mínimo permitido: $7,000 MXN (30% quita).
      // El agente propone $7,500 MXN (25% quita).
      const res = await evaluateA2AOffer(ctx, {
        caseId: 'cas_100',
        proposedAmountCents: 750000,
        installments: 1,
        agentId: 'claude-finance-proxy',
      });

      expect(res.accepted).toBe(true);
      expect(res.status).toBe('agreement_accepted');
      expect(res.agreement).toBeDefined();
      expect(res.agreement?.agreedAmountCents).toBe(750000);
      expect(res.agreement?.discountPct).toBe(25);
      expect(res.agreement?.clabe).toBe('646180111122223334');
      expect(res.agreement?.oneClickConfirmationUrl).toContain('/pay/');

      // Verifica que el convenio quedó guardado en la base de datos
      const stored = await getA2AAgreement(ctx, res.agreement!.id);
      expect(stored).not.toBeNull();
      expect(stored?.id).toBe(res.agreement!.id);
      expect(stored?.status).toBe('pending');
    });

    it('contraoferta si el agente solicita más parcialidades de las permitidas', async () => {
      const db = new FakeA2AD1();
      const ctx = makeContext(db);

      // Política permite máx 3 parcialidades. El agente pide 10 parcialidades.
      const res = await evaluateA2AOffer(ctx, {
        caseId: 'cas_100',
        proposedAmountCents: 900000,
        installments: 10,
        agentId: 'external-bot',
      });

      expect(res.accepted).toBe(false);
      expect(res.status).toBe('counter_offer');
      expect(res.counterOffer?.maxInstallments).toBe(3);
      expect(res.counterOffer?.explanation).toContain('excede el límite máximo permitido');
    });
  });
});
