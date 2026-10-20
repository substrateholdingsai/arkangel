import type { Channel, MessageStatus } from '../types/cobranza';
import type { Env } from '../types/env';

export type ChannelName = Channel;

export interface SendParams {
  to: string;
  body: string;
  subject?: string;
  caseId: string;
  clientId: string;
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  channel: ChannelName;
  providerId?: string;
  status: MessageStatus;
  error?: string;
}

export interface InboundMessage {
  channel: ChannelName;
  providerId: string;
  from: string;
  to?: string;
  body: string;
  receivedAt: string;
  contactName?: string;
  meta?: Record<string, unknown>;
}

export interface StatusUpdate {
  channel: ChannelName;
  providerId: string;
  status: MessageStatus;
  meta?: Record<string, unknown>;
}

export interface ParsedInbound {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export interface ChannelAdapter {
  name: ChannelName;
  send(env: Env, params: SendParams): Promise<SendResult>;
  parseInbound(rawBody: string, headers: Record<string, string>): ParsedInbound;
}

export function isDryRun(env: Env): boolean {
  return env.DRY_RUN === 'true';
}

/** Mapea estados de proveedor a nuestro vocabulario. */
export function mapProviderStatus(status: string | undefined): MessageStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'sent':
    case 'submitted':
    case 'queued':
    case 'pending':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'received':
    case 'inbound':
      return 'received';
    case 'failed':
    case 'undelivered':
    case 'rejected':
      return 'failed';
    default:
      return 'sent';
  }
}
