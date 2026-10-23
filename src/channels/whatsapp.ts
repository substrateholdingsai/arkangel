// WhatsApp Cloud API (Meta Graph) — https://developers.facebook.com/docs/whatsapp/cloud-api
import { bytesToHex, timingSafeEqual } from '../lib/crypto';
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import {
  isDryRun,
  mapProviderStatus,
  type ChannelAdapter,
  type InboundMessage,
  type ParsedInbound,
  type SendParams,
  type SendResult,
  type StatusUpdate,
} from './types';

const GRAPH_VERSION = 'v19.0';

/**
 * Verifica la firma HMAC-SHA256 de Meta (`X-Hub-Signature-256: sha256=<hex>`).
 * Devuelve `false` si el encabezado falta, no tiene prefijo `sha256=` o no coincide.
 */
export async function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null | undefined
): Promise<boolean> {
  if (!appSecret || !signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(trimmed)) return false;
  const providedHex = trimmed.slice('sha256='.length).toLowerCase();

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const expectedHex = bytesToHex(new Uint8Array(sigBuf));
    return timingSafeEqual(expectedHex, providedHex);
  } catch {
    return false;
  }
}

interface MetaMessage {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: MetaMessage[];
}

export function parseWhatsAppPayload(payload: unknown): ParsedInbound {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const entries =
    (payload as { entry?: Array<{ changes?: Array<{ value?: MetaValue }> }> })?.entry ?? [];

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      for (const message of value.messages ?? []) {
        if (!message.id) continue;
        const contact = value.contacts?.[0];
        messages.push({
          channel: 'whatsapp',
          providerId: message.id,
          from: contact?.wa_id ?? '',
          body: extractText(message as unknown as Record<string, unknown>),
          receivedAt: message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : new Date().toISOString(),
          contactName: contact?.profile?.name,
          meta: { phone_number_id: value.metadata?.phone_number_id },
        });
      }

      for (const status of value.statuses ?? []) {
        if (!status.id) continue;
        statuses.push({
          channel: 'whatsapp',
          providerId: status.id,
          status: mapProviderStatus(status.status),
          meta: { recipient_id: status.recipient_id, errors: status.errors },
        });
      }
    }
  }

  return { messages, statuses };
}

function extractText(message: Record<string, unknown>): string {
  const type = message.type as string | undefined;
  if (type === 'text') {
    const text = message.text as { body?: string } | undefined;
    return text?.body ?? '';
  }
  if (type === 'button') {
    const button = message.button as { text?: string } | undefined;
    return button?.text ?? '';
  }
  if (type === 'interactive') {
    const interactive = message.interactive as { button_reply?: { title?: string } } | undefined;
    return interactive?.button_reply?.title ?? '';
  }
  if (typeof message.caption === 'string') return message.caption;
  return '';
}

export function isWhatsAppVerification(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.method === 'GET' &&
    url.searchParams.get('hub.mode') === 'subscribe' &&
    url.searchParams.has('hub.verify_token')
  );
}

export function whatsappChallengeResponse(
  request: Request,
  expectedToken: string
): Response | null {
  if (!isWhatsAppVerification(request)) return null;
  const url = new URL(request.url);
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') ?? '';

  if (token !== expectedToken) {
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

export async function sendWhatsApp(env: Env, params: SendParams): Promise<SendResult> {
  const token = params.credentials?.whatsapp?.token ?? env.WHATSAPP_TOKEN;
  const phoneNumberId =
    params.credentials?.whatsapp?.phone_number_id ?? env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    logger.error('Credenciales de WhatsApp incompletas', { caseId: params.caseId });
    return {
      ok: false,
      channel: 'whatsapp',
      status: 'failed',
      error: 'WhatsApp Cloud API no configurado',
    };
  }

  if (isDryRun(env, params.dryRun)) {
    logger.info('DRY_RUN whatsapp omitido', { to: params.to, caseId: params.caseId });
    return {
      ok: true,
      channel: 'whatsapp',
      providerId: `dry_run_${params.caseId}`,
      status: 'sent',
    };
  }

  const templateName = params.credentials?.whatsapp?.template_name ?? env.WHATSAPP_TEMPLATE_NAME;
  const templateLang = params.credentials?.whatsapp?.template_lang ?? env.WHATSAPP_TEMPLATE_LANG;

  const useTemplate = Boolean(templateName) && !params.meta?.reply;
  const payload = useTemplate
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: templateLang ?? 'es_MX' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: params.body }] }],
        },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.to,
        type: 'text',
        text: { preview_url: false, body: params.body },
      };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetchJson<{
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  }>(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    idempotencyKey: params.idempotencyKey,
    retries: 1,
  });

  if (!response.ok) {
    const message = response.data?.error?.message ?? response.error ?? 'whatsapp_error';
    logger.error('WhatsApp send falló', { caseId: params.caseId, error: message });
    return { ok: false, channel: 'whatsapp', status: 'failed', error: message };
  }

  const providerId = response.data?.messages?.[0]?.id;
  logger.info('WhatsApp enviado', { caseId: params.caseId, providerId });
  return { ok: true, channel: 'whatsapp', providerId, status: 'sent' };
}

export const whatsappAdapter: ChannelAdapter = {
  name: 'whatsapp',
  send: sendWhatsApp,
  parseInbound(rawBody: string): ParsedInbound {
    try {
      return parseWhatsAppPayload(JSON.parse(rawBody));
    } catch {
      return { messages: [], statuses: [] };
    }
  },
};
