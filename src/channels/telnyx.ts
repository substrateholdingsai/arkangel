// Telnyx Messaging API (SMS) — https://developers.telnyx.com/docs/messaging
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

interface TelnyxFromTo {
  phone_number?: string;
  carrier?: string;
  status?: string;
}

interface TelnyxMessageBody {
  type?: string;
  text?: { body?: string } | string;
}

interface TelnyxPayload {
  from?: string | TelnyxFromTo;
  to?: string | TelnyxFromTo[] | TelnyxFromTo;
  text?: string | null;
  body?: string | TelnyxMessageBody | null;
  id?: string;
  status?: string;
  type?: string;
  direction?: string;
  messaging_profile_id?: string;
  media?: { url?: string }[];
}

interface TelnyxWebhook {
  data?: {
    record_type?: string;
    event_type?: string;
    id?: string;
    type?: string;
    payload?: TelnyxPayload;
    from?: string | TelnyxFromTo;
    to?: string | TelnyxFromTo[] | TelnyxFromTo;
    text?: string;
    status?: string;
  };
  from?: string | TelnyxFromTo;
  to?: string | TelnyxFromTo[] | TelnyxFromTo;
  text?: string;
  body?: string | TelnyxMessageBody;
  id?: string;
  status?: string;
  type?: string;
}

function resolveTelnyxPhone(val: unknown): string | undefined {
  if (typeof val === 'string' && val.trim() !== '') return val.trim();
  if (val && typeof val === 'object') {
    if ('phone_number' in val && typeof (val as TelnyxFromTo).phone_number === 'string') {
      return (val as TelnyxFromTo).phone_number?.trim();
    }
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0] as unknown;
      if (typeof first === 'string' && first.trim() !== '') return first.trim();
      if (first && typeof first === 'object' && 'phone_number' in first) {
        return (first as TelnyxFromTo).phone_number?.trim();
      }
    }
  }
  return undefined;
}

function resolveTelnyxText(textVal: unknown, bodyVal: unknown, fallbackText?: unknown): string {
  if (typeof textVal === 'string' && textVal.trim() !== '') return textVal;
  if (typeof bodyVal === 'string' && bodyVal.trim() !== '') return bodyVal;
  if (bodyVal && typeof bodyVal === 'object') {
    const b = bodyVal as TelnyxMessageBody;
    if (typeof b.text === 'string') return b.text;
    if (b.text && typeof b.text === 'object' && typeof b.text.body === 'string') {
      return b.text.body;
    }
  }
  if (typeof fallbackText === 'string' && fallbackText.trim() !== '') return fallbackText;
  return '';
}

