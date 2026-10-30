/**
 * Contrato formal CAMPAIGN_DISPATCH_V1 entre Ark Sales CRM y Arkangel,
 * y TRANSACTIONAL_DISPATCH_V1 para envíos transaccionales 1:1 desde agregadores
 * como ark-commerce.
 */

import { z } from 'zod';

export const RecipientSchema = z.object({
  phone: z.string().min(8),
  name: z.string().optional(),
  variables: z.record(z.string()).optional(),
  tz: z.string().optional(),
});

export type RecipientInput = z.infer<typeof RecipientSchema>;

export const CampaignDispatchV1Schema = z.object({
  version: z.literal('CAMPAIGN_DISPATCH_V1').default('CAMPAIGN_DISPATCH_V1'),
  campaign_id: z.string().min(3),
  // Motor explícito obligatorio (fail-closed: si no dice 'comunicacion', rechaza)
  motor: z.literal('comunicacion'),
  tenant_id: z.string().min(1),
  canal: z.enum(['whatsapp', 'sms', 'email', 'voz']),
  proposito: z.enum(['promocion', 'evento', 'cumpleanos', 'marketing', 'aviso', 'transaccional']),
  template_id: z.string().min(1),
  audience: z.array(RecipientSchema).min(1),
  frequency_cap: z.number().int().positive().max(7).optional(),
  schedule: z.string().datetime().optional(),
  quote_id: z.string().optional(),
});

export type CampaignDispatchV1 = z.infer<typeof CampaignDispatchV1Schema>;

/**
 * Contrato formal TRANSACTIONAL_DISPATCH_V1 para envíos 1:1 e inmediatos
 * desde agregadores de volumen (ej. ark-commerce, ERPs, CRMs).
 */
export const TransactionalDispatchV1Schema = z.object({
  version: z.literal('TRANSACTIONAL_DISPATCH_V1').default('TRANSACTIONAL_DISPATCH_V1'),
  tenant_id: z.string().min(1),
  channel: z.enum(['whatsapp', 'sms', 'email']).default('whatsapp'),
  to: z.string().min(8), // Teléfono E.164 o correo electrónico
  proposito: z.enum(['transaccional', 'aviso', 'marketing']).default('transaccional'),
  tipo: z
    .enum([
      'order_confirmation',
      'shipping_update',
      'delivery_notification',
      'cart_recovery',
      'auth_magic_link',
      'custom',
    ])
    .default('custom'),
  template_id: z.string().optional(),
  body: z.string().optional(),
  variables: z.record(z.string()).optional(),
  order_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  dry_run: z.boolean().optional(),
});

export type TransactionalDispatchV1 = z.infer<typeof TransactionalDispatchV1Schema>;
