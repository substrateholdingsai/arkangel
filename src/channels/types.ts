import type { Channel, MessageStatus } from '../types/cobranza';
import type { Env } from '../types/env';

export type ChannelName = Channel;

/**
 * Credenciales propias de un tenant para un canal.
 *
 * La clave es el **canal** (`whatsapp` | `sms` | `email`), el mismo vocabulario
 * que usa `tenant_channels.channel` y el CHECK de la tabla. Un solo vocabulario:
 * si el JSON se indexara por proveedor, una clave mal escrita se descartaría en
 * silencio y el envío saldría desde la cuenta de la plataforma, con la
 * identidad equivocada ante el deudor.
 *
 * Lo que es de la plataforma (el token de la app de Meta, la API key de Telnyx,
 * la key de Resend) sigue viniendo del entorno. Lo que es del tenant es el
 * enrutado y, si el cliente tiene cuenta propia, sus credenciales.
 */
export interface ChannelOverride {
  whatsapp?: {
    api_key?: string;
    from_number?: string;
    token?: string;
    phone_number_id?: string;
    template_name?: string;
    template_lang?: string;
  };
  sms?: {
    api_key?: string;
    messaging_profile_id?: string;
    from_number?: string;
  };
  email?: {
    api_key?: string;
    from_email?: string;
  };
}

export interface SendParams {
  to: string;
  body: string;
  subject?: string;
  /**
   * Caso de cobranza. En comunicación general no hay caso: se usa
   * `campaignId`. Al menos uno de los dos identifica el envío en los logs.
   */
  caseId?: string;
  /** Campaña del Motor de Comunicación (marketing, avisos, transaccional). */
  campaignId?: string;
  clientId?: string;
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
  /** Credenciales propias del tenant; lo que falte se toma de la plataforma. */
  credentials?: ChannelOverride;
  /** Modo de ensayo del tenant: no se envía, sólo se registra. */
  dryRun?: boolean;
  /**
   * Plantilla HSM elegida para ESTE mensaje (WhatsApp). Si viene, gana sobre
   * la plantilla única configurada en el tenant y `body` sólo es el texto de
   * referencia para la bitácora. Es lo que usa el Motor de Comunicación.
   */
  template?: WhatsAppTemplateRef;
}

/** Referencia a una plantilla aprobada por Meta con sus parámetros ya resueltos. */
export interface WhatsAppTemplateRef {
  name: string;
  lang: string;
  /** Componentes en formato de la Cloud API (`header`, `body`, `button`). */
  components: Array<Record<string, unknown>>;
}

/** Identificador del envío para logs y claves de ensayo. */
export function envioRef(params: SendParams): string {
  return params.caseId ?? params.campaignId ?? 'sin_ref';
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
  /**
   * Tenant al que pertenece el mensaje entrante. Lo resuelve el webhook a
   * partir del identificador de enrutado del proveedor (phone_number_id,
   * messaging_profile_id o dominio receptor).
   */
  tenantId?: string;
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

/**
 * ¿Estamos en modo de ensayo?
 *
 * El freno global es `DRY_RUN` en el entorno del Worker: si está activo, **no
 * sale nada**, ningún tenant puede desactivarlo. El flag del tenant sólo puede
 * ACTIVAR el ensayo, nunca levantarlo: un tenant no debe poder desarmar el
 * freno de emergencia de la plataforma.
 */
export function isDryRun(env: Env, tenantDryRun?: boolean): boolean {
  return env.DRY_RUN === 'true' || tenantDryRun === true;
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