export function parseTelnyxPayload(payload: unknown): ParsedInbound {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const body = (payload ?? {}) as TelnyxWebhook;
  const data = body.data ?? {};
  const eventType = data.event_type ?? '';
  const payloadData = data.payload ?? {};

  // Detectar canal: WHATSAPP si type === 'WHATSAPP' o event_type inicia con 'whatsapp.'
  const rawType = String(payloadData.type ?? data.type ?? body.type ?? '').toUpperCase();
  const isWhatsApp = rawType === 'WHATSAPP' || eventType.startsWith('whatsapp.');
  const channel = isWhatsApp ? 'whatsapp' : 'sms';

  const fromNumber = resolveTelnyxPhone(payloadData.from ?? data.from ?? body.from);
  const toNumber = resolveTelnyxPhone(payloadData.to ?? data.to ?? body.to);
  const textBody = resolveTelnyxText(payloadData.text, payloadData.body, data.text ?? body.text);
  const messageId = payloadData.id ?? data.id ?? body.id;

  // Extraer estatus de entrega
  let statusStr = payloadData.status ?? data.status ?? body.status;
  if (!statusStr && Array.isArray(payloadData.to) && payloadData.to.length > 0) {
    statusStr = payloadData.to[0]?.status;
  }

  // 1. Mensajes entrantes
  if (eventType === 'message.received' || (!eventType && textBody && fromNumber)) {
    if (textBody && fromNumber) {
      const normalizedBody = textBody.trim().toLowerCase();
      const isOptOut =
        normalizedBody === 'stop' ||
        normalizedBody === 'unsubscribe' ||
        normalizedBody === 'cancel' ||
        normalizedBody === 'quit' ||
        normalizedBody === 'baja' ||
        normalizedBody === 'alto' ||
        normalizedBody === 'no molestar';

      messages.push({
        channel,
        providerId: messageId ?? `telnyx_${Date.now()}`,
        from: fromNumber,
        to: toNumber,
        body: textBody,
        receivedAt: new Date().toISOString(),
        meta: {
          event_type: eventType,
          messaging_profile_id: payloadData.messaging_profile_id,
          phone_number_id: isWhatsApp ? (toNumber ?? fromNumber) : undefined,
          is_opt_out: isOptOut,
        },
      });
    }
  }

  // 2. Actualizaciones de estado (finalized, delivered, read, updated, failed)
  const isStatusEvent =
    eventType === 'message.finalized' ||
    eventType === 'message.updated' ||
    eventType === 'message.sent' ||
    eventType === 'message.failed' ||
    (eventType.startsWith('whatsapp.') && eventType !== 'whatsapp.message.received');

  if (isStatusEvent || (messageId && statusStr && eventType !== 'message.received')) {
    if (messageId && statusStr) {
      statuses.push({
        channel,
        providerId: messageId,
        status: mapProviderStatus(statusStr),
        meta: { event_type: eventType },
      });
    }
  }

  return { messages, statuses };
}

export async function sendTelnyxSms(env: Env, params: SendParams): Promise<SendResult> {
  const apiKey = params.credentials?.sms?.api_key ?? env.TELNYX_API_KEY;
  const messagingProfileId =
    params.credentials?.sms?.messaging_profile_id ?? env.TELNYX_MESSAGING_PROFILE_ID;
  const fromNumber = params.credentials?.sms?.from_number ?? env.TELNYX_FROM_NUMBER;

  if (!apiKey || !messagingProfileId || !fromNumber) {
    logger.error('Credenciales de Telnyx incompletas', { caseId: params.caseId });
    return { ok: false, channel: 'sms', status: 'failed', error: 'Telnyx no configurado' };
  }

  if (isDryRun(env, params.dryRun)) {
    logger.info('DRY_RUN telnyx omitido', { to: params.to, caseId: params.caseId });
    return { ok: true, channel: 'sms', providerId: `dry_run_${params.caseId}`, status: 'sent' };
  }

  const url = 'https://api.telnyx.com/v2/messages';
  const response = await fetchJson<{
    data?: { id?: string; status?: string };
    errors?: Array<{ detail?: string }>;
  }>(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: fromNumber,
      to: params.to,
      text: params.body,
      messaging_profile_id: messagingProfileId,
      use_profile_webhooks: true,
      tags: ['arkangel', 'cobranza', `case-${params.caseId}`],
    }),
    idempotencyKey: params.idempotencyKey,
    retries: 1,
  });

  if (!response.ok) {
    const message = response.data?.errors?.[0]?.detail ?? response.error ?? 'telnyx_error';
    logger.error('Telnyx send falló', { caseId: params.caseId, error: message });
    return { ok: false, channel: 'sms', status: 'failed', error: message };
  }

  const providerId = response.data?.data?.id;
  logger.info('Telnyx SMS enviado', { caseId: params.caseId, providerId });
  return { ok: true, channel: 'sms', providerId, status: 'sent' };
}

export const telnyxAdapter: ChannelAdapter = {
  name: 'sms',
  send: sendTelnyxSms,
  parseInbound(rawBody: string): ParsedInbound {
    try {
      return parseTelnyxPayload(JSON.parse(rawBody));
    } catch {
      return { messages: [], statuses: [] };
    }
  },
};
