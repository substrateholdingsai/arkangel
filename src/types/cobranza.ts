/** Tipos del dominio de cobranza. */

export type Channel = 'whatsapp' | 'sms' | 'email';

export type CaseStatus =
  'ready' | 'sending' | 'sent' | 'replied' | 'promised' | 'paid' | 'failed' | 'human';

export type MessageStatus =
  'queued' | 'sent' | 'delivered' | 'read' | 'promise_made' | 'failed' | 'received';

export type Intent =
  | 'paga'
  | 'promete'
  | 'rechaza'
  | 'pide_factura'
  | 'pide_info'
  | 'no_responde'
  | 'molesto'
  | 'otro';

export interface Client {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  curp: string | null;
  /** `null` = opt-in desconocido (permitido en el primer contacto). `0` = rechazo explícito. */
  whatsapp_opt_in: number | null;
  sms_opt_in: number | null;
  email_opt_in: number | null;
  do_not_disturb: number;
  created_at: string;
  updated_at: string;
}

export interface Debt {
  id: string;
  client_id: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: 'pending' | 'promised' | 'paid' | 'cancelled';
  description: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionCase {
  id: string;
  case_date: string;
  client_id: string;
  debt_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  amount_cents: number;
  status: CaseStatus;
  score: number;
  score_band: 'bajo' | 'medio' | 'alto';
  channel_state: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  case_id: string;
  client_id: string;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  provider_id: string | null;
  body: string;
  status: MessageStatus;
  error: string | null;
  meta: string | null;
  created_at: string;
}

export interface PromiseRow {
  id: string;
  case_id: string;
  client_id: string;
  amount_cents: number;
  promised_date: string | null;
  confidence: number;
  status: 'open' | 'kept' | 'broken';
  source: string;
  created_at: string;
}

export interface DailyMetrics {
  total: number;
  enviadas: number;
  contestadas: number;
  promesas: number;
  monto_prometido_cents: number;
  monto_cobrado_cents: number;
  csv_received_at: string | null;
  csv_name: string | null;
  por_estado: Record<string, number>;
}
