import { Hono } from 'hono';
import { parseResendPayload } from '../channels/resend';
import { parseTelnyxPayload } from '../channels/telnyx';
import { parseWhatsAppPayload, whatsappChallengeResponse } from '../channels/whatsapp';
import { verifyEd25519 } from '../lib/crypto';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import { handleInbound } from '../orquestacion/inbound';
import { updateMessageStatus } from '../services/mensajes';

export const webhooks = new Hono<{ Bindings: Env }>();

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

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
