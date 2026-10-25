import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { nom151 } from '../src/routes/nom151';
import {
  recordWormAuditEntry,
  verifyWormChain,
} from '../src/services/custodyWorm';
import {
  upsertTenantPscSettings,
  stampDigestWithAtebPsc,
} from '../src/services/atebPscClient';
import {
  issueNom151Certificate,
} from '../src/services/nom151';
import {
  generateCaseJudicialDocket,
  renderJudicialDocketHtml,
} from '../src/services/judicialDocket';
import type { TenantContext } from '../src/tenancy/types';
import type { Env } from '../src/types/env';
import type { AuthVars } from '../src/auth/middleware';

class FakeAtebD1 {
  certificates: any[] = [];
  wormAuditLogs: any[] = [];
  pscSettings: any[] = [];

  clients = [
    {
      id: 'cli_psc_1',
      tenant_id: 't_psc',
      name: 'Mauricio Garza Toussaint',
      phone: '+528183445566',
      email: 'm.garza@toussaint.mx',
      curp: 'GATM800101HNL',
    },
  ];

  debts = [
    {
      id: 'deb_psc_1',
      client_id: 'cli_psc_1',
      amount_cents: 8500000, // $85,000.00 MXN
      due_date: '2026-01-15',
      description: 'Pagaré mercantil número 4022',
    },
  ];

  cases = [
    {
      id: 'cas_psc_1',
      tenant_id: 't_psc',
      client_id: 'cli_psc_1',
      debt_id: 'deb_psc_1',
      amount_cents: 8500000,
      case_date: '2026-01-15',
      status: 'ready',
    },
  ];

  tenants = [
    {
      id: 't_psc',
      slug: 'garza_legal',
      razon_social: 'Garza & Asociados Cobranza Corporativa S.C.',
      condusef_registro: 'CONDUSEF-PSC-7788',
    },
  ];

  messages = [
    {
      id: 'msg_1',
      case_id: 'cas_psc_1',
      channel: 'whatsapp',
      direction: 'outbound',
      provider_id: 'telnyx_msg_9988',
      body: 'REQUERIMIENTO FORMAL DE PAGO: Estimado deudor le solicitamos liquidar su adeudo...',
      created_at: '2026-10-25T10:00:00Z',
    },
  ];

