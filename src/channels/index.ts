import { channelPriority, type ScoreBand } from '../lib/score';
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
export { whatsappAdapter, telnyxAdapter, resendAdapter };

/**
 * Resuelve la cadena de canales para un cliente.
 * - WhatsApp y SMS requieren teléfono + opt-in (o opt-in desconocido = NULL, se permite).
 * - Email SIEMPRE requiere opt-in explícito y correo (consentimiento de marketing/contacto).
 */
export function resolveChannels(client: Client, band: ScoreBand): ChannelName[] {
  const phone = Boolean(client.phone);
  const email = Boolean(client.email);

  const allowWhatsApp = phone && client.whatsapp_opt_in !== 0;
  const allowSms = phone && client.sms_opt_in !== 0;
  const allowEmail = email && client.email_opt_in === 1;

  const allowed: ChannelName[] = [];
  for (const channel of channelPriority(band)) {
    if (channel === 'whatsapp' && allowWhatsApp) allowed.push(channel);
    if (channel === 'sms' && allowSms) allowed.push(channel);
    if (channel === 'email' && allowEmail) allowed.push(channel);
  }

  return allowed;
}

/** ¿El cliente tiene al menos un canal utilizable? */
export function hasUsableChannel(client: Client, band: ScoreBand): boolean {
  return resolveChannels(client, band).length > 0;
}
