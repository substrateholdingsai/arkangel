/**
 * Rutas del Portal de Autoservicio del Deudor (Self-Service Debtor Portal).
 *
 * Expone endpoints públicos blindados (fail-closed, datos enmascarados bajo CONDUSEF)
 * para consulta de convenio, copiado de CLABE SPEI, confirmación de transferencia
 * y emisión de Carta Convenio / Finiquito en formato digital oficial.
 */

import { Hono } from 'hono';
import { logger } from '../lib/logger';
import {
  getDebtorPortalData,
  confirmDebtorPayment,
  getDebtorLegalDocument,
  type DebtorPaymentConfirmation,
} from '../services/debtorPortal';
import type { Env } from '../types/env';
import type { AuthVars } from '../auth/middleware';

export const portal = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * GET /api/v1/portal/:id
 * Consulta pública del convenio/caso de autoservicio.
 * Retorna datos sanitizados (nombre y teléfono enmascarados).
 */
portal.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'id_required', message: 'Identificador de pago no proporcionado' }, 400);
  }

  try {
    const data = await getDebtorPortalData(c.env, id);
    if (!data) {
      return c.json(
        {
          error: 'portal_not_found',
          message: 'El enlace de pago o convenio no existe o no se encuentra activo.',
        },
        404
      );
    }

    return c.json({ success: true, portal: data });
  } catch (error: any) {
    logger.error('Error consultando portal deudor', { id, error: error?.message });
    return c.json({ error: 'internal_error', message: 'No se pudo cargar el portal de pago' }, 500);
  }
});

/**
 * POST /api/v1/portal/:id/confirm
 * Reporte de transferencia SPEI realizada por el titular del crédito.
 */
portal.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'id_required', message: 'Identificador no proporcionado' }, 400);
  }

  try {
    const body = await c.req.json<DebtorPaymentConfirmation>().catch(() => ({}));
    const result = await confirmDebtorPayment(c.env, id, body);
    return c.json(result);
  } catch (error: any) {
    logger.error('Error registrando confirmación de pago en portal', { id, error: error?.message });
    return c.json(
      {
        error: 'confirm_failed',
        message: error?.message || 'No se pudo registrar la confirmación del pago.',
      },
      400
    );
  }
});

/**
 * GET /api/v1/portal/:id/document
 * Genera la Carta Convenio o Carta Finiquito legal oficial (CONDUSEF REDECO Art. 112 Bis).
 */
portal.get('/:id/document', async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'id_required', message: 'Identificador no proporcionado' }, 400);
  }

  try {
    const document = await getDebtorLegalDocument(c.env, id);
    if (!document) {
      return c.json(
        { error: 'document_not_found', message: 'Documento legal no disponible para este folio' },
        404
      );
    }

    return c.json({ success: true, document });
  } catch (error: any) {
    logger.error('Error generando documento legal en portal', { id, error: error?.message });
    return c.json({ error: 'internal_error', message: 'No se pudo generar el documento legal' }, 500);
  }
});
