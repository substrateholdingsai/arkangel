/**
 * Rutas de Constancias de Notificación Digital NOM-151-SCFI-2016,
 * Conector ATEB Servicios PSC y Cuaderno Judicial de Pruebas Informáticas.
 *
 * Expone:
 * 1. Endpoints públicos para cotejo y verificación de validez probatoria ante juzgados y CONDUSEF.
 * 2. Endpoints protegidos para consulta y emisión de constancias dentro del expediente del caso.
 * 3. Endpoints para configuración del PSC (ATEB) por tenant.
 * 4. Endpoints para generación y visualización imprimible del Expediente Judicial / Materialidad Fiscal.
 */

import { Hono } from 'hono';
import { logger } from '../lib/logger';
import { resolveTenantContextDeRequest } from '../tenancy/context';
import {
  getNom151CertificateByFolio,
  generateNom151PrintableDocument,
  listNom151CertificatesByCase,
  issueNom151Certificate,
  type IssueNom151Input,
} from '../services/nom151';
import {
  getTenantPscSettings,
  upsertTenantPscSettings,
  type TenantPscSettings,
} from '../services/atebPscClient';
import {
  generateCaseJudicialDocket,
  renderJudicialDocketHtml,
} from '../services/judicialDocket';
import { verifyWormChain } from '../services/custodyWorm';
import type { Env } from '../types/env';
import type { AuthVars } from '../auth/middleware';

export const nom151 = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * GET /api/v1/nom151/psc/settings
 * Consulta la configuración de ATEB PSC del tenant.
 */
nom151.get('/psc/settings', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const settings = await getTenantPscSettings(c.env, ctx.tenantId);
    return c.json({
      success: true,
      settings: {
        ...settings,
        // Enmascarar la API key por seguridad
        atebApiKey: settings.atebApiKey ? '••••••••' + settings.atebApiKey.slice(-4) : null,
      },
    });
  } catch (error: any) {
    logger.error('Error consultando settings de ATEB PSC', { error: error?.message });
    return c.json({ error: 'settings_query_failed', message: error?.message }, 500);
  }
});

/**
 * POST /api/v1/nom151/psc/settings
 * Guarda o actualiza credenciales y opciones de ATEB PSC del tenant.
 */
nom151.post('/psc/settings', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const body = await c.req.json<Partial<TenantPscSettings>>();

    const updated = await upsertTenantPscSettings(c.env, {
      ...body,
      tenantId: ctx.tenantId,
    });

    return c.json({
      success: true,
      settings: {
        ...updated,
        atebApiKey: updated.atebApiKey ? '••••••••' + updated.atebApiKey.slice(-4) : null,
      },
    });
  } catch (error: any) {
    logger.error('Error guardando settings de ATEB PSC', { error: error?.message });
    return c.json({ error: 'settings_save_failed', message: error?.message }, 500);
  }
});

/**
 * GET /api/v1/nom151/cases/:caseId/docket
 * Compila los datos completos del expediente judicial y de materialidad fiscal del caso.
 */
nom151.get('/cases/:caseId/docket', async (c) => {
  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ error: 'case_id_required', message: 'Identificador de caso requerido' }, 400);
  }

  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const docket = await generateCaseJudicialDocket(ctx, caseId);
    if (!docket) {
      return c.json({ error: 'case_not_found', message: 'Caso no encontrado' }, 404);
    }

    return c.json({ success: true, docket });
  } catch (error: any) {
    logger.error('Error generando expediente judicial', { caseId, error: error?.message });
    return c.json({ error: 'docket_generation_failed', message: error?.message }, 500);
  }
});

/**
 * GET /api/v1/nom151/cases/:caseId/docket/printable
 * Renderiza el Cuaderno Judicial y de Materialidad en HTML listo para impresión o PDF oficial.
 */
nom151.get('/cases/:caseId/docket/printable', async (c) => {
  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.text('Identificador de caso requerido', 400);
  }

  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const docket = await generateCaseJudicialDocket(ctx, caseId);
    if (!docket) {
      return c.text('Caso no encontrado', 404);
    }

    const html = renderJudicialDocketHtml(docket);
    return c.html(html);
  } catch (error: any) {
    logger.error('Error generando vista imprimible de expediente judicial', {
      caseId,
      error: error?.message,
    });
    return c.text('Error generando el expediente judicial: ' + error?.message, 500);
  }
});

/**
 * GET /api/v1/nom151/cases/:caseId/worm-chain
 * Verifica matemáticamente la cadena de custodia WORM del caso.
 */
