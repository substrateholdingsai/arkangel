import { logger } from '../lib/logger';
import type { CanonicalPaymentInput } from '../services/pagos';
import type { Env } from '../types/env';

export const CONEKTA_API_URL = 'https://api.conekta.io';
export const CONEKTA_ACCEPT_HEADER = 'application/vnd.conekta-v2.2.0+json';

/**
 * Cabeceras de autenticación oficial de Conekta.
 * Ref: https://developers.conekta.com/reference/autenticación
 * Soporta `Bearer key_xxx` (v2.2+) y `Basic base64(key_xxx:)` para máxima compatibilidad.
 */
export function conektaAuthHeaders(
  apiKey: string,
  mode: 'bearer' | 'basic' = 'bearer'
): Record<string, string> {
  const cleanKey = apiKey.trim();
  const authValue = mode === 'basic' ? `Basic ${btoa(`${cleanKey}:`)}` : `Bearer ${cleanKey}`;

  return {
    Authorization: authValue,
    Accept: CONEKTA_ACCEPT_HEADER,
    'Accept-Language': 'es',
    'Content-Type': 'application/json',
  };
}

export interface ConektaSpeiOrderInput {
  tenantId: string;
  caseId: string;
  clientId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountCents: number;
  description: string;
}

export interface ConektaSpeiOrderResult {
  orderId: string;
  clabe: string | null;
  bank: string | null;
}

/**
 * Crea una orden SPEI en Conekta (`POST /orders`) y devuelve la CLABE interbancaria
 * única generada para ese caso/deudor.
 */
export async function createConektaSpeiOrder(
  env: Env,
  input: ConektaSpeiOrderInput,
  customApiKey?: string
): Promise<ConektaSpeiOrderResult | null> {
  const apiKey = customApiKey ?? env.CONEKTA_API_KEY;
  if (!apiKey) {
    logger.warn('Falta CONEKTA_API_KEY para generar orden SPEI');
    return null;
  }

  try {
    const response = await fetch(`${CONEKTA_API_URL}/orders`, {
      method: 'POST',
      headers: conektaAuthHeaders(apiKey, 'bearer'),
      body: JSON.stringify({
        currency: 'MXN',
        customer_info: {
          name: input.customerName,
          email: input.customerEmail || 'cobranza@arksystems.site',
          phone: input.customerPhone,
        },
        line_items: [
          {
            name: input.description || `Liquidación de adeudo · Caso ${input.caseId}`,
            unit_price: input.amountCents,
            quantity: 1,
          },
        ],
        charges: [
          {
            payment_method: {
              type: 'spei',
            },
          },
        ],
        metadata: {
          tenant_id: input.tenantId,
          case_id: input.caseId,
          client_id: input.clientId,
        },
      }),
    });

    if (!response.ok) {
      logger.error('Conekta /orders devolvió error', { status: response.status });
      return null;
    }

    const order = (await response.json()) as {
      id?: string;
      charges?: {
        data?: Array<{
          payment_method?: {
            clabe?: string;
            receiving_account_number?: string;
            receiving_account_bank?: string;
            bank?: string;
          };
        }>;
      };
    };

    const pm = order.charges?.data?.[0]?.payment_method;
    const clabe = pm?.clabe ?? pm?.receiving_account_number ?? null;
    const bank = pm?.receiving_account_bank ?? pm?.bank ?? 'STP';

    return {
      orderId: order.id ?? '',
      clabe,
      bank,
    };
  } catch (error) {
    logger.error('Error de red al crear orden SPEI en Conekta', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Verifica la firma RSA-SHA256 del header `DIGEST` de los Webhooks de Conekta.
 */
export async function verifyConektaDigest(
  publicKeyPem: string,
  rawBody: string,
  digestHeader: string
): Promise<boolean> {
  try {
    const b64Key = publicKeyPem
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    if (!b64Key) return false;

    const keyBin = Uint8Array.from(atob(b64Key), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      'spki',
      keyBin.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const cleanDigest = digestHeader.replace(/^SHA-256=/i, '').trim();
    const sigBin = Uint8Array.from(atob(cleanDigest), (c) => c.charCodeAt(0));
    const dataBin = new TextEncoder().encode(rawBody);

    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sigBin, dataBin);
  } catch {
    return false;
  }
}

/**
 * Normaliza los eventos `order.paid` y `charge.paid` de Conekta al formato
 * canónico `CanonicalPaymentInput` (`source: 'conekta_spei'`).
 * Nota: Conekta expresa todos los montos en centavos enteros (ej. `845000` = `$8,450.00 MXN`).
 */
export function parseConektaWebhook(payload: unknown): CanonicalPaymentInput | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const type = typeof root.type === 'string' ? root.type : '';
  if (type && type !== 'order.paid' && type !== 'charge.paid') {
    return null;
  }

  const data =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const obj =
    data.object && typeof data.object === 'object'
      ? (data.object as Record<string, unknown>)
      : data;

  // En `order.paid`, los cargos están en `obj.charges.data[0]`
  const chargesWrapper =
    obj.charges && typeof obj.charges === 'object'
      ? (obj.charges as { data?: Array<Record<string, unknown>> })
      : null;
  const firstCharge = chargesWrapper?.data?.[0] ?? obj;

  const pm =
    firstCharge.payment_method && typeof firstCharge.payment_method === 'object'
      ? (firstCharge.payment_method as Record<string, unknown>)
      : null;

  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : null;

  const customerInfo =
    obj.customer_info && typeof obj.customer_info === 'object'
      ? (obj.customer_info as Record<string, unknown>)
      : null;

  const clabeRaw =
    pm?.clabe ?? pm?.receiving_account_number ?? obj.clabe ?? metadata?.clabe ?? null;
  const clabe = typeof clabeRaw === 'string' ? clabeRaw.replace(/[\s-]/g, '').trim() : null;

  const amountRaw = obj.amount ?? firstCharge.amount ?? root.amount_cents;
  const amountCents = typeof amountRaw === 'number' ? Math.round(amountRaw) : 0;
  if (amountCents <= 0) return null;

  const trackingRaw = pm?.reference ?? firstCharge.id ?? obj.id ?? root.id ?? null;

  const referenceRaw =
    metadata?.case_id ??
    metadata?.reference ??
    obj.reference_id ??
    (typeof obj.id === 'string' ? obj.id : null);

  return {
    clabe,
    amountCents,
    trackingKey: typeof trackingRaw === 'string' ? trackingRaw : null,
    reference: typeof referenceRaw === 'string' ? referenceRaw : null,
    phone: typeof customerInfo?.phone === 'string' ? customerInfo.phone : null,
    email: typeof customerInfo?.email === 'string' ? customerInfo.email : null,
    source: 'conekta_spei',
    paidAt:
      typeof firstCharge.paid_at === 'number'
        ? new Date(firstCharge.paid_at * 1000).toISOString()
        : null,
  };
}
