import { Hono } from 'hono';
import { parseCobreWebhook, verifyCobreHmac } from '../channels/cobre';
import { parseConektaWebhook, verifyConektaDigest } from '../channels/conekta';
import { parseResendPayload } from '../channels/resend';
import { parseTelnyxPayload } from '../channels/telnyx';
import {
  isTelnyxVoiceEvent,
  parseTelnyxVoiceEvent,
  processTelnyxVoiceEvent,
} from '../channels/telnyxVoice';
import {
  parseWhatsAppPayload,
  verifyWhatsAppSignature,
  whatsappChallengeResponse,
} from '../channels/whatsapp';
import { verifyEd25519 } from '../lib/crypto';
import { logger } from '../lib/logger';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import { handleInbound } from '../orquestacion/inbound';
import { updateMessageStatus } from '../services/mensajes';
import { actualizarEstadoEnvio, procesarInboundOptOut } from '../services/comunicacion';
import { normalizePhone } from '../lib/phone';
import { reconcilePayment } from '../services/pagos';
import { resolveTenantContext, resolveTenantIdForInbound } from '../tenancy/context';

export const webhooks = new Hono<{ Bindings: Env; Variables: AuthVars }>();

async function processParsed(
  env: Env,
  parsed: {
    messages: import('../channels/types').InboundMessage[];
    statuses: import('../channels/types').StatusUpdate[];
  }
): Promise<void> {
  for (const status of parsed.statuses) {
    await updateMessageStatus(env, status.providerId, status.status);
    await actualizarEstadoEnvio(env, status.providerId, status.status);
  }

  for (const message of parsed.messages) {
    try {
      // El tenant se deduce del enrutado del proveedor, no de lo que diga el
      // cliente: es lo que evita que un deudor de la empresa A se atribuya a la B.
      message.tenantId = await resolveTenantIdForInbound(env, message);

      // Verificación prioritaria de solicitud de baja (Opt-out anti-spam)
      const phone = normalizePhone(message.from) ?? message.from;
      const optOut = await procesarInboundOptOut(env, phone, message.body, message.tenantId);
      if (optOut.handled) {
        logger.info('Opt-out procesado desde webhook inbound', {
          contacto: phone,
          tenantsAfectados: optOut.tenantsAfectados,
        });
      }

      await handleInbound(env, message);
    } catch (error) {
      logger.error('Error procesando inbound', {
        channel: message.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ── WhatsApp (Telnyx API v2 / Meta) ──────────────────────────────────
webhooks.get('/whatsapp', (c) => {
  const verifyToken = c.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return c.text('ok');
  const response = whatsappChallengeResponse(c.req.raw, verifyToken);
  return response ?? c.text('ok');
});

webhooks.post('/whatsapp', async (c) => {
  const raw = await c.req.text();

  // 1. Verificación Ed25519 si llega desde Telnyx
  const telnyxSig = c.req.header('telnyx-signature-ed25519');
  const telnyxTs = c.req.header('telnyx-timestamp');
  const telnyxPubKey = c.env.TELNYX_WEBHOOK_PUBLIC_KEY;

  if (telnyxSig || telnyxTs) {
    if (telnyxPubKey) {
      if (!telnyxSig || !telnyxTs) return c.json({ error: 'missing_signature' }, 401);
      const valid = await verifyEd25519(telnyxPubKey, telnyxSig, telnyxTs, raw);
      if (!valid) {
        logger.warn('Firma Ed25519 de Telnyx WhatsApp inválida');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }
  } else {
    // 2. Verificación HMAC-SHA256 si llega desde Meta Graph
    const appSecret = c.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const signature = c.req.header('x-hub-signature-256');
      if (!signature) return c.json({ error: 'missing_signature' }, 401);
      const valid = await verifyWhatsAppSignature(appSecret, raw, signature);
      if (!valid) {
        logger.warn('Firma HMAC de Meta WhatsApp inválida');
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }
  }

  const parsed = parseWhatsAppPayload(safeJson(raw));
  await processParsed(c.env, parsed);
  return c.json({ ok: true });
});

// ── Telnyx (SMS y WhatsApp) ───────────────────────────────────────────
webhooks.post('/telnyx', async (c) => {
  const raw = await c.req.text();

  const publicKey = c.env.TELNYX_WEBHOOK_PUBLIC_KEY;
  if (publicKey) {
    const signature = c.req.header('telnyx-signature-ed25519');
    const timestamp = c.req.header('telnyx-timestamp');
    if (!signature || !timestamp) return c.json({ error: 'missing_signature' }, 401);
    const valid = await verifyEd25519(publicKey, signature, timestamp, raw);
    if (!valid) {
      logger.warn('Firma de Telnyx inválida');
      return c.json({ error: 'invalid_signature' }, 401);
    }
  }

  const json = safeJson(raw);
  if (isTelnyxVoiceEvent(json)) {
    const voiceEvent = parseTelnyxVoiceEvent(json);
    if (voiceEvent) {
      await processTelnyxVoiceEvent(c.env, voiceEvent);
    }
    return c.json({ ok: true, type: 'voice' });
  }

  const parsed = parseTelnyxPayload(json);
  await processParsed(c.env, parsed);
  return c.json({ ok: true, type: 'messaging' });
});

// ── Resend (email entrante) ────────────────────────────────────────────
webhooks.post('/resend', async (c) => {
  const contentType = c.req.header('content-type') ?? '';

  if (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    const form = await c.req.formData();
    const payload = {
      from: String(form.get('from') ?? ''),
      to: String(form.get('to') ?? ''),
      subject: String(form.get('subject') ?? ''),
      text: String(form.get('text') ?? ''),
      html: String(form.get('html') ?? ''),
    };
    const parsed = parseResendPayload(payload);
    await processParsed(c.env, parsed);
    return c.json({ ok: true });
  }

  const raw = await c.req.text();
  const parsed = parseResendPayload(safeJson(raw));
  await processParsed(c.env, parsed);
  return c.json({ ok: true });
});

// ── Cobre (Cash-In SPEI / CLABEs Virtuales) ───────────────────────────
webhooks.post('/cobre', async (c) => {
  const raw = await c.req.text();

  const webhookSecret = c.env.COBRE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = c.req.header('x-cobre-signature') ?? c.req.header('cobre-signature') ?? '';
    if (!sig) return c.json({ error: 'missing_signature' }, 401);
    const valid = await verifyCobreHmac(webhookSecret, raw, sig);
    if (!valid) {
      logger.warn('Firma HMAC de Cobre inválida');
      return c.json({ error: 'invalid_signature' }, 401);
    }
  }

  const payment = parseCobreWebhook(safeJson(raw));
  if (!payment) {
    return c.json({ ok: true, ignored: true });
  }

  // Resolver el tenant dueño de la CLABE virtual en contracts
  let tenantId: string | undefined;
  if (payment.clabe) {
    try {
      const row = await c.env.DB.prepare(
        'SELECT tenant_id FROM contracts WHERE clabe = ? ORDER BY updated_at DESC LIMIT 1'
      )
        .bind(payment.clabe)
        .first<{ tenant_id: string }>();
      if (row?.tenant_id) tenantId = row.tenant_id;
    } catch {
      /* fallback al tenant por defecto */
    }
  }

  const ctx = await resolveTenantContext(c.env, tenantId ? { tenantId } : {});
  const result = await reconcilePayment(ctx, payment);

  logger.info('Webhook de Cobre procesado', {
    tenantId: ctx.tenantId,
    status: result.status,
    clabe: payment.clabe,
    amountCents: payment.amountCents,
    trackingKey: payment.trackingKey,
  });

  return c.json({ ok: true, result });
});

// ── Conekta (SPEI CLABE / OXXO Pay · `order.paid` & `charge.paid`) ─────
webhooks.post('/conekta', async (c) => {
  const raw = await c.req.text();

  const publicKey = c.env.CONEKTA_WEBHOOK_PUBLIC_KEY;
  if (publicKey) {
    const digest = c.req.header('digest') ?? c.req.header('DIGEST') ?? '';
    if (!digest) return c.json({ error: 'missing_digest' }, 401);
    const valid = await verifyConektaDigest(publicKey, raw, digest);
    if (!valid) {
      logger.warn('Firma RSA DIGEST de Conekta inválida');
      return c.json({ error: 'invalid_digest' }, 401);
    }
  }

  const parsedJson = safeJson(raw);
  const payment = parseConektaWebhook(parsedJson);
  if (!payment) {
    return c.json({ ok: true, ignored: true });
  }

  // Resolver tenant por metadata.tenant_id o por CLABE en contracts
  let tenantId: string | undefined;
  const rootObj = parsedJson as {
    data?: { object?: { metadata?: { tenant_id?: string } } };
  };
  if (typeof rootObj?.data?.object?.metadata?.tenant_id === 'string') {
    tenantId = rootObj.data.object.metadata.tenant_id;
  }

  if (!tenantId && payment.clabe) {
    try {
      const row = await c.env.DB.prepare(
        'SELECT tenant_id FROM contracts WHERE clabe = ? ORDER BY updated_at DESC LIMIT 1'
      )
        .bind(payment.clabe)
        .first<{ tenant_id: string }>();
      if (row?.tenant_id) tenantId = row.tenant_id;
    } catch {
      /* fallback al tenant por defecto */
    }
  }

  const ctx = await resolveTenantContext(c.env, tenantId ? { tenantId } : {});
  const result = await reconcilePayment(ctx, payment);

  logger.info('Webhook de Conekta procesado', {
    tenantId: ctx.tenantId,
    status: result.status,
    clabe: payment.clabe,
    amountCents: payment.amountCents,
    trackingKey: payment.trackingKey,
  });

  return c.json({ ok: true, result });
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