nom151.get('/cases/:caseId/worm-chain', async (c) => {
  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ error: 'case_id_required', message: 'Identificador de caso requerido' }, 400);
  }

  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const verification = await verifyWormChain(c.env, ctx.tenantId, caseId);
    return c.json({ success: true, verification });
  } catch (error: any) {
    logger.error('Error verificando cadena WORM', { caseId, error: error?.message });
    return c.json({ error: 'worm_verification_failed', message: error?.message }, 500);
  }
});

/**
 * GET /api/v1/nom151/:folio
 * Cotejo público e inalterable de una Constancia NOM-151.
 * Retorna estado de verificación criptográfica (SHA-256 digest + digital seal match).
 */
nom151.get('/:folio', async (c) => {
  const folio = c.req.param('folio');
  if (!folio) {
    return c.json({ error: 'folio_required', message: 'Folio NOM-151 requerido' }, 400);
  }

  try {
    const verification = await getNom151CertificateByFolio(c.env, folio);
    if (!verification) {
      return c.json(
        {
          error: 'certificate_not_found',
          message: 'Constancia NOM-151 no localizada. Verifique el folio.',
        },
        404
      );
    }

    // Protección de secreto bancario y financiero: el endpoint público expone
    // la prueba matemática de integridad, pero resguarda el texto original de terceros
    const publicCertificate = {
      ...verification.certificate,
      messageContent: '[CONFIDENCIAL — VERIFICABLE MEDIANTE DIGEST SHA-256]',
    };

    return c.json({
      success: true,
      valid: verification.valid,
      folio: verification.folio,
      certificate: publicCertificate,
      verificationDetails: verification.verificationDetails,
    });
  } catch (error: any) {
    logger.error('Error verificando constancia NOM-151', { folio, error: error?.message });
    return c.json(
      { error: 'internal_error', message: 'No se pudo verificar la constancia NOM-151' },
      500
    );
  }
});

/**
 * GET /api/v1/nom151/:folio/document
 * Genera la representación imprimible oficial de la Constancia NOM-151 con fundamentación jurídica.
 */
nom151.get('/:folio/document', async (c) => {
  const folio = c.req.param('folio');
  if (!folio) {
    return c.json({ error: 'folio_required', message: 'Folio NOM-151 requerido' }, 400);
  }

  try {
    const doc = await generateNom151PrintableDocument(c.env, folio);
    if (!doc) {
      return c.json(
        { error: 'certificate_not_found', message: 'Documento legal no encontrado' },
        404
      );
    }

    return c.json({ success: true, document: doc });
  } catch (error: any) {
    logger.error('Error generando documento NOM-151', { folio, error: error?.message });
    return c.json(
      { error: 'internal_error', message: 'No se pudo generar el documento NOM-151' },
      500
    );
  }
});

/**
 * GET /api/v1/nom151/cases/:caseId
 * Consulta autenticada de constancias NOM-151 emitidas para un caso de cobranza.
 */
nom151.get('/cases/:caseId', async (c) => {
  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ error: 'case_id_required', message: 'Identificador de caso requerido' }, 400);
  }

  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const certs = await listNom151CertificatesByCase(ctx, caseId);
    return c.json({ success: true, certificates: certs });
  } catch (error: any) {
    logger.error('Error listando constancias NOM-151 por caso', { caseId, error: error?.message });
    return c.json(
      { error: 'internal_error', message: 'No se pudieron consultar las constancias NOM-151' },
      500
    );
  }
});

/**
 * POST /api/v1/nom151/cases/:caseId/issue
 * Emisión manual o asistida de una Constancia NOM-151 desde el expediente.
 */
nom151.post('/cases/:caseId/issue', async (c) => {
  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ error: 'case_id_required', message: 'Identificador de caso requerido' }, 400);
  }

  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const body = await c.req.json<Partial<IssueNom151Input>>();

    if (!body.clientId || !body.tipoNotificacion || !body.channel || !body.messageContent) {
      return c.json(
        {
          error: 'invalid_payload',
          message:
            'Campos obligatorios: clientId, tipoNotificacion, channel y messageContent.',
        },
        400
      );
    }

    const cert = await issueNom151Certificate(ctx, {
      caseId,
      clientId: body.clientId,
      tipoNotificacion: body.tipoNotificacion,
      channel: body.channel,
      messageContent: body.messageContent,
      messageId: body.messageId || null,
      providerId: body.providerId || null,
      metadata: body.metadata || null,
    });

    return c.json({ success: true, certificate: cert });
  } catch (error: any) {
    logger.error('Error emitiendo constancia NOM-151', { caseId, error: error?.message });
    return c.json(
      { error: 'issue_failed', message: error?.message || 'No se pudo emitir la constancia NOM-151' },
      500
    );
  }
});