  prepare = (sql: string) => {
    const s = sql.trim();

    return {
      bind: (...params: any[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            if (s.includes('FROM worm_audit_log') && s.includes('ORDER BY created_at DESC')) {
              const tenantId = params[0];
              const entries = this.wormAuditLogs.filter((w) => w.tenant_id === tenantId);
              if (!entries.length) return null;
              return { entry_hash: entries[entries.length - 1].entry_hash } as unknown as T;
            }

            if (s.includes('FROM tenant_psc_settings WHERE tenant_id = ?')) {
              const tenantId = params[0];
              const found = this.pscSettings.find((p) => p.tenant_id === tenantId);
              return (found as unknown as T) || null;
            }

            if (s.includes('FROM clients WHERE id = ?')) {
              const id = params[0];
              const cl = this.clients.find((c) => c.id === id);
              return (cl as unknown as T) || null;
            }

            if (s.includes('FROM cases c') && s.includes('WHERE c.id = ?')) {
              const [caseId, tenantId] = params;
              const cs = this.cases.find((c) => c.id === caseId && c.tenant_id === tenantId);
              if (!cs) return null;
              const cl = this.clients.find((c) => c.id === cs.client_id);
              const db = this.debts.find((d) => d.id === cs.debt_id);
              return {
                ...cs,
                client_name: cl?.name,
                client_phone: cl?.phone,
                client_email: cl?.email,
                client_curp: cl?.curp,
                due_date: db?.due_date,
                debt_amount_cents: db?.amount_cents,
                debt_description: db?.description,
              } as unknown as T;
            }

            if (s.includes('FROM tenants WHERE id = ?')) {
              const id = params[0];
              const tn = this.tenants.find((t) => t.id === id);
              return (tn as unknown as T) || null;
            }

            return null;
          },

          all: async <T>(): Promise<{ results: T[] }> => {
            if (s.includes('FROM worm_audit_log WHERE tenant_id = ?')) {
              const tenantId = params[0];
              let list = this.wormAuditLogs.filter((w) => w.tenant_id === tenantId);
              if (s.includes('AND case_id = ?')) {
                const caseId = params[1];
                list = list.filter((w) => w.case_id === caseId);
              }
              return { results: list as unknown as T[] };
            }

            if (s.includes('nom151_certificates') && s.includes('case_id = ?')) {
              const [tenantId, caseId] = params;
              const list = this.certificates.filter(
                (c) => c.tenant_id === tenantId && c.case_id === caseId
              );
              return { results: list as unknown as T[] };
            }

            if (s.includes('FROM messages WHERE case_id = ?')) {
              const [caseId] = params;
              const list = this.messages.filter((m) => m.case_id === caseId);
              return { results: list as unknown as T[] };
            }

            return { results: [] };
          },

          run: async () => {
            if (s.startsWith('INSERT INTO worm_audit_log')) {
              this.wormAuditLogs.push({
                id: params[0],
                tenant_id: params[1],
                case_id: params[2],
                record_type: params[3],
                record_id: params[4],
                action: params[5],
                actor: params[6],
                prev_hash: params[7],
                record_hash: params[8],
                entry_hash: params[9],
                timestamp_utc: params[10],
                metadata: params[11],
                created_at: params[12],
              });
              return { success: true };
            }

            if (s.startsWith('INSERT INTO tenant_psc_settings')) {
              const existingIndex = this.pscSettings.findIndex((p) => p.tenant_id === params[0]);
              const record = {
                tenant_id: params[0],
                ateb_enabled: params[1],
                ateb_environment: params[2],
                ateb_client_id: params[3],
                ateb_api_key: params[4],
                ateb_tsa_enabled: params[5],
                auto_stamp_outbound: params[6],
                created_at: params[7],
                updated_at: params[8],
              };
              if (existingIndex >= 0) {
                this.pscSettings[existingIndex] = record;
              } else {
                this.pscSettings.push(record);
              }
              return { success: true };
            }

            if (s.startsWith('INSERT INTO nom151_certificates')) {
              this.certificates.push({
                id: params[0],
                tenant_id: params[1],
                case_id: params[2],
                client_id: params[3],
                message_id: params[4],
                certificate_folio: params[5],
                tipo_notificacion: params[6],
                channel: params[7],
                provider_id: params[8],
                recipient_masked: params[9],
                message_content: params[10],
                message_digest_sha256: params[11],
                cadena_original: params[12],
                sello_digital: params[13],
                timestamp_utc: params[14],
                timestamp_local: params[15],
                verification_url: params[16],
                status: 'issued',
                psc_provider: params[17],
                psc_compliance_level: params[18],
                psc_constancia_id: params[19],
                psc_timestamp_token: params[20],
                psc_response_payload: params[21],
                custody_worm_hash: params[22],
                metadata: params[23],
                created_at: params[24],
              });
              return { success: true };
            }

            return { success: true };
          },
        };
      },
    };
  };
}

