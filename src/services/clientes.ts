import { logger } from '../lib/logger';
import { normalizePhone } from '../lib/phone';
import type { TenantContext } from '../tenancy/types';
import type { Client } from '../types/cobranza';
import { newId, nowIso } from './db';

export interface ClientInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  curp?: string | null;
  source?: string;
}

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  curp: string | null;
  whatsapp_opt_in: number | null;
  sms_opt_in: number | null;
  email_opt_in: number | null;
  do_not_disturb: number;
  source: string | null;
  created_at: string;
  updated_at: string;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? '',
    email: row.email ?? null,
    curp: row.curp ?? null,
    whatsapp_opt_in: row.whatsapp_opt_in,
    sms_opt_in: row.sms_opt_in,
    email_opt_in: row.email_opt_in,
    do_not_disturb: row.do_not_disturb ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Localiza o crea al cliente.
 * Dedupe por teléfono normalizado; el CURP manda cuando existe.
 * El opt-in de email queda en 0 (requiere consentimiento explícito);
 * el de WhatsApp/SMS queda NULL = "desconocido", lo que permite el primer contacto.
 */
export async function findOrCreateClient(ctx: TenantContext, input: ClientInput): Promise<Client> {
  const phone = normalizePhone(input.phone);
  const email = input.email?.trim() || null;
  const curp = input.curp?.trim() || null;

  if (curp) {
    const existing = await ctx.env.DB.prepare(
      'SELECT * FROM clients WHERE tenant_id = ? AND curp = ? LIMIT 1'
    )
      .bind(ctx.tenantId, curp)
      .first<ClientRow>();
    if (existing) return touchClient(ctx, toClient(existing), input);
  }

  if (phone) {
    const existing = await ctx.env.DB.prepare(
      'SELECT * FROM clients WHERE tenant_id = ? AND phone = ? LIMIT 1'
    )
      .bind(ctx.tenantId, phone)
      .first<ClientRow>();
    if (existing) return touchClient(ctx, toClient(existing), input);
  }

  const id = newId('cli');
  const timestamp = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO clients (id, tenant_id, name, phone, email, curp, whatsapp_opt_in, sms_opt_in, email_opt_in, do_not_disturb, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.tenantId,
      input.name,
      phone,
      email,
      curp,
      input.source ?? 'csv',
      timestamp,
      timestamp
    )
    .run();

  logger.info('Cliente creado', { clientId: id, phone, tenantId: ctx.tenantId });

  return {
    id,
    name: input.name,
    phone: phone ?? '',
    email,
    curp,
    whatsapp_opt_in: null,
    sms_opt_in: null,
    email_opt_in: null,
    do_not_disturb: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function touchClient(
  ctx: TenantContext,
  client: Client,
  input: ClientInput
): Promise<Client> {
  const email = input.email?.trim() || client.email;
  const name = client.name && client.name !== 'Cliente sin nombre' ? client.name : input.name;

  if (email === client.email && name === client.name) return client;

  await ctx.env.DB.prepare(
    'UPDATE clients SET name = ?, email = ?, updated_at = ? WHERE tenant_id = ? AND id = ?'
  )
    .bind(name, email, nowIso(), ctx.tenantId, client.id)
    .run();

  return { ...client, name, email };
}

export async function getClient(ctx: TenantContext, id: string): Promise<Client | null> {
  const row = await ctx.env.DB.prepare(
    'SELECT * FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, id)
    .first<ClientRow>();
  return row ? toClient(row) : null;
}

export async function markDoNotDisturb(
  ctx: TenantContext,
  clientId: string,
  value = true
): Promise<void> {
  await ctx.env.DB.prepare(
    'UPDATE clients SET do_not_disturb = ?, updated_at = ? WHERE tenant_id = ? AND id = ?'
  )
    .bind(value ? 1 : 0, nowIso(), ctx.tenantId, clientId)
    .run();
}

/** Busca al cliente por teléfono o correo (canal entrante). */
export async function findClientByContact(
  ctx: TenantContext,
  contact: { phone?: string | null; email?: string | null }
): Promise<Client | null> {
  const phone = normalizePhone(contact.phone);
  if (phone) {
    const row = await ctx.env.DB.prepare(
      'SELECT * FROM clients WHERE tenant_id = ? AND phone = ? LIMIT 1'
    )
      .bind(ctx.tenantId, phone)
      .first<ClientRow>();
    if (row) return toClient(row);
  }

  const email = contact.email?.trim();
  if (email) {
    const row = await ctx.env.DB.prepare(
      'SELECT * FROM clients WHERE tenant_id = ? AND email = ? LIMIT 1'
    )
      .bind(ctx.tenantId, email)
      .first<ClientRow>();
    if (row) return toClient(row);
  }

  return null;
}

/** Caso abierto (más reciente) de un cliente. */
export async function findOpenCase(
  ctx: TenantContext,
  clientId: string
): Promise<{ id: string; case_date: string; amount_cents: number; score_band: string } | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT id, case_date, amount_cents, score_band FROM cases
     WHERE tenant_id = ? AND client_id = ? AND status NOT IN ('paid', 'failed', 'human')
     ORDER BY case_date DESC LIMIT 1`
  )
    .bind(ctx.tenantId, clientId)
    .first<{ id: string; case_date: string; amount_cents: number; score_band: string }>();
  return row ?? null;
}
