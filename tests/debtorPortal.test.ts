import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { portal } from '../src/routes/portal';
import {
  maskName,
  maskEmail,
  getBankNameFromClabe,
  getDebtorPortalData,
  confirmDebtorPayment,
  getDebtorLegalDocument,
} from '../src/services/debtorPortal';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

class FakePortalD1 {
  agreements = [
    {
      id: 'agr_portal_1',
      tenant_id: 't_portal',
      case_id: 'cas_portal_1',
      client_id: 'cli_portal_1',
      original_amount_cents: 1000000, // $10,000.00 MXN
      agreed_amount_cents: 750000, // $7,500.00 MXN (25% off)
      discount_pct: 25,
      installments: 1,
      status: 'pending',
      clabe: '646180123456789012', // STP
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      agent_id: 'a2a_agent',
      one_click_url: 'https://arkangel.arksystems.site/pay/agr_portal_1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'agr_fulfilled',
      tenant_id: 't_portal',
      case_id: 'cas_portal_paid',
      client_id: 'cli_portal_paid',
      original_amount_cents: 500000,
      agreed_amount_cents: 400000,
      discount_pct: 20,
      installments: 1,
      status: 'fulfilled',
      clabe: '012180001234567890', // BBVA
      expires_at: new Date().toISOString(),
      agent_id: 'a2a_agent',
      one_click_url: 'https://arkangel.arksystems.site/pay/agr_fulfilled',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  cases = [
    {
      id: 'cas_portal_1',
      tenant_id: 't_portal',
      client_id: 'cli_portal_1',
      amount_cents: 1000000,
      status: 'ready',
      name: 'Mariana Garza Treviño',
      phone: '+528180002222',
      email: 'mariana.garza@ejemplo.com',
    },
    {
      id: 'cas_portal_direct',
      tenant_id: 't_portal',
      client_id: 'cli_portal_2',
      amount_cents: 800000, // $8,000.00 MXN
      status: 'ready',
      name: 'Roberto Gómez Bolaños',
      phone: '+525512345678',
      email: 'roberto@ejemplo.com',
    },
    {
      id: 'cas_portal_paid',
      tenant_id: 't_portal',
      client_id: 'cli_portal_paid',
      amount_cents: 500000,
      status: 'paid',
      name: 'Lucía Méndez Pérez',
      phone: '+525599887766',
      email: 'lucia@ejemplo.com',
    },
  ];

  clients = [
    {
      id: 'cli_portal_1',
      tenant_id: 't_portal',
      name: 'Mariana Garza Treviño',
      phone: '+528180002222',
      email: 'mariana.garza@ejemplo.com',
      curp: 'GATM900101MDFRRN01',
      rfc: 'GATM900101XYZ',
    },
    {
      id: 'cli_portal_2',
      tenant_id: 't_portal',
      name: 'Roberto Gómez Bolaños',
      phone: '+525512345678',
      email: 'roberto@ejemplo.com',
      curp: 'GOBR290221HDFRRN00',
      rfc: 'GOBR290221ABC',
    },
    {
      id: 'cli_portal_paid',
      tenant_id: 't_portal',
      name: 'Lucía Méndez Pérez',
      phone: '+525599887766',
      email: 'lucia@ejemplo.com',
      curp: 'MEPL800101MDFRRN00',
      rfc: 'MEPL800101DEF',
    },
  ];

  tenants = [
    {
      id: 't_portal',
      slug: 'portal_credito',
      nombre: 'Crédito Inteligente',
      razon_social: 'Crédito Inteligente S.A.P.I. de C.V. SOFOM E.N.R.',
      condusef_registro: 'CONDUSEF-694021',
      a2a_enabled: 1,
      a2a_max_discount_pct: 30,
    },
  ];

  contracts = [
    {
      id: 'con_portal_2',
      tenant_id: 't_portal',
      client_id: 'cli_portal_2',
      clabe: '002180001234567890', // Banamex
      monto_pactado_cents: 800000,
    },
  ];

  events: any[] = [];
  promises: any[] = [];

  prepare = (sql: string) => {
    const s = sql.trim();

    return {
      bind: (...params: any[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            // Consulta de a2a_agreements por ID
            if (s.includes('FROM a2a_agreements a') && s.includes('WHERE a.id = ?')) {
              const agrId = params[0];
              const agr = this.agreements.find((a) => a.id === agrId);
              if (!agr) return null;

              const cRow = this.cases.find((c) => c.id === agr.case_id);
              const clRow = this.clients.find((cl) => cl.id === agr.client_id);
              const tRow = this.tenants.find((t) => t.id === agr.tenant_id);

              return {
                ...agr,
                case_status: cRow?.status ?? 'ready',
                case_amount: cRow?.amount_cents ?? agr.original_amount_cents,
                client_name: clRow?.name ?? '',
                client_phone: clRow?.phone ?? null,
                client_email: clRow?.email ?? null,
                razon_social: tRow?.razon_social ?? '',
                condusef_registro: tRow?.condusef_registro ?? '',
              } as unknown as T;
            }

            // Consulta simple de a2a_agreements
            if (s.includes('FROM a2a_agreements') && s.includes('WHERE id = ?')) {
              const agrId = params[0];
              const agr = this.agreements.find((a) => a.id === agrId);
              return (agr as unknown as T) || null;
            }

            // Consulta de a2a_agreements por case_id
            if (s.includes('FROM a2a_agreements WHERE case_id = ?')) {
              const caseId = params[0];
              const agr = this.agreements.find((a) => a.case_id === caseId);
              return (agr as unknown as T) || null;
            }

            // Consulta de cases por id con joins
            if (s.includes('FROM cases c') && s.includes('WHERE c.id = ?')) {
              const caseId = params[0];
              const cRow = this.cases.find((c) => c.id === caseId);
              if (!cRow) return null;

              const clRow = this.clients.find((cl) => cl.id === cRow.client_id);
              const tRow = this.tenants.find((t) => t.id === cRow.tenant_id);

              return {
                ...cRow,
                client_name: clRow?.name ?? '',
                client_phone: clRow?.phone ?? null,
                client_email: clRow?.email ?? null,
                razon_social: tRow?.razon_social ?? '',
                condusef_registro: tRow?.condusef_registro ?? '',
                a2a_max_discount_pct: tRow?.a2a_max_discount_pct ?? 25,
                a2a_enabled: tRow?.a2a_enabled ?? 1,
              } as unknown as T;
            }

            // Consulta simple de cases
            if (s.includes('FROM cases WHERE id = ?')) {
              const caseId = params[0];
              const cRow = this.cases.find((c) => c.id === caseId);
              return (cRow as unknown as T) || null;
            }

            // Consulta de contracts
            if (s.includes('FROM contracts WHERE tenant_id = ? AND client_id = ?')) {
              const [tId, clId] = params;
              const con = this.contracts.find((c) => c.tenant_id === tId && c.client_id === clId);
              return (con as unknown as T) || null;
            }

            // Consulta de tenants
            if (s.includes('FROM tenants WHERE id = ?')) {
              const tId = params[0];
              const t = this.tenants.find((item) => item.id === tId);
              return (t as unknown as T) || null;
            }

            return null;
          },

          all: async <T>(): Promise<{ results: T[] }> => {
            return { results: [] };
          },

          run: async (): Promise<{ success: boolean }> => {
            if (s.includes('UPDATE a2a_agreements SET status = ?')) {
              const [status, updated_at, id] = params;
              const agr = this.agreements.find((a) => a.id === id);
              if (agr) {
                agr.status = status;
                agr.updated_at = updated_at;
              }
            }

            if (s.includes('UPDATE cases SET intencion = ?')) {
              const id = params[params.length - 1];
              const cRow = this.cases.find((c) => c.id === id);
              if (cRow) {
                cRow.status = 'contacted';
              }
            }

            if (s.includes('INSERT INTO promises')) {
              this.promises.push(params);
            }

            if (s.includes('INSERT INTO events')) {
              this.events.push(params);
            }

            return { success: true };
          },
        };
      },
    };
  };
}

function makeEnv(): Env {
  const fakeDb = new FakePortalD1();
  return {
    DB: fakeDb as unknown as D1Database,
    ENVIRONMENT: 'test',
    APP_BASE_URL: 'https://arkangel.arksystems.site',
  } as unknown as Env;
}

describe('Portal de Autoservicio del Deudor (Sprint 11)', () => {
  describe('Utilidades de Enmascaramiento y Catálogo SPEI', () => {
    it('enmascara nombres completos de deudores protegiendo datos personales', () => {
      expect(maskName('Mariana Garza Treviño')).toBe('M****** G**** T******');
      expect(maskName('Juan')).toBe('J***');
      expect(maskName('')).toBe('***');
    });

    it('enmascara correos electrónicos conforme a estándares financieros', () => {
      expect(maskEmail('mariana.garza@ejemplo.com')).toBe('m***a@e******.c**');
      expect(maskEmail('ab@ejemplo.com')).toBe('a***@e******.c**');
      expect(maskEmail('invalido')).toBe('***@***.***');
    });

    it('identifica correctamente el banco receptor a partir de los 3 primeros dígitos de la CLABE', () => {
      expect(getBankNameFromClabe('646180123456789012')).toBe(
        'STP (Sistema de Transferencias y Pagos)'
      );
      expect(getBankNameFromClabe('012180001234567890')).toBe('BBVA México');
      expect(getBankNameFromClabe('002180001234567890')).toBe('Citibanamex');
      expect(getBankNameFromClabe('072180001234567890')).toBe('Banorte');
      expect(getBankNameFromClabe('638180001234567890')).toBe('Nu México Financiera');
      expect(getBankNameFromClabe('999180001234567890')).toBe('SPEI - Transferencia Interbancaria');
    });
  });

  describe('Servicio: getDebtorPortalData', () => {
    it('obtiene la información pública sanitizada a través de un agreementId (agr_...)', async () => {
      const env = makeEnv();
      const data = await getDebtorPortalData(env, 'agr_portal_1');

      expect(data).not.toBeNull();
      expect(data?.portalId).toBe('agr_portal_1');
      expect(data?.status).toBe('pending');
      expect(data?.debtor.maskedName).toBe('M****** G**** T******');
      expect(data?.debtor.maskedPhone).toContain('2222');
      expect(data?.creditor.razonSocial).toBe('Crédito Inteligente S.A.P.I. de C.V. SOFOM E.N.R.');
      expect(data?.creditor.condusefRegistro).toBe('CONDUSEF-694021');
      expect(data?.creditor.bankName).toBe('STP (Sistema de Transferencias y Pagos)');
      expect(data?.financials.originalAmountCents).toBe(1000000);
      expect(data?.financials.payableAmountCents).toBe(750000);
      expect(data?.financials.discountPct).toBe(25);
      expect(data?.financials.payableAmountFormatted).toContain('$7,500.00');
    });

    it('obtiene la información pública a través de un caseId directo (cas_...) con descuento propuesto', async () => {
      const env = makeEnv();
      const data = await getDebtorPortalData(env, 'cas_portal_direct');

      expect(data).not.toBeNull();
      expect(data?.portalId).toBe('cas_portal_direct');
      expect(data?.debtor.maskedName).toBe('R****** G**** B******');
      expect(data?.financials.originalAmountCents).toBe(800000);
      // El despacho autoriza 30%, el portal aplica el descuento estándar de 25%
      expect(data?.financials.discountPct).toBe(25);
      expect(data?.financials.payableAmountCents).toBe(600000);
      expect(data?.creditor.bankName).toBe('Citibanamex'); // por clabe 002...
    });

    it('refleja correctamente el estado fulfilled si la deuda ya fue liquidada', async () => {
      const env = makeEnv();
      const data = await getDebtorPortalData(env, 'agr_fulfilled');

      expect(data).not.toBeNull();
      expect(data?.status).toBe('fulfilled');
      expect(data?.creditor.bankName).toBe('BBVA México');
    });

    it('devuelve null si el identificador no existe en la base de datos (fail-closed)', async () => {
      const env = makeEnv();
      const data = await getDebtorPortalData(env, 'agr_inexistente_999');
      expect(data).toBeNull();
    });
  });

  describe('Servicio: confirmDebtorPayment', () => {
    it('registra el reporte de transferencia SPEI del deudor', async () => {
      const env = makeEnv();
      const result = await confirmDebtorPayment(env, 'agr_portal_1', {
        trackingKey: 'SPEI-8839201948',
        bankOrigin: 'BBVA',
        payerEmail: 'comprobante@deudor.com',
        notes: 'Transferencia realizada a las 10:30am',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('payment_reported');
      expect(result.receiptFolio).toMatch(/^REC-/);
      expect(result.message).toContain('Transferencia registrada exitosamente');
    });
  });

  describe('Servicio: getDebtorLegalDocument', () => {
    it('genera Carta Convenio formal con cláusulas CONDUSEF / REDECO y sello digital', async () => {
      const env = makeEnv();
      const doc = await getDebtorLegalDocument(env, 'agr_portal_1');

      expect(doc).not.toBeNull();
      expect(doc?.tipoDocumento).toBe('carta_convenio');
      expect(doc?.razonSocial).toContain('Crédito Inteligente');
      expect(doc?.condusefRegistro).toBe('CONDUSEF-694021');
      expect(doc?.clausulas.length).toBeGreaterThanOrEqual(4);
      expect(doc?.selloDigital).toMatch(/^ARK-SIG-2026-/);
    });

    it('genera Carta Finiquito de No Adeudo para convenios liquidados', async () => {
      const env = makeEnv();
      const doc = await getDebtorLegalDocument(env, 'agr_fulfilled');

      expect(doc).not.toBeNull();
      expect(doc?.tipoDocumento).toBe('carta_finiquito');
      expect(doc?.clausulas.some((c) => c.includes('FINIQUITO Y EXTINCIÓN DE OBLIGACIÓN'))).toBe(
        true
      );
      expect(doc?.clausulas.some((c) => c.includes('Sociedades de Información Crediticia'))).toBe(
        true
      );
    });
  });

  describe('Rutas HTTP: portal router', () => {
    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/api/v1/portal', portal);

    it('GET /api/v1/portal/:id devuelve 200 con JSON del portal', async () => {
      const env = makeEnv();
      const res = await app.request('/api/v1/portal/agr_portal_1', {}, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.portal.portalId).toBe('agr_portal_1');
      expect(body.portal.debtor.maskedName).toBe('M****** G**** T******');
      expect(body.portal.creditor.clabe).toBe('646180123456789012');
    });

    it('GET /api/v1/portal/:id devuelve 404 si el id no existe', async () => {
      const env = makeEnv();
      const res = await app.request('/api/v1/portal/agr_no_existe', {}, env);
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe('portal_not_found');
    });

    it('POST /api/v1/portal/:id/confirm procesa la confirmación del pago', async () => {
      const env = makeEnv();
      const res = await app.request(
        '/api/v1/portal/agr_portal_1/confirm',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackingKey: 'SPEI-TRK-7711',
            bankOrigin: 'Santander',
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.status).toBe('payment_reported');
      expect(body.receiptFolio).toBeDefined();
    });

    it('GET /api/v1/portal/:id/document entrega el documento legal', async () => {
      const env = makeEnv();
      const res = await app.request('/api/v1/portal/agr_portal_1/document', {}, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.document.tipoDocumento).toBe('carta_convenio');
      expect(body.document.selloDigital).toBeDefined();
    });
  });
});
