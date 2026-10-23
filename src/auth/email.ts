/**
 * Correos transaccionales de autenticación (restablecer contraseña) por Resend.
 *
 * Va separado del canal de cobranza (`channels/resend.ts`): el remitente es
 * otro (`AUTH_FROM_EMAIL`, p. ej. auth@arksystems.site) para que la
 * reputación del correo de acceso no dependa de la de los cobros.
 */

import { logger } from '../lib/logger';
import type { Env } from '../types/env';

export type AccionCorreo = 'restablecer' | 'verificar' | 'invitar';

const ETIQUETAS: Record<AccionCorreo, { asunto: string; boton: string }> = {
  restablecer: { asunto: 'Restablece tu contraseña de Arkangel', boton: 'Restablecer contraseña' },
  verificar: { asunto: 'Verifica tu correo de Arkangel', boton: 'Verificar correo' },
  invitar: {
    asunto: 'Fuiste invitado a operar en Arkangel',
    boton: 'Activar cuenta y elegir contraseña',
  },
};

/** Remitente de auth: `AUTH_FROM_EMAIL`, o el de Resend si no está definido. */
export function remitenteAuth(env: Env): string {
  return env.AUTH_FROM_EMAIL || env.RESEND_FROM_EMAIL || '';
}

/**
 * Enlace que abre el panel en la pantalla correcta. Se prefiere `APP_URL`
 * (fijo) sobre el origen de la petición, que viaja en cabeceras.
 */
export function construirEnlace(env: Env, accion: AccionCorreo, token: string, origen: string) {
  const url = new URL('/', env.APP_URL || origen);
  url.searchParams.set('auth', accion === 'invitar' ? 'restablecer' : accion);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Escapa texto para interpolarlo en HTML. */
function esc(valor: string): string {
  return valor.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Envía el correo. Nunca lanza: devuelve `false` si falta configuración o
 * Resend lo rechaza, y lo deja en el log como `error` (no `warn`) para que
 * una clave ausente no pase inadvertida.
 */
export async function enviarCorreoAuth(
  env: Env,
  to: string,
  accion: AccionCorreo,
  token: string,
  origen: string
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY?.trim() ?? '';
  const from = remitenteAuth(env).trim();
  if (!apiKey || !from) {
    logger.error('Correo de auth NO enviado: falta RESEND_API_KEY o remitente', { accion });
    return false;
  }

  const { asunto, boton } = ETIQUETAS[accion];
  const enlace = construirEnlace(env, accion, token, origen);
  const ttl =
    accion === 'restablecer'
      ? 'Caduca en 30 minutos y solo sirve una vez.'
      : accion === 'invitar'
        ? 'Este enlace de invitación caduca en 7 días y solo sirve una vez.'
        : '';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: asunto,
        text: `${boton}: ${enlace}\n\n${ttl}\nSi no solicitaste esta acción, ignora este mensaje.`,
        html:
          `<p>${esc(boton)} para tu cuenta de Arkangel.</p>` +
          `<p><a href="${esc(enlace)}">${esc(boton)}</a></p>` +
          `<p>${esc(ttl)}</p>` +
          `<p>Si no solicitaste esta acción, ignora este mensaje.</p>`,
      }),
    });
    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      logger.error('Resend rechazó el correo de auth', {
        accion,
        status: response.status,
        detalle: detalle.slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Fallo de red al enviar el correo de auth', {
      accion,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
