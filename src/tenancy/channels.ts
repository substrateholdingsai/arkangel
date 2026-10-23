/**
 * Credenciales de canal por tenant.
 *
 * Las credenciales de *cuenta* (el token de la app de Meta, la API key de
 * Telnyx, la key de Resend) son de la plataforma: todas las empresas de
 * cobranza cuelgan de la misma app y de la misma cuenta.
 *
 * Lo que sí es del tenant es el *enrutado*: desde qué número manda, con qué
 * perfil de mensajería y con qué dominio de correo. Eso es lo que permite
 * resolver de qué empresa es un mensaje entrante, y por lo tanto debe ir
 * aislado por tenant.
 */

import type { ChannelName } from '../channels/types';
import type { TenantChannel, TenantChannelCredentials } from './types';

/** Una cadena vacía no es una credencial: se normaliza a `undefined`. */
function sinVacias<T extends Record<string, string | undefined>>(valores: T): T {
  const limpio = { ...valores };
  for (const clave of Object.keys(limpio) as (keyof T)[]) {
    if (typeof limpio[clave] === 'string' && limpio[clave]?.trim() === '') {
      delete limpio[clave];
    }
  }
  return limpio;
}

/** Instante de una marca de tiempo; 0 si no se puede leer. */
function momento(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Fusiona las credenciales propias de los canales del tenant.
 *
 * Se indexa por **canal** (el mismo vocabulario que `tenant_channels.channel` y
 * que el CHECK de la tabla). Aplanar varias filas del mismo canal produciría
 * credenciales mezcladas —el token de una con el número de otra—, que el
 * proveedor rechaza sin que quede claro por qué.
 *
 * Si hay más de una fila del mismo canal gana **la más reciente**
 * (`created_at`), no la primera que llegue: el orden de lectura de la base no
 * es un contrato.
 */
export function mergeChannelCredentials(channels: TenantChannel[]): TenantChannelCredentials {
  const mejorPorCanal = new Map<ChannelName, TenantChannel>();

  for (const canal of channels) {
    const actual = mejorPorCanal.get(canal.channel);
    if (!actual || momento(canal.created_at) >= momento(actual.created_at)) {
      mejorPorCanal.set(canal.channel, canal);
    }
  }

  const merged: TenantChannelCredentials = {};

  const whatsappRow = mejorPorCanal.get('whatsapp');
  if (whatsappRow && whatsappRow.status !== 'inactive' && whatsappRow.credentials?.whatsapp) {
    merged.whatsapp = sinVacias({ ...whatsappRow.credentials.whatsapp });
  }

  const smsRow = mejorPorCanal.get('sms');
  if (smsRow && smsRow.status !== 'inactive' && smsRow.credentials?.sms) {
    merged.sms = sinVacias({ ...smsRow.credentials.sms });
  }

  const emailRow = mejorPorCanal.get('email');
  if (emailRow && emailRow.status !== 'inactive' && emailRow.credentials?.email) {
    merged.email = sinVacias({ ...emailRow.credentials.email });
  }

  return merged;
}

/**
 * Devuelve la lista de canales habilitados para el despacho.
 *
 * - Si el despacho aún no ha configurado filas en `tenant_channels` (`channels.length === 0`),
 *   los 3 canales de la plataforma (`whatsapp`, `sms`, `email`) quedan activos por defecto.
 * - Si el despacho ya configuró sus canales (`channels.length > 0`), sólo operan los
 *   canales cuya fila más reciente esté en `status === 'active'`.
 */
export function getEnabledChannels(channels: TenantChannel[]): ChannelName[] {
  if (!channels || channels.length === 0) {
    return ['whatsapp', 'sms', 'email'];
  }

  const mejorPorCanal = new Map<ChannelName, TenantChannel>();
  for (const canal of channels) {
    const actual = mejorPorCanal.get(canal.channel);
    if (!actual || momento(canal.created_at) >= momento(actual.created_at)) {
      mejorPorCanal.set(canal.channel, canal);
    }
  }

  const tieneInactivosExplicitos = Array.from(mejorPorCanal.values()).some(
    (c) => c.status === 'inactive'
  );

  const orden: ChannelName[] = ['whatsapp', 'sms', 'email'];
  if (tieneInactivosExplicitos) {
    return orden.filter((ch) => {
      const fila = mejorPorCanal.get(ch);
      return !fila || fila.status === 'active';
    });
  }

  const activos = orden.filter((ch) => mejorPorCanal.get(ch)?.status === 'active');
  return activos.length > 0 ? activos : ['whatsapp', 'sms', 'email'];
}
