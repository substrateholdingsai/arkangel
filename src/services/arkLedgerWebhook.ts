/**
 * Servicio de Webhook Saliente hacia ARK-LEDGER
 *
 * Notifica a `ark-ledger` la confirmación o conciliación de pagos SPEI
 * de socios camerales (CANACO SERVYTUR MÉRIDA) para marcar al socio como
 * 'Socio Activo', emitir su Cédula con Sello SHA-256 y registrar su folio SIEM.
 *
 * Endpoint de destino:
 *   POST https://ledger.arksystems.site/api/canaco/webhook-pago-arkangel
 *   (o Service Binding interno env.ARK_LEDGER si está disponible).
 */

import { logger } from '../lib/logger';
import type { Env } from '../types/env';

export interface ArkLedgerPaymentWebhookPayload {
  rfc: string;
  folio_pago?: string;
  monto: number;
  tenant_id?: string;
  metodo?: string;
}

export interface SendArkLedgerPaymentResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export const CANACO_DEFAULT_WEBHOOK_URL =
  'https://ledger.arksystems.site/api/canaco/webhook-pago-arkangel';

/**
 * Despacha el webhook de confirmación de pago hacia ark-ledger.
 */
export async function notifyArkLedgerPayment(
  env: Env,
  payload: ArkLedgerPaymentWebhookPayload
): Promise<SendArkLedgerPaymentResult> {
  const rfcClean = (payload.rfc || '').trim().toUpperCase();
  const tenantId = payload.tenant_id || 'canaco_merida';
  const folioPago = payload.folio_pago || `SPEI-ARK-${Date.now().toString(36).toUpperCase()}`;

  const bodyData = {
    rfc: rfcClean,
    folio_pago: folioPago,
    monto: payload.monto,
    tenant_id: tenantId,
    metodo: payload.metodo || 'spei_1click',
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (env.ARKANGEL_WEBHOOK_SECRET) {
    headers['Authorization'] = `Bearer ${env.ARKANGEL_WEBHOOK_SECRET}`;
  }

  // 1. Intento vía Service Binding de Cloudflare Workers (latencia cero Worker-to-Worker)
  if (env.ARK_LEDGER && typeof env.ARK_LEDGER.fetch === 'function') {
    try {
      const resp = await env.ARK_LEDGER.fetch(
        'https://ledger.internal/api/canaco/webhook-pago-arkangel',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyData),
        }
      );

      const jsonResp = await resp.json().catch(() => ({}));
      if (resp.ok) {
        logger.info('Webhook de pago despachado a ark-ledger vía Service Binding', {
          tenantId,
          rfc: rfcClean,
          folioPago,
        });
      } else {
        logger.warn('Fallo en respuesta de Service Binding de ark-ledger', {
          status: resp.status,
          resp: jsonResp,
        });
      }

      return {
        ok: resp.ok,
        status: resp.status,
        data: jsonResp,
        error: resp.ok ? undefined : `Status ${resp.status}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Error enviando webhook a ark-ledger vía Service Binding', { error: msg });
      // Si falla el Service Binding, intenta fallback a fetch HTTP
    }
  }

  // 2. Vía HTTP REST fetch
  const targetUrl =
    env.ARK_LEDGER_WEBHOOK_URL ||
    (env.ARK_LEDGER_URL
      ? `${env.ARK_LEDGER_URL.replace(/\/$/, '')}/api/canaco/webhook-pago-arkangel`
      : CANACO_DEFAULT_WEBHOOK_URL);

  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyData),
    });

    const jsonResp = await resp.json().catch(() => ({}));
    if (resp.ok) {
      logger.info('Webhook de pago despachado exitosamente a ark-ledger vía HTTP', {
        url: targetUrl,
        tenantId,
        rfc: rfcClean,
        folioPago,
      });
    } else {
      logger.warn('Respuesta no exitosa de webhook en ark-ledger', {
        url: targetUrl,
        status: resp.status,
        resp: jsonResp,
      });
    }

    return {
      ok: resp.ok,
      status: resp.status,
      data: jsonResp,
      error: resp.ok ? undefined : `HTTP ${resp.status}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error de red despachando webhook de pago a ark-ledger', {
      url: targetUrl,
      error: msg,
    });
    return {
      ok: false,
      error: msg,
    };
  }
}
