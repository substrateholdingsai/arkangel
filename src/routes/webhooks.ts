import { Hono } from 'hono';
import { parseCobreWebhook, verifyCobreHmac } from '../channels/cobre';
import { parseConektaWebhook, verifyConektaDigest } from '../channels/conekta';
import { parseResendPayload } from '../channels/resend';
import { parseTelnyxPayload } from '../channels/telnyx';
import { parseWhatsAppPayload, whatsappChallengeResponse } from '../channels/whatsapp';
import { verifyEd25519 } from '../lib/crypto';
import { logger } from '../lib/logger';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import { handleInbound } from '../orquestacion/inbound';
import { updateMessageStatus } from '../services/mensajes';
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
  }

  for (const message of parsed.messages) {
    try {
      // El tenant se deduce del enrutado del proveedor, no de lo que diga el
      // cliente: es lo que evita que un deudor de la empresa A se atribuya a la B.
      message.tenantId = await resolveTenantIdForInbound(env, message);
      await handleInbound(env, message);
    } catch (error) {
      logger.error('Error procesando inbound', {
        channel: message.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ── WhatsApp Cloud API ────────────────────────────────────────────────
webhooks.get('/whatsapp', (c) => {
  const response = whatsappChallengeResponse(c.req.raw, c.env.WHATSAPP_VERIFY_TOKEN);
  return response ?? c.text('ok');
});

webhooks.post('/whatsapp', async (c) => {
  const raw = await c.req.text();
  const parsed = parseWhatsAppPayload(safeJson(raw));
  await processParsed(c.env, parsed);
  return c.json({ ok: true });
});

// ── Telnyx (SMS) ───────────────────────────────────────────────────────
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

  const parsed = parseTelnyxPayload(safeJson(raw));
  await processParsed(c.env, parsed);
  return c.json({ ok: true });
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
