import { channelPriority, type ScoreBand } from '../lib/score';
import { getEnabledChannels } from '../tenancy/channels';
import type { TenantChannel } from '../tenancy/types';
import type { Client } from '../types/cobranza';
import { resendAdapter } from './resend';
import { telnyxAdapter } from './telnyx';
import { whatsappAdapter } from './whatsapp';
import type { ChannelAdapter, ChannelName } from './types';

export const adapters: Record<ChannelName, ChannelAdapter> = {
  whatsapp: whatsappAdapter,
  sms: telnyxAdapter,
  email: resendAdapter,
};

export * from './types';
export * from './diagnostics';
export { whatsappAdapter, telnyxAdapter, resendAdapter };

/**
 * Resuelve la cadena de canales para un cliente.
 * - WhatsApp y SMS requieren teléfono + opt-in (o opt-in desconocido = NULL, se permite).
 * - Email SIEMPRE requiere opt-in explícito y correo (consentimiento de marketing/contacto).
 * - Si el despacho tiene canales configurados (`tenantChannels`), filtra por los canales activos.
 */
export function resolveChannels(
  client: Client,
  band: ScoreBand,
  tenantChannels?: TenantChannel[]
): ChannelName[] {
  const phone = Boolean(client.phone);
  const email = Boolean(client.email);
  const enabledSet =
    tenantChannels && tenantChannels.length > 0
      ? new Set(getEnabledChannels(tenantChannels))
      : null;

  const allowWhatsApp =
    phone && client.whatsapp_opt_in !== 0 && (!enabledSet || enabledSet.has('whatsapp'));
  const allowSms = phone && client.sms_opt_in !== 0 && (!enabledSet || enabledSet.has('sms'));
  const allowEmail = email && client.email_opt_in === 1 && (!enabledSet || enabledSet.has('email'));

  const allowed: ChannelName[] = [];
  for (const channel of channelPriority(band)) {
    if (channel === 'whatsapp' && allowWhatsApp) allowed.push(channel);
    if (channel === 'sms' && allowSms) allowed.push(channel);
    if (channel === 'email' && allowEmail) allowed.push(channel);
  }

  return allowed;
}

/** ¿El cliente tiene al menos un canal utilizable? */
export function hasUsableChannel(
  client: Client,
  band: ScoreBand,
  tenantChannels?: TenantChannel[]
): boolean {
  return resolveChannels(client, band, tenantChannels).length > 0;
}
