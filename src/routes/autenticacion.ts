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
  PASSWORD_ITERATIONS,
  passwordIsValid,
  passwordNeedsRehash,
  publicSession,
  rateLimited,
  requestIsSecure,
  RESET_TTL_SECONDS,
  revokeAllSessions,
  revokeSession,
  verifyPassword,
} from '../auth/native';
import { enviarCorreoAuth } from '../auth/email';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';

export const autenticacion = new Hono<{ Bindings: Env; Variables: AuthVars }>();

autenticacion.use('*', authenticateRequest);

/**
 * El registro publico esta CERRADO: el panel es por invitacion. Las altas las
 * hace un administrador con `scripts/seed-owner.ts`. Se conserva la ruta (y no
 * un 404) para que el frontend y los monitores reciban una respuesta clara.
 */
autenticacion.post('/register', async (c) => {
  return c.json(
    {
      error: 'El registro esta cerrado. Solicita una invitacion al administrador.',
      code: 'registro_cerrado',
    },
    403,
    { 'Cache-Control': 'no-store' }
  );
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
    logger.warn('Intento de login fallido');
    return c.json({ error: 'Correo o contraseña incorrectos.' }, 401);
  }

  if (user.passwordHash && passwordNeedsRehash(user.passwordHash)) {
    const nuevoHash = await hashPassword(password);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(nuevoHash, user.id)
      .run();
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

  // La respuesta no debe depender de si la cuenta existe: el trabajo (token +
  // correo) corre en segundo plano y la respuesta es siempre la misma 202.
  const origen = new URL(c.req.url).origin;
  const trabajo = (async () => {
    const user = await getUserByEmail(c.env, email);
    if (!user?.emailVerifiedAt) return;
    const token = await issueActionToken(c.env, user.id, 'reset_password', RESET_TTL_SECONDS);
    await enviarCorreoAuth(c.env, email, 'restablecer', token, origen);
  })().catch((error) => {
    logger.error('Fallo el restablecimiento de contrasena', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  try {
    c.executionCtx.waitUntil(trabajo);
  } catch {
    await trabajo; // sin ExecutionContext (tests)
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

  // El hash se calcula ANTES de consumir el token: si falla, el enlace sigue vivo.
  const nuevoHash = await hashPassword(password);
  const userId = await consumeActionToken(c.env, token, 'reset_password');
  if (!userId)
    return c.json({ error: 'El enlace de restablecimiento no es válido o expiró.' }, 400);

  // Recibir el enlace en el correo prueba que la cuenta controla ese buzon.
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, unixepoch()) WHERE id = ?'
  )
    .bind(nuevoHash, userId)
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

async function cuerpoJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
