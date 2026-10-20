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

interface TelnyxPayload {
  from?: string;
  to?: string;
  text?: string;
  id?: string;
  status?: string;
  media?: { url?: string }[];
}

interface TelnyxWebhook {
  data?: {
    event_type?: string;
    id?: string;
    payload?: TelnyxPayload;
    from?: string;
    to?: string;
    text?: string;
    status?: string;
  };
  from?: string;
  to?: string;
  text?: string;
  id?: string;
  status?: string;
}

export function parseTelnyxPayload(payload: unknown): ParsedInbound {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const body = (payload ?? {}) as TelnyxWebhook;
  const data = body.data ?? {};
  const eventType = data.event_type ?? '';

  const flat: TelnyxPayload = {
    from: data.payload?.from ?? data.from ?? body.from,
    to: data.payload?.to ?? data.to ?? body.to,
    text: data.payload?.text ?? data.text ?? body.text,
    id: data.payload?.id ?? data.id ?? body.id,
    status: data.payload?.status ?? data.status ?? body.status,
  };

  if (eventType === 'message.received' || (flat.text && flat.from)) {
    if (flat.text && flat.from) {
      messages.push({
        channel: 'sms',
        providerId: flat.id ?? `telnyx_${Date.now()}`,
        from: flat.from,
        to: flat.to,
        body: flat.text,
        receivedAt: new Date().toISOString(),
        meta: { event_type: eventType },
      });
    }
  }

  if (eventType === 'message.updated' || eventType === 'message.failed' || flat.status) {
    if (flat.id && flat.status) {
      statuses.push({
        channel: 'sms',
        providerId: flat.id,
        status: mapProviderStatus(flat.status),
        meta: { event_type: eventType },
      });
    }
  }

  return { messages, statuses };
}

export async function sendTelnyxSms(env: Env, params: SendParams): Promise<SendResult> {
  if (!env.TELNYX_API_KEY || !env.TELNYX_MESSAGING_PROFILE_ID || !env.TELNYX_FROM_NUMBER) {
    logger.error('Credenciales de Telnyx incompletas', { caseId: params.caseId });
    return { ok: false, channel: 'sms', status: 'failed', error: 'Telnyx no configurado' };
  }

  if (isDryRun(env)) {
    logger.info('DRY_RUN telnyx omitido', { to: params.to, caseId: params.caseId });
    return { ok: true, channel: 'sms', providerId: `dry_run_${params.caseId}`, status: 'sent' };
  }

  const url = 'https://api.telnyx.com/v2/messages';
  const response = await fetchJson<{
    data?: { id?: string; status?: string };
    errors?: Array<{ detail?: string }>;
  }>(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}` },
    body: JSON.stringify({
      from: env.TELNYX_FROM_NUMBER,
      to: params.to,
      text: params.body,
      messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID,
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
