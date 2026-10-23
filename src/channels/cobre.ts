import { logger } from '../lib/logger';
import type { CanonicalPaymentInput } from '../services/pagos';
import type { Env } from '../types/env';

export const DEFAULT_COBRE_BASE_URL = 'https://api.cobre.co';
const COBRE_TOKEN_TTL_SECONDS = 1080; // 18 min (el JWT de Cobre expira en 20 min / 1200s)

/**
 * Intercambio de credenciales OAuth de Cobre (`POST /v1/auth` -> Bearer JWT).
 * Ref: https://docs.cobre.com/authentication-25933208e0
 * Cachea el access_token en Cloudflare KV por tenant durante 18 minutos.
 */
export async function authenticateCobre(
  env: Env,
  tenantId = 'default',
  credentials?: { userId?: string; secret?: string; baseUrl?: string }
): Promise<string | null> {
  const userId = credentials?.userId ?? env.COBRE_USER_ID;
  const secret = credentials?.secret ?? env.COBRE_SECRET;
  const baseUrl = (credentials?.baseUrl ?? env.COBRE_BASE_URL ?? DEFAULT_COBRE_BASE_URL).replace(
    /\/+$/,
    ''
  );

  if (!userId || !secret) {
    logger.warn('Credenciales de Cobre ausentes (COBRE_USER_ID / COBRE_SECRET)');
    return null;
  }

  const kvKey = `cobre:jwt:${tenantId}`;
  try {
    if (env.KV) {
      const cached = await env.KV.get(kvKey);
      if (cached) return cached;
    }
  } catch {
    /* continúa si KV no está disponible en entorno de test */
  }

  try {
    const response = await fetch(`${baseUrl}/v1/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        secret,
      }),
    });

    if (!response.ok) {
      logger.error('Fallo de autenticación en Cobre /v1/auth', { status: response.status });
      return null;
    }

    const body = (await response.json()) as {
      access_token?: string;
      token?: string;
    };
    const token = body.access_token ?? body.token ?? null;
    if (!token) return null;

    try {
      if (env.KV) {
        await env.KV.put(kvKey, token, { expirationTtl: COBRE_TOKEN_TTL_SECONDS });
      }
    } catch {
      /* continúa sin fallo si KV falla */
    }

    return token;
  } catch (error) {
    logger.error('Error de red al autenticar con Cobre', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Verifica firma HMAC-SHA256 del webhook de Cobre (`x-cobre-signature`). */
export async function verifyCobreHmac(
  secret: string,
  rawBody: string,
  signatureHeader: string
): Promise<boolean> {
  const cleanSig = signatureHeader
    .replace(/^sha256=/i, '')
    .trim()
    .toLowerCase();
  if (!cleanSig || !/^[0-9a-f]+$/.test(cleanSig)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expectedHex.length !== cleanSig.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ cleanSig.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Normaliza los eventos de Cash-In SPEI de Cobre (`accounts.balance.credit` y
 * `money_movements.status.completed`) al formato canónico `CanonicalPaymentInput`.
 */
export function parseCobreWebhook(payload: unknown): CanonicalPaymentInput | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const eventType =
    typeof root.event === 'string' ? root.event : typeof root.type === 'string' ? root.type : '';
  if (
    eventType &&
    !eventType.includes('credit') &&
    !eventType.includes('completed') &&
    !eventType.includes('cash_in') &&
    !eventType.includes('spei')
  ) {
    return null;
  }

  const data =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;

  const destination =
    data.destination && typeof data.destination === 'object'
      ? (data.destination as Record<string, unknown>)
      : null;

  const metadata =
    data.metadata && typeof data.metadata === 'object'
      ? (data.metadata as Record<string, unknown>)
      : null;

  const clabeRaw =
    destination?.account_number ??
    destination?.clabe ??
    data.virtual_clabe ??
    data.clabe ??
    data.account_number ??
    root.clabe;

  const clabe = typeof clabeRaw === 'string' ? clabeRaw.replace(/[\s-]/g, '').trim() : null;

  // Monto: soporta `amount_cents` (entero) o `amount` (decimal o entero en MXN)
  let amountCents = 0;
  if (typeof data.amount_cents === 'number') {
    amountCents = Math.round(data.amount_cents);
  } else if (typeof root.amount_cents === 'number') {
    amountCents = Math.round(root.amount_cents);
  } else if (typeof data.amount === 'number') {
    amountCents = Math.round(data.amount * 100);
  } else if (typeof data.amount === 'string') {
    const parsed = Number.parseFloat(data.amount.replace(/[^0-9.-]/g, ''));
    if (!Number.isNaN(parsed)) amountCents = Math.round(parsed * 100);
  }

  if (amountCents <= 0) return null;

  const trackingRaw =
    data.cep_tracking_key ??
    data.tracking_key ??
    data.clave_rastreo ??
    data.movement_id ??
    data.id ??
    root.id;

  const referenceRaw =
    data.reference ??
    data.concept ??
    data.external_id ??
    metadata?.case_id ??
    metadata?.reference ??
    null;

  return {
    clabe,
    amountCents,
    trackingKey: typeof trackingRaw === 'string' ? trackingRaw : null,
    reference: typeof referenceRaw === 'string' ? referenceRaw : null,
    phone: typeof metadata?.phone === 'string' ? metadata.phone : null,
    email: typeof metadata?.email === 'string' ? metadata.email : null,
    source: 'cobre_spei',
    paidAt: typeof data.completed_at === 'string' ? data.completed_at : null,
  };
}
