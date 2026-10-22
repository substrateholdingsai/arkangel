// Resend API (email) — https://resend.com/docs/api-reference
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import {
  isDryRun,
  type ChannelAdapter,
  type InboundMessage,
  type ParsedInbound,
  type SendParams,
  type SendResult,
  type StatusUpdate,
} from './types';

interface ResendInbound {
  from?: string;
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  envelope?: { from?: string };
  message_id?: string;
}

export function parseResendPayload(payload: unknown): ParsedInbound {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const body = (payload ?? {}) as ResendInbound;
  if (!body.from || !body.text) return { messages, statuses };

  messages.push({
    channel: 'email',
    providerId: body.message_id ?? `resend_${Date.now()}`,
    from: body.envelope?.from ?? body.from,
    to: Array.isArray(body.to) ? body.to[0] : body.to,
    body: body.text,
    receivedAt: new Date().toISOString(),
    meta: { subject: body.subject ?? '' },
  });

  return { messages, statuses };
}

export async function sendResendEmail(env: Env, params: SendParams): Promise<SendResult> {
  const apiKey = (params.credentials?.email?.api_key ?? env.RESEND_API_KEY)?.trim();
  const fromEmail = (params.credentials?.email?.from_email ?? env.RESEND_FROM_EMAIL)?.trim();

  if (!apiKey || !fromEmail) {
    logger.error('Credenciales de Resend incompletas', { caseId: params.caseId });
    return {
      ok: false,
      channel: 'email',
      status: 'failed',
      error: 'Resend no configurado',
    };
  }

  if (isDryRun(env, params.dryRun)) {
    logger.info('DRY_RUN resend omitido', { to: params.to, caseId: params.caseId });
    return { ok: true, channel: 'email', providerId: `dry_run_${params.caseId}`, status: 'sent' };
  }

  const url = 'https://api.resend.com/emails';
  const response = await fetchJson<{ id?: string; message?: string }>(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: fromEmail,
      to: [params.to],
      subject: params.subject ?? 'Recordatorio de pago',
      text: params.body,
      html: params.body.replace(/\n/g, '<br/>'),
      headers: { 'X-Arkangel-Case': params.caseId },
      tags: [{ name: 'case', value: params.caseId }],
    }),
    idempotencyKey: params.idempotencyKey,
    retries: 1,
  });

  if (!response.ok) {
    const message = response.data?.message ?? response.error ?? 'resend_error';
    logger.error('Resend send falló', { caseId: params.caseId, error: message });
    return { ok: false, channel: 'email', status: 'failed', error: message };
  }

  const providerId = response.data?.id;
  logger.info('Resend email enviado', { caseId: params.caseId, providerId });
  return { ok: true, channel: 'email', providerId, status: 'sent' };
}

export const resendAdapter: ChannelAdapter = {
  name: 'email',
  send: sendResendEmail,
  parseInbound(rawBody: string): ParsedInbound {
    try {
      return parseResendPayload(JSON.parse(rawBody));
    } catch {
      return { messages: [], statuses: [] };
    }
  },
};
