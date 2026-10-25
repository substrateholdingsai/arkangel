import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { nom151 } from '../src/routes/nom151';
import {
  sha256Hex,
  buildCadenaOriginal,
  formatLocalTimestamp,
  issueNom151Certificate,
  getNom151CertificateByFolio,
  listNom151CertificatesByCase,
  generateNom151PrintableDocument,
} from '../src/services/nom151';
import type { TenantContext } from '../src/tenancy/types';
import type { AuthVars } from '../src/auth/middleware';
import type { Env } from '../src/types/env';

class FakeNom151D1 {
  certificates: any[] = [];

  clients = [
    {
      id: 'cli_nom_1',
      tenant_id: 't_nom',
      name: 'Alejandro Fernández Abarca',
      phone: '+525544332211',
      email: 'alejandro@ejemplo.com',
    },
  ];

  cases = [
    {
      id: 'cas_nom_1',
      tenant_id: 't_nom',
      client_id: 'cli_nom_1',
      amount_cents: 1500000,
    },
  ];

  tenants = [
    {
      id: 't_nom',
      slug: 'nom_corp',
      razon_social: 'Servicios Jurídicos y Cobranza Especializada S.A. de C.V.',
      condusef_registro: 'CONDUSEF-982310',
    },
  ];

  prepare = (sql: string) => {
    const s = sql.trim();

    return {
      bind: (...params: any[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            if (s.includes('FROM clients WHERE tenant_id = ? AND id = ?')) {
              const [tId, cId] = params;
              const cl = this.clients.find((c) => c.tenant_id === tId && c.id === cId);
              return (cl as unknown as T) || null;
            }

            if (s.includes('FROM nom151_certificates n') && s.includes('WHERE n.certificate_folio = ?')) {
              const folio = params[0];
              const cert = this.certificates.find((c) => c.certificate_folio === folio);
              if (!cert) return null;

              const tenant = this.tenants.find((t) => t.id === cert.tenant_id);
              return {
                ...cert,
                razon_social: tenant?.razon_social || '',
                condusef_registro: tenant?.condusef_registro || '',
              } as unknown as T;
            }

            if (s.includes('FROM tenants WHERE id = ?')) {
              const tId = params[0];
              const t = this.tenants.find((item) => item.id === tId);
              return (t as unknown as T) || null;
            }

            return null;
          },

          all: async <T>(): Promise<{ results: T[] }> => {
            if (s.includes('FROM nom151_certificates') && s.includes('WHERE tenant_id = ? AND case_id = ?')) {
              const [tId, cId] = params;
              const certs = this.certificates.filter((c) => c.tenant_id === tId && c.case_id === cId);
              return { results: certs as unknown as T[] };
            }
            return { results: [] };
          },

          run: async (): Promise<{ success: boolean }> => {
            if (s.includes('INSERT INTO nom151_certificates')) {
              const [
                id,
                tenant_id,
                case_id,
                client_id,
                message_id,
                certificate_folio,
                tipo_notificacion,
                channel,
                provider_id,
                recipient_masked,
                message_content,
                message_digest_sha256,
                cadena_original,
                sello_digital,
                timestamp_utc,
                timestamp_local,
                verification_url,
                metadata,
                created_at,
              ] = params;

              this.certificates.push({
                id,
                tenant_id,
                case_id,
                client_id,
                message_id,
                certificate_folio,
                tipo_notificacion,
                channel,
                provider_id,
                recipient_masked,
                message_content,
                message_digest_sha256,
                cadena_original,
                sello_digital,
                timestamp_utc,
                timestamp_local,
                verification_url,
                status: 'issued',
                metadata,
                created_at,
              });
            }
            return { success: true };
          },
        };
      },
    };
  };
}

function makeEnv(db: FakeNom151D1): Env {
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: 'test',
    APP_URL: 'https://arkangel.arksystems.site',
  } as unknown as Env;
}

function makeTenantCtx(db: FakeNom151D1): TenantContext {
  return {
    tenantId: 't_nom',
    env: makeEnv(db),
    tenant: db.tenants[0] as any,
    config: {} as any,
    channels: {} as any,
    principal: { id: 'usr_test', role: 'admin' } as any,
  };
}

