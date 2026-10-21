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

  const whatsapp = mejorPorCanal.get('whatsapp')?.credentials?.whatsapp;
  if (whatsapp) merged.whatsapp = sinVacias({ ...whatsapp });

  const sms = mejorPorCanal.get('sms')?.credentials?.sms;
  if (sms) merged.sms = sinVacias({ ...sms });

  const email = mejorPorCanal.get('email')?.credentials?.email;
  if (email) merged.email = sinVacias({ ...email });

  return merged;
}
