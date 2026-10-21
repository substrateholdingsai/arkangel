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
  messaging_profile_id?: string;
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
    messaging_profile_id: data.payload?.messaging_profile_id,
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
        meta: { event_type: eventType, messaging_profile_id: flat.messaging_profile_id },
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