describe('Constancias de Notificación Digital NOM-151 (Sprint 12)', () => {
  describe('Criptografía y Cadena Original', () => {
    it('calcula hashes SHA-256 deterministas', async () => {
      const hash1 = await sha256Hex('Requerimiento de pago formal por $15,000.00 MXN');
      const hash2 = await sha256Hex('Requerimiento de pago formal por $15,000.00 MXN');
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('construye la cadena original con delimitadores estándar ||NOM151|...', () => {
      const cadena = buildCadenaOriginal({
        folio: 'NOM151-2026-ABC123',
        timestampUtc: '2026-10-25T19:00:00.000Z',
        razonSocial: 'Cobranza Especializada',
        condusefRegistro: 'CONDUSEF-100',
        clientId: 'cli_1',
        tipoNotificacion: 'requerimiento_pago',
        channel: 'whatsapp',
        providerId: 'telnyx_msg_1',
        digestSha256: 'abcdef123456',
      });

      expect(cadena).toBe(
        '||NOM151|1.0|NOM151-2026-ABC123|2026-10-25T19:00:00.000Z|Cobranza Especializada|CONDUSEF-100|cli_1|requerimiento_pago|whatsapp|telnyx_msg_1|abcdef123456||'
      );
    });

    it('formatea la marca de tiempo local de México correctamente', () => {
      const local = formatLocalTimestamp('2026-10-25T18:00:00.000Z');
      expect(local).toContain('Centro de México');
    });
  });

  describe('Servicio: issueNom151Certificate & getNom151CertificateByFolio', () => {
    it('emite una constancia NOM-151 con estampado digital y hash inalterable', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const cert = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'requerimiento_pago',
        channel: 'whatsapp',
        messageContent:
          'Estimado Alejandro, le notificamos saldo pendiente por $15,000.00 MXN. Favor de comunicarse.',
        providerId: 'telnyx_wa_101',
      });

      expect(cert.id).toMatch(/^nom_/);
      expect(cert.certificateFolio).toMatch(/^NOM151-2026-[A-Z0-9]{6}$/);
      expect(cert.recipientMasked).toContain('A****** F****** A*****');
      expect(cert.messageDigestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(cert.selloDigital).toMatch(/^[a-f0-9]{64}$/);
      expect(cert.verificationUrl).toContain('/verify/nom151/');
    });

    it('verifica públicamente la validez de la constancia (tamper-proof)', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const issued = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'carta_convenio',
        channel: 'sms',
        messageContent: 'Convenio formal autorizado con 25% de quita. Pague antes del 28 de octubre.',
        providerId: 'sms_9988',
      });

      const res = await getNom151CertificateByFolio(ctx.env, issued.certificateFolio);

      expect(res).not.toBeNull();
      expect(res?.valid).toBe(true);
      expect(res?.verificationDetails.digestMatches).toBe(true);
      expect(res?.verificationDetails.sealMatches).toBe(true);
      expect(res?.verificationDetails.legalAuthority).toContain('Código de Comercio');
    });

    it('detecta alteración del contenido (tamper detection) invalidando la constancia', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const issued = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'aviso_cobranza',
        channel: 'email',
        messageContent: 'Aviso original de cobranza.',
      });

      // Simular intento de alteración maliciosa en el contenido del mensaje
      const stored = db.certificates.find((c) => c.certificate_folio === issued.certificateFolio);
      if (stored) {
        stored.message_content = 'Aviso alterado maliciosamente con monto falso.';
      }

      const res = await getNom151CertificateByFolio(ctx.env, issued.certificateFolio);
      expect(res).not.toBeNull();
      expect(res?.valid).toBe(false); // Falla la verificación de integridad
      expect(res?.verificationDetails.digestMatches).toBe(false);
    });

    it('devuelve null si el folio no existe en el registro', async () => {
      const db = new FakeNom151D1();
      const env = makeEnv(db);
      const res = await getNom151CertificateByFolio(env, 'NOM151-2026-INEXISTENTE');
      expect(res).toBeNull();
    });
  });

  describe('Servicio: listNom151CertificatesByCase & generateNom151PrintableDocument', () => {
    it('lista todas las constancias asociadas al expediente', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'requerimiento_pago',
        channel: 'whatsapp',
        messageContent: 'Notificación 1',
      });

      await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'carta_convenio',
        channel: 'portal',
        messageContent: 'Notificación 2',
      });

      const list = await listNom151CertificatesByCase(ctx, 'cas_nom_1');
      expect(list.length).toBe(2);
      expect(list.map((c) => c.tipoNotificacion)).toContain('requerimiento_pago');
      expect(list.map((c) => c.tipoNotificacion)).toContain('carta_convenio');
    });

    it('genera la representación documental imprimible con fundamentos del Código de Comercio', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const issued = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'carta_finiquito',
        channel: 'portal',
        messageContent: 'Deuda liquidada al 100%. Saldo en ceros.',
      });

      const doc = await generateNom151PrintableDocument(ctx.env, issued.certificateFolio);

      expect(doc).not.toBeNull();
      expect(doc?.titulo).toContain('FINIQUITO');
      expect(doc?.emisorRazonSocial).toContain('Servicios Jurídicos y Cobranza Especializada');
      expect(doc?.fundamentoLegal.some((f) => f.includes('ARTÍCULO 89 DEL CÓDIGO DE COMERCIO'))).toBe(true);
      expect(doc?.fundamentoLegal.some((f) => f.includes('NOM-151-SCFI-2016'))).toBe(true);
    });
  });

  describe('Rutas HTTP: nom151 router', () => {
    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/api/v1/nom151', nom151);

    it('GET /api/v1/nom151/:folio permite verificación pública de autenticidad', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const cert = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'requerimiento_pago',
        channel: 'sms',
        messageContent: 'Texto certificado',
      });

      const res = await app.request(`/api/v1/nom151/${cert.certificateFolio}`, {}, ctx.env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.valid).toBe(true);
      expect(body.folio).toBe(cert.certificateFolio);
      expect(body.verificationDetails.digestMatches).toBe(true);
    });

    it('GET /api/v1/nom151/:folio/document entrega el documento legal', async () => {
      const db = new FakeNom151D1();
      const ctx = makeTenantCtx(db);

      const cert = await issueNom151Certificate(ctx, {
        caseId: 'cas_nom_1',
        clientId: 'cli_nom_1',
        tipoNotificacion: 'carta_convenio',
        channel: 'whatsapp',
        messageContent: 'Convenio formal emitido',
      });

      const res = await app.request(`/api/v1/nom151/${cert.certificateFolio}/document`, {}, ctx.env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.document.folio).toBe(cert.certificateFolio);
      expect(body.document.selloDigital).toBeDefined();
    });

    it('GET /api/v1/nom151/:folio devuelve 404 si el folio no existe', async () => {
      const db = new FakeNom151D1();
      const env = makeEnv(db);

      const res = await app.request('/api/v1/nom151/NOM151-NO-EXISTE', {}, env);
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toBe('certificate_not_found');
    });
  });
});
