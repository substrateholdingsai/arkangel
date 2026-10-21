/**
 * API de autenticación nativa: registro, login, logout y sesión.
 *
 * Montada en `/api/auth`. La identidad vive en D1 (`users`,
 * `tenant_memberships`, `auth_sessions`) y en el navegador sólo viaja la
 * cookie `ark_session`, que es HttpOnly: el JavaScript del panel no puede
 * leerla, sólo mandarla.
 *
 * Reglas de esta capa:
 *   · Ninguna respuesta de esta API filtra el hash de la contraseña, el token
 *     de sesión ni el token de D1.
 *   · Los mensajes de error no distinguen entre "no existe" y "contraseña
 *     incorrecta": si lo hicieran, el endpoint sería un oráculo de qué
 *     correos están dados de alta.
 *   · El login va con rate limit por correo y por IP.
 */

import { Hono } from 'hono';
import { authenticateRequest, type AuthVars } from '../auth/middleware';
import {
  clearCookieHeader,
  consumeActionToken,
  cookieHeader,
  createSession,
  changePassword,
  emailIsValid,
  getMemberships,
  getUserByEmail,
  getUserById,
  hashPassword,
  issueActionToken,
  normalizaEmail,
  passwordIsValid,
  publicSession,
  rateLimited,
  registerUser,
  requestIsSecure,
  RESET_TTL_SECONDS,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from '../auth/native';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';

export const autenticacion = new Hono<{ Bindings: Env; Variables: AuthVars }>();

autenticacion.use('*', authenticateRequest);

autenticacion.post('/register', async (c) => {
  const body = await cuerpoJson(c.req.raw);
  if (!body) return c.json({ error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);

  const email = normalizaEmail(typeof body.email === 'string' ? body.email : '');
  const password = typeof body.password === 'string' ? body.password : '';
  const fullName =
    firstTexto(body.full_name, body.fullName, 120) || email.split('@')[0] || 'Usuario';
  const tenantName =
    firstTexto(body.tenant_name, body.tenantName, 120) || `Despacho ${fullName}`.slice(0, 120);

  if (!emailIsValid(email)) return c.json({ error: 'Ingresa un correo electrónico válido.' }, 400);
  if (!passwordIsValid(password)) {
    return c.json({ error: 'La contraseña debe tener entre 12 y 128 caracteres.' }, 400);
  }
  if (await rateLimited(c.req.raw, c.env, 'register', email, 5, 3600)) {
    return c.json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  }
  if (await getUserByEmail(c.env, email)) {
    return c.json({ error: 'Ese correo ya está dado de alta.' }, 409);
  }

  const { userId, tenantId } = await registerUser(c.env, {
    email,
    password,
    fullName,
    tenantName,
  });
  logger.info('Registro completado', { userId, tenantId });

  const sesion = await createSession(c.env, userId);
  return c.json(await sesionPublica(c.env, userId), 201, {
    'Set-Cookie': cookieHeader(sesion.token, requestIsSecure(c.req.raw)),
    'Cache-Control': 'no-store',
  });
});

autenticacion.post('/login', async (c) => {
  const body = await cuerpoJson(c.req.raw);
  if (!body) return c.json({ error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);

  const email = normalizaEmail(typeof body.email === 'string' ? body.email : '');
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password || password.length > 128) {
    return c.json({ error: 'Correo o contraseña incorrectos.' }, 401);
  }
  if (await rateLimited(c.req.raw, c.env, 'login', email, 10, 900)) {
    return c.json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  }

  const user = await getUserByEmail(c.env, email);

  // Se verifica contra un hash señuelo cuando el usuario no existe: así el
  // tiempo de respuesta no revela qué correos están dados de alta.
  const hashFicticio = `pbkdf2_sha256$25000$${'00'.repeat(16)}${'00'.repeat(32)}`;
  const coincide = await verifyPassword(password, user?.passwordHash ?? hashFicticio);

  if (!user || !coincide || !user.emailVerifiedAt) {
    logger.warn('Intento de login fallido', { email });
    return c.json({ error: 'Correo o contraseña incorrectos.' }, 401);
  }

  const sesion = await createSession(c.env, user.id);
  return c.json(await sesionPublica(c.env, user.id), 200, {
    'Set-Cookie': cookieHeader(sesion.token, requestIsSecure(c.req.raw)),
    'Cache-Control': 'no-store',
  });
});

autenticacion.post('/logout', async (c) => {
  await revokeSession(c.env, c.req.raw);
  return c.json({ success: true }, 200, {
    'Set-Cookie': clearCookieHeader(requestIsSecure(c.req.raw)),
    'Cache-Control': 'no-store',
  });
});

autenticacion.get('/session', async (c) => {
  const sesion = c.get('sesionNativa');
  if (!sesion?.user) {
    return c.json({ error: 'No hay sesión activa.' }, 401, { 'Cache-Control': 'no-store' });
  }
  return c.json(await sesionPublica(c.env, sesion.user.id), 200, {
    'Cache-Control': 'no-store',
  });
});

/**
 * Pide el restablecimiento de contraseña.
 *
 * Siempre responde 202: si el correo existe se envía el enlace, y si no
 * también. Decirlo distinto sería enumerar cuentas.
 */
autenticacion.post('/request-password-reset', async (c) => {
  const body = await cuerpoJson(c.req.raw);
  if (!body) return c.json({ error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);

  const email = normalizaEmail(typeof body.email === 'string' ? body.email : '');
  if (!emailIsValid(email)) return c.json({ error: 'Ingresa un correo electrónico válido.' }, 400);
  if (await rateLimited(c.req.raw, c.env, 'reset', email, 3, 3600)) {
    return c.json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  }

  const user = await getUserByEmail(c.env, email);
  if (user?.emailVerifiedAt) {
    const token = await issueActionToken(c.env, user.id, 'reset_password', RESET_TTL_SECONDS);
    const enviado = await enviarCorreo(
      c.env,
      email,
      'Restablece tu contraseña de Arkangel',
      'restablecer',
      token,
      new URL(c.req.url).origin
    );
    if (!enviado) {
      logger.warn('No se pudo enviar el correo de restablecimiento', { email });
    }
  }

  return c.json(
    {
      success: true,
      message: 'Si existe una cuenta verificada con ese correo, recibirás instrucciones.',
    },
    202
  );
});

/** Consume el token de restablecimiento y fija la nueva contraseña. */
autenticacion.post('/reset-password', async (c) => {
  const body = await cuerpoJson(c.req.raw);
  if (!body) return c.json({ error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);

  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[0-9a-f]{64}$/.test(token) || !passwordIsValid(password)) {
    return c.json(
      { error: 'El enlace no es válido o expiró, o la contraseña no cumple los requisitos.' },
      400
    );
  }

  const userId = await consumeActionToken(c.env, token, 'reset_password');
  if (!userId)
    return c.json({ error: 'El enlace de restablecimiento no es válido o expiró.' }, 400);

  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(password), userId)
    .run();
  // Cambiar la contraseña cierra las sesiones abiertas: si el token se
  // filtró, el atacante pierde el acceso.
  await revokeAllSessions(c.env, userId);

  return c.json({ success: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
});

/** Cambia la contraseña del usuario autenticado (conoce la actual). */
autenticacion.post('/change-password', async (c) => {
  const sesion = c.get('sesionNativa');
  if (!sesion?.user) {
    return c.json({ error: 'No hay sesión activa.' }, 401, { 'Cache-Control': 'no-store' });
  }

  const body = await cuerpoJson(c.req.raw);
  if (!body) return c.json({ error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);

  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

  const resultado = await changePassword(c.env, sesion.user.id, currentPassword, newPassword);

  if (!resultado.success) {
    return c.json({ error: resultado.message }, resultado.status, { 'Cache-Control': 'no-store' });
  }

  return c.json({ success: true, message: resultado.message }, 200, {
    'Set-Cookie': clearCookieHeader(requestIsSecure(c.req.raw)),
    'Cache-Control': 'no-store',
  });
});

/* ── Auxiliares ────────────────────────────────────────────────────────────── */

/** Sesión pública del usuario: su perfil y sus despachos. */
async function sesionPublica(env: Env, userId: string) {
  const user = await getUserById(env, userId);
  if (!user) {
    return {
      user: { id: userId, email: '', fullName: '' },
      tenants: [],
      platformRole: 'user' as const,
    };
  }
  return publicSession({
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      platformRole: user.platformRole,
    },
    memberships: await getMemberships(env, user.id),
  });
}

/** Primer texto no vacío entre las claves candidatas. */
function firstTexto(...candidatos: unknown[]): string {
  for (const candidato of candidatos) {
    if (typeof candidato === 'string' && candidato.trim() !== '') {
      return candidato.trim().slice(0, 120);
    }
  }
  return '';
}

async function cuerpoJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Envía el correo de restablecimiento por Resend.
 *
 * Devuelve `false` si no hay correo configurado: el flujo sigue (el token
 * existe en D1) aunque el mensaje no llegue, y se avisa en el log.
 */
async function enviarCorreo(
  env: Env,
  to: string,
  subject: string,
  action: 'verificar' | 'restablecer',
  token: string,
  origin: string
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return false;

  const url = new URL('/', origin);
  url.searchParams.set('auth', action);
  url.searchParams.set('token', token);
  const enlace = url.toString();
  const etiqueta = action === 'verificar' ? 'Verificar correo' : 'Restablecer contraseña';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text: `${etiqueta}: ${enlace}\n\nSi no solicitaste esta acción, ignora este mensaje.`,
      html: `<p>${etiqueta} para tu cuenta de Arkangel.</p><p><a href="${enlace}">${etiqueta}</a></p><p>Si no solicitaste esta acción, ignora este mensaje.</p>`,
    }),
  });

  if (!response.ok) {
    logger.warn('Resend rechazó el correo de autenticación', { status: response.status });
    return false;
  }
  return true;
}