describe('Conector ATEB Servicios PSC y Cuaderno Judicial NOM-151', () => {
  it('encadena entradas inmutables en la bitácora WORM y valida la integridad de la cadena', async () => {
    const fakeDb = new FakeAtebD1();
    const env = { DB: fakeDb as any } as Env;

    // Registro 1
    const entry1 = await recordWormAuditEntry(env, {
      tenantId: 't_psc',
      caseId: 'cas_psc_1',
      recordType: 'nom151_certificate',
      recordId: 'cert_1',
      action: 'created',
      actor: 'system',
      recordHash: 'hash_cert_1',
    });
    expect(entry1.prevHash).toBe('0'.repeat(64));
    expect(entry1.entryHash).toHaveLength(64);

    // Registro 2 (encadenado con el registro 1)
    const entry2 = await recordWormAuditEntry(env, {
      tenantId: 't_psc',
      caseId: 'cas_psc_1',
      recordType: 'telnyx_call',
      recordId: 'call_1',
      action: 'created',
      actor: 'telnyx_webhook',
      recordHash: 'hash_call_1',
    });
    expect(entry2.prevHash).toBe(entry1.entryHash);

    // Validación de cadena intacta
    const auditResult = await verifyWormChain(env, 't_psc', 'cas_psc_1');
    expect(auditResult.valid).toBe(true);
    expect(auditResult.totalEntries).toBe(2);
    expect(auditResult.compromisedAtId).toBeNull();
  });

  it('detecta manipulación o alteración fraudulenta en la cadena WORM', async () => {
    const fakeDb = new FakeAtebD1();
    const env = { DB: fakeDb as any } as Env;

    await recordWormAuditEntry(env, {
      tenantId: 't_psc',
      caseId: 'cas_psc_1',
      recordType: 'nom151_certificate',
      recordId: 'cert_1',
      action: 'created',
      actor: 'system',
      recordHash: 'hash_cert_1',
    });

    // Simulamos un atacante alterando el hash de la base de datos
    fakeDb.wormAuditLogs[0].entry_hash = 'hackeado_hash_invalido_000000000000000000000000000000000000000000';

    const check = await verifyWormChain(env, 't_psc', 'cas_psc_1');
    expect(check.valid).toBe(false);
    expect(check.compromisedAtId).toBe(fakeDb.wormAuditLogs[0].id);
  });

  it('opera en modo dual: Modo B presuntivo sin credenciales y Modo A pleno con ATEB PSC', async () => {
    // 1. Sin credenciales ATEB -> Modo B
    const modoBResult = await stampDigestWithAtebPsc(
      {
        tenantId: 't_psc',
        atebEnabled: false,
        atebEnvironment: 'sandbox',
        atebClientId: null,
        atebApiKey: null,
        atebTsaEnabled: true,
        autoStampOutbound: false,
      },
      {
        digestSha256: 'abc123sha256',
        certificateFolio: 'ARK-NOM151-TEST',
      }
    );
    expect(modoBResult.provider).toBe('arkangel_internal');
    expect(modoBResult.complianceLevel).toBe('modo_b_presuntivo');

    // 2. Con credenciales ATEB activas en sandbox -> Modo A Pleno
    const modoAResult = await stampDigestWithAtebPsc(
      {
        tenantId: 't_psc',
        atebEnabled: true,
        atebEnvironment: 'sandbox',
        atebClientId: 'ATEB_CLI_9921',
        atebApiKey: 'test_ateb_key_secret',
        atebTsaEnabled: true,
        autoStampOutbound: true,
      },
      {
        digestSha256: 'abc123sha256',
        certificateFolio: 'ARK-NOM151-ATEB-001',
      }
    );
    expect(modoAResult.provider).toBe('ateb_psc');
    expect(modoAResult.complianceLevel).toBe('modo_a_pleno');
    expect(modoAResult.constanciaId).toContain('ATEB-NOM151-SE-');
    expect(modoAResult.timestampToken).toBeDefined();
  });

  it('emite constancia con timbrado oficial ATEB y registra trazabilidad WORM', async () => {
    const fakeDb = new FakeAtebD1();
    const env = { DB: fakeDb as any, APP_URL: 'https://arkangel.arksystems.site' } as Env;

    // Configurar tenant con ATEB activo
    await upsertTenantPscSettings(env, {
      tenantId: 't_psc',
      atebEnabled: true,
      atebEnvironment: 'sandbox',
      atebClientId: 'ATEB_GARZA',
      atebApiKey: 'test_key_garza',
      atebTsaEnabled: true,
      autoStampOutbound: true,
    });

    const ctx: TenantContext = {
      tenantId: 't_psc',
      tenant: fakeDb.tenants[0] as any,
      env,
    };

    const cert = await issueNom151Certificate(ctx, {
      caseId: 'cas_psc_1',
      clientId: 'cli_psc_1',
      tipoNotificacion: 'requerimiento_pago',
      channel: 'whatsapp',
      messageContent: 'Se requiere el pago inmediato del saldo vencido por $85,000.00 MXN.',
      providerId: 'telnyx_msg_8877',
    });

    expect(cert.pscProvider).toBe('ateb_psc');
    expect(cert.pscComplianceLevel).toBe('modo_a_pleno');
    expect(cert.pscConstanciaId).toContain('ATEB-NOM151-SE-');
    expect(cert.custodyWormHash).toHaveLength(64);

    // Debe haber quedado una entrada en worm_audit_log
    expect(fakeDb.wormAuditLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('genera el Cuaderno Judicial y Carpeta de Materialidad Fiscal SAT con liquidación de intereses', async () => {
    const fakeDb = new FakeAtebD1();
    const env = { DB: fakeDb as any, APP_URL: 'https://arkangel.arksystems.site' } as Env;

    const ctx: TenantContext = {
      tenantId: 't_psc',
      tenant: fakeDb.tenants[0] as any,
      env,
    };

    // Emitir 1 constancia previa
    await issueNom151Certificate(ctx, {
      caseId: 'cas_psc_1',
      clientId: 'cli_psc_1',
      tipoNotificacion: 'requerimiento_pago',
      channel: 'whatsapp',
      messageContent: 'Requerimiento formal de pago.',
    });

    const docket = await generateCaseJudicialDocket(ctx, 'cas_psc_1');
    expect(docket).not.toBeNull();
    expect(docket?.folioExpediente).toContain('EXP-JUD-PSC-');
    expect(docket?.actor.razonSocial).toBe('Garza & Asociados Cobranza Corporativa S.C.');
    expect(docket?.demandado.nombre).toBe('Mauricio Garza Toussaint');
    expect(docket?.demandado.curp).toBe('GATM800101HNL');
    expect(docket?.liquidacion.capitalInsolutoFormatted).toContain('85,000');
    expect(docket?.liquidacion.diasMora).toBeGreaterThan(0);
    expect(docket?.pruebasNom151).toHaveLength(1);
    expect(docket?.custodiaWorm.cadenaValida).toBe(true);
    expect(docket?.sustentoFiscalSat.materialidadComprobada).toBe(true);

    // Prueba de renderizado HTML imprimible
    const html = renderJudicialDocketHtml(docket!);
    expect(html).toContain('CUADERNO DE PRUEBAS ELECTRÓNICAS Y MATERIALIDAD FISCAL');
    expect(html).toContain('Garza & Asociados Cobranza Corporativa S.C.');
    expect(html).toContain('Mauricio Garza Toussaint');
    expect(html).toContain('ARTÍCULO 1298-A DEL CÓDIGO DE COMERCIO');
    expect(html).toContain('Artículo 29-A CFF');
  });

  it('expone las rutas HTTP de expediente judicial, settings de ATEB y cadena WORM', async () => {
    const fakeDb = new FakeAtebD1();
    const env = { DB: fakeDb as any, APP_URL: 'https://arkangel.arksystems.site' } as Env;

    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 't_psc');
      c.set('user', { id: 'usr_1', email: 'test@garza.mx', role: 'admin' });
      await next();
    });
    app.route('/api/v1/nom151', nom151);

    // 1. Guardar settings de ATEB PSC
    const saveRes = await app.request('/api/v1/nom151/psc/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 't_psc' },
      body: JSON.stringify({
        atebEnabled: true,
        atebEnvironment: 'sandbox',
        atebClientId: 'CLI_ATEB_TEST',
        atebApiKey: 'secret_12345',
        atebTsaEnabled: true,
      }),
    }, env);
    expect(saveRes.status).toBe(200);
    const saveJson: any = await saveRes.json();
    expect(saveJson.success).toBe(true);
    expect(saveJson.settings.atebApiKey).toBe('••••••••2345');

    // 2. Consultar settings de ATEB PSC
    const getRes = await app.request('/api/v1/nom151/psc/settings', {
      headers: { 'X-Tenant-Id': 't_psc' },
    }, env);
    expect(getRes.status).toBe(200);
    const getJson: any = await getRes.json();
    expect(getJson.settings.atebClientId).toBe('CLI_ATEB_TEST');

    // 3. Expediente judicial
    const docketRes = await app.request('/api/v1/nom151/cases/cas_psc_1/docket', {
      headers: { 'X-Tenant-Id': 't_psc' },
    }, env);
    expect(docketRes.status).toBe(200);
    const docketJson: any = await docketRes.json();
    expect(docketJson.success).toBe(true);
    expect(docketJson.docket.folioExpediente).toBeDefined();

    // 4. Vista imprimible HTML del expediente
    const printRes = await app.request('/api/v1/nom151/cases/cas_psc_1/docket/printable', {
      headers: { 'X-Tenant-Id': 't_psc' },
    }, env);
    expect(printRes.status).toBe(200);
    const htmlText = await printRes.text();
    expect(htmlText).toContain('CUADERNO DE PRUEBAS ELECTRÓNICAS');

    // 5. Verificación de la cadena WORM
    const wormRes = await app.request('/api/v1/nom151/cases/cas_psc_1/worm-chain', {
      headers: { 'X-Tenant-Id': 't_psc' },
    }, env);
    expect(wormRes.status).toBe(200);
    const wormJson: any = await wormRes.json();
    expect(wormJson.success).toBe(true);
    expect(wormJson.verification.valid).toBe(true);
  });
});
