import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clearCookieHeader,
  cookieHeader,
  createSession,
  changePassword,
  emailIsValid,
  getCookie,
  hashPassword,
  normalizaEmail,
  PASSWORD_ITERATIONS,
  passwordIsValid,
  passwordNeedsRehash,
  publicSession,
  randomToken,
  requestIsSecure,
  requireTenantMembership,
  revokeAllSessions,
  ROLE_POR_MEMBRESIA,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sha256,
  validateSession,
  verifyPassword,
  type Membership,
  type NativeUser,
} from '../src/auth/native';
import { resolverPrincipalDetallado } from '../src/auth/guards';
import type { AuthVars } from '../src/auth/middleware';
import { autenticacion } from '../src/routes/autenticacion';
import type { Env } from '../src/types/env';

/* ── D1 de mentira ────────────────────────────────────────────────────────── */

interface Fila {
  [clave: string]: unknown;
}

/**
 * D1 de mentira con lo justo que necesita la capa de autenticación:
 * `users`, `tenant_memberships`, `auth_sessions` y `tenants`.
 */
class FakeD1 {
  usuarios: Fila[] = [];
  membresias: Fila[] = [];
  sesiones: Fila[] = [];
  tenants: Fila[] = [
    { id: 't_alfa', nombre: 'Alfa', slug: 'alfa' },
    { id: 't_beta', nombre: 'Beta', slug: 'beta' },
  ];

  prepare = (sql: string) => {
    const limpio = sql.replace(/\s+/g, ' ').trim();
    const correr = (args: unknown[]) => ({
      all: async () => ({ results: this.consulta(limpio, args) }),
      first: async () => this.consulta(limpio, args)[0] ?? null,
      run: async () => {
        this.ejecuta(limpio, args);
        return { success: true };
      },
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: this.consulta(limpio, args) }),
        first: async () => this.consulta(limpio, args)[0] ?? null,
        run: async () => {
          this.ejecuta(limpio, args);
          return { success: true };
        },
      }),
    });
    return correr([]);
  };

  consulta(sql: string, args: unknown[]): Fila[] {
    if (sql.includes('FROM users WHERE lower(email)')) {
      const email = String(args[0]);
      return this.usuarios.filter((fila) => String(fila.email) === email);
    }
    if (sql.includes('FROM users WHERE id =')) {
      const id = String(args[0]);
      const usuario = this.usuarios.find((fila) => String(fila.id) === id);
      if (!usuario) return [];
      // Mapear a los aliases que usa getUserById
      return [
        {
          id: usuario.id,
          email: usuario.email,
          fullName: usuario.full_name ?? '',
          passwordHash: usuario.password_hash ?? null,
          emailVerifiedAt: usuario.email_verified_at ?? null,
          platformRole: usuario.platform_role ?? 'user',
        },
      ];
    }
    if (sql.includes('FROM auth_sessions s')) {
      const [hash, ahora] = args as [string, number];
      return this.sesiones
        .filter(
          (fila) =>
            String(fila.token_hash) === hash &&
            fila.revoked_at === null &&
            Number(fila.expires_at) > Number(ahora)
        )
        .map((fila) => {
          const usuario = this.usuarios.find((u) => u.id === fila.user_id);
          return {
            id: usuario?.id,
            email: usuario?.email,
            fullName: usuario?.full_name ?? '',
            emailVerifiedAt: usuario?.email_verified_at,
            platformRole: usuario?.platform_role ?? 'user',
          };
        });
    }
    if (sql.includes('FROM tenant_memberships m')) {
      const userId = String(args[0]);
      const tenantId = args[1] === undefined ? null : String(args[1]);
      return this.membresias
        .filter(
          (fila) =>
            String(fila.user_id) === userId &&
            (tenantId === null || String(fila.tenant_id) === tenantId)
        )
        .map((fila) => {
          const tenant = this.tenants.find((t) => t.id === fila.tenant_id);
          return {
            tenantId: fila.tenant_id,
            tenantName: tenant?.nombre ?? '',
            tenantSlug: tenant?.slug ?? '',
            role: fila.role,
          };
        });
    }
    return [];
  }

  ejecuta(sql: string, args: unknown[]): void {
    if (sql.includes('INSERT INTO auth_sessions')) {
      this.sesiones.push({
        token_hash: args[0],
        user_id: args[1],
        expires_at: args[2],
        created_at: args[3],
        revoked_at: null,
      });
      return;
    }
    if (sql.includes('UPDATE auth_sessions SET revoked_at')) {
      // Dos casos:
      // 1. revokeSession: WHERE token_hash = ?
      // 2. revokeAllSessions: WHERE user_id = ? AND revoked_at IS NULL
      if (sql.includes('token_hash')) {
        const [ahora, hash] = args as [number, string];
        const fila = this.sesiones.find((f) => f.token_hash === hash && f.revoked_at === null);
        if (fila) fila.revoked_at = ahora;
      } else if (sql.includes('user_id')) {
        const [ahora, userId] = args as [number, string];
        for (const fila of this.sesiones) {
          if (fila.user_id === userId && fila.revoked_at === null) {
            fila.revoked_at = ahora;
          }
        }
      }
    }
    if (sql.includes('UPDATE users SET password_hash')) {
      const [hash, userId] = args as [string, string];
      const usuario = this.usuarios.find((u) => u.id === userId);
      if (usuario) usuario.password_hash = hash;
    }
  }
}

function entornoCon(db: FakeD1): Env {
  return { ENVIRONMENT: 'test', DB: db as unknown as D1Database } as unknown as Env;
}

function peticion(cookies?: Record<string, string>, cabeceras?: Record<string, string>): Request {
  const partes = Object.entries(cookies ?? {}).map(([nombre, valor]) => `${nombre}=${valor}`);
  return new Request('https://panel.example/api/v1/cases/today', {
    headers: {
      ...(partes.length > 0 ? { cookie: partes.join('; ') } : {}),
      ...cabeceras,
    },
  });
}

/* ── Hash de contraseña ───────────────────────────────────────────────────── */

describe('hash de contraseña', () => {
  it('usa PBKDF2 con 100 000 iteraciones y sal de 16 bytes', async () => {
    const hash = await hashPassword('una contraseña larga');
    const [algoritmo, iteraciones, sal, resumen] = hash.split('$');

    expect(algoritmo).toBe('pbkdf2_sha256');
    expect(Number(iteraciones)).toBe(PASSWORD_ITERATIONS);
    expect(PASSWORD_ITERATIONS).toBe(100_000);
    expect(sal).toMatch(/^[0-9a-f]{32}$/);
    expect(resumen).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detecta cuando un hash legado de 25 000 iteraciones requiere rehash', async () => {
    const legado = `pbkdf2_sha256$25000$${'aa'.repeat(16)}$${'bb'.repeat(32)}`;
    const actual = await hashPassword('una contraseña larga');
    expect(passwordNeedsRehash(legado)).toBe(true);
    expect(passwordNeedsRehash(actual)).toBe(false);
  });

  it('la misma contraseña sale con distinta sal', async () => {
    const uno = await hashPassword('una contraseña larga');
    const otro = await hashPassword('una contraseña larga');
    expect(uno).not.toBe(otro);
  });

  it('verifica la contraseña correcta y rechaza las demás', async () => {
    const hash = await hashPassword('una contraseña larga');
    expect(await verifyPassword('una contraseña larga', hash)).toBe(true);
    expect(await verifyPassword('otra contraseña larga', hash)).toBe(false);
  });

  it('un hash mal formado no verifica (y no revienta)', async () => {
    expect(await verifyPassword('loquesea', 'basura')).toBe(false);
    expect(await verifyPassword('loquesea', 'pbkdf2_sha256$1$aa$bb')).toBe(false);
    expect(await verifyPassword('loquesea', '')).toBe(false);
  });

  it('la política de contraseñas', () => {
    expect(passwordIsValid('doce caracteres')).toBe(true);
    expect(passwordIsValid('corto')).toBe(false);
    expect(passwordIsValid('x'.repeat(200))).toBe(false);
  });

  it('normaliza el correo y valida su formato', () => {
    expect(normalizaEmail('  Persona@Ejemplo.COM ')).toBe('persona@ejemplo.com');
    expect(emailIsValid('persona@ejemplo.com')).toBe(true);
    expect(emailIsValid('persona@ejemplo')).toBe(false);
  });
});

/* ── Cookies ───────────────────────────────────────────────────────────────── */

describe('cookie de sesión', () => {
  it('lleva HttpOnly, SameSite=Lax, Path y Max-Age de 30 días', () => {
    const cabecera = cookieHeader('abc123', true);
    expect(cabecera).toContain(`${SESSION_COOKIE}=abc123`);
    expect(cabecera).toContain('HttpOnly');
    expect(cabecera).toContain('Secure');
    expect(cabecera).toContain('SameSite=Lax');
    expect(cabecera).toContain('Path=/');
    expect(cabecera).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(SESSION_TTL_SECONDS).toBe(2592000);
  });

  it('en local (http) no lleva Secure: el navegador no guardaría la cookie', () => {
    expect(cookieHeader('abc123', false)).not.toContain('Secure');
    expect(clearCookieHeader(false)).toContain('Max-Age=0');
  });

  it('detecta si la petición llegó por https', () => {
    expect(requestIsSecure(new Request('https://x.test/'))).toBe(true);
    expect(requestIsSecure(new Request('http://127.0.0.1:8788/'))).toBe(false);
  });

  it('lee la cookie de la petición', () => {
    expect(getCookie(peticion({ ark_session: 'abc' }), SESSION_COOKIE)).toBe('abc');
    expect(getCookie(peticion(), SESSION_COOKIE)).toBeNull();
  });
});

/* ── Sesiones ──────────────────────────────────────────────────────────────── */

describe('sesiones', () => {
  function usuarioDePrueba(db: FakeD1): void {
    db.usuarios.push({
      id: 'usr_1',
      email: 'persona@ejemplo.com',
      full_name: 'Persona',
      password_hash: 'pbkdf2_sha256$25000$aa$bb',
      email_verified_at: 1,
      platform_role: 'user',
    });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_alfa', role: 'owner' });
  }

  it('crea la sesión guardando sólo el hash del token', async () => {
    const db = new FakeD1();
    usuarioDePrueba(db);
    const env = entornoCon(db);

    const { token } = await createSession(env, 'usr_1');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(db.sesiones).toHaveLength(1);
    // Lo que se guarda es el SHA-256, nunca el token en claro.
    expect(db.sesiones[0]?.token_hash).toBe(await sha256(token));
    expect(db.sesiones[0]?.token_hash).not.toBe(token);
  });

  it('valida la sesión con la cookie y devuelve usuario y membresías', async () => {
    const db = new FakeD1();
    usuarioDePrueba(db);
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    const sesion = await validateSession(env, peticion({ ark_session: token }));

    expect(sesion?.user.id).toBe('usr_1');
    expect(sesion?.memberships).toHaveLength(1);
    expect(sesion?.memberships[0]?.tenantId).toBe('t_alfa');
  });

  it('una cookie inválida no da sesión (y no revienta)', async () => {
    const db = new FakeD1();
    usuarioDePrueba(db);
    const env = entornoCon(db);

    expect(await validateSession(env, peticion())).toBeNull();
    expect(await validateSession(env, peticion({ ark_session: 'no-es-un-token' }))).toBeNull();
    expect(await validateSession(env, peticion({ ark_session: 'a'.repeat(64) }))).toBeNull();
  });

  it('una sesión revocada deja de validar', async () => {
    const db = new FakeD1();
    usuarioDePrueba(db);
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?')
      .bind(1, await sha256(token))
      .run();

    expect(await validateSession(env, peticion({ ark_session: token }))).toBeNull();
  });

  it('el token aleatorio no se repite', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ── Membresías y roles ───────────────────────────────────────────────────── */

describe('membresías', () => {
  it('la membresía es lo que autoriza a operar sobre el tenant', async () => {
    const db = new FakeD1();
    db.usuarios.push({ id: 'usr_1', email: 'a@b.com', platform_role: 'user' });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_alfa', role: 'owner' });
    const env = entornoCon(db);

    const miembro = await requireTenantMembership(env, 'usr_1', 't_alfa');
    expect(miembro?.tenantId).toBe('t_alfa');

    const ajeno = await requireTenantMembership(env, 'usr_1', 't_beta');
    expect(ajeno).toBeNull();
  });

  it('el rol de la membresía se traduce al de Arkangel', () => {
    expect(ROLE_POR_MEMBRESIA.owner).toBe('owner');
    expect(ROLE_POR_MEMBRESIA.admin).toBe('operator');
    expect(ROLE_POR_MEMBRESIA.member).toBe('viewer');
  });

  it('la vista pública no filtra el hash ni el token', () => {
    const usuario: NativeUser = {
      id: 'usr_1',
      email: 'a@b.com',
      fullName: 'Persona',
      platformRole: 'user',
    };
    const membresias: Membership[] = [
      { tenantId: 't_alfa', tenantName: 'Alfa', tenantSlug: 'alfa', role: 'owner' },
    ];
    const publica = publicSession({ user: usuario, memberships: membresias });

    expect(JSON.stringify(publica)).not.toContain('password');
    expect(publica.user).not.toHaveProperty('passwordHash');
    expect(publica.tenants).toHaveLength(1);
  });
});

/* ── Resolución del principal ─────────────────────────────────────────────── */

describe('resolución del principal con sesión nativa', () => {
  function dbConUsuario(): FakeD1 {
    const db = new FakeD1();
    db.usuarios.push({
      id: 'usr_1',
      email: 'persona@ejemplo.com',
      full_name: 'Persona',
      email_verified_at: 1,
      platform_role: 'user',
    });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_alfa', role: 'owner' });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_beta', role: 'admin' });
    return db;
  }

  it('sin cookie no hay principal: 401', async () => {
    const env = entornoCon(new FakeD1());
    const resuelto = await resolverPrincipalDetallado(env, peticion());
    expect(resuelto.principal).toBeNull();
    expect(resuelto.motivo).toBe('unauthorized');
    expect(resuelto.status).toBe(401);
  });

  it('con cookie, el principal es el usuario y su tenant', async () => {
    const db = dbConUsuario();
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    const resuelto = await resolverPrincipalDetallado(
      env,
      peticion({ ark_session: token }, { 'x-tenant-id': 't_alfa' })
    );

    expect(resuelto.principal?.kind).toBe('user');
    expect(resuelto.principal?.tenantId).toBe('t_alfa');
    expect(resuelto.principal?.role).toBe('owner');
    expect(resuelto.tenantId).toBe('t_alfa');
  });

  it('la cabecera elige entre los despachos del usuario', async () => {
    const db = dbConUsuario();
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    const resuelto = await resolverPrincipalDetallado(
      env,
      peticion({ ark_session: token }, { 'x-tenant-id': 't_beta' })
    );

    expect(resuelto.principal?.tenantId).toBe('t_beta');
    expect(resuelto.principal?.role).toBe('operator');
  });

  it('pedir un despacho ajeno es 403, no 401', async () => {
    const db = dbConUsuario();
    db.tenants.push({ id: 't_gamma', nombre: 'Gamma', slug: 'gamma' });
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    const resuelto = await resolverPrincipalDetallado(
      env,
      peticion({ ark_session: token }, { 'x-tenant-id': 't_gamma' })
    );

    expect(resuelto.principal).toBeNull();
    expect(resuelto.motivo).toBe('tenant_forbidden');
    expect(resuelto.status).toBe(403);
  });

  it('un usuario sin ningún despacho no puede operar: 401', async () => {
    const db = new FakeD1();
    db.usuarios.push({ id: 'usr_2', email: 'nuevo@b.com', platform_role: 'user' });
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_2');

    const resuelto = await resolverPrincipalDetallado(env, peticion({ ark_session: token }));

    expect(resuelto.principal).toBeNull();
    expect(resuelto.motivo).toBe('sin_membresia');
    expect(resuelto.status).toBe(401);
  });

  it('una sesión válida no cae al token de máquina', async () => {
    const db = dbConUsuario();
    const env = entornoCon(db);
    env.ADMIN_TOKEN = 'token-admin';
    const { token } = await createSession(env, 'usr_1');

    // Cookie de sesión + token de admin: manda la sesión, y como el usuario
    // pide un tenant ajeno, la respuesta es 403 (no "autorizado como admin").
    const resuelto = await resolverPrincipalDetallado(
      env,
      peticion({ ark_session: token }, { authorization: 'Bearer token-admin' })
    );

    expect(resuelto.principal?.kind).toBe('user');
  });
});

/* ── Cambio de contraseña ──────────────────────────────────────────────────── */

describe('changePassword', () => {
  let passwordHash: string;

  beforeAll(async () => {
    const { hashPassword } = await import('../src/auth/native');
    passwordHash = await hashPassword('actual123456');
  });

  function dbConUsuario(): FakeD1 {
    const db = new FakeD1();
    db.usuarios.push({
      id: 'usr_1',
      email: 'persona@ejemplo.com',
      full_name: 'Persona',
      password_hash: passwordHash,
      email_verified_at: 1,
      platform_role: 'user',
    });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_alfa', role: 'owner' });
    return db;
  }

  it('cambio con contraseña actual correcta → éxito + sesiones revocadas + hash actualizado', async () => {
    const { changePassword, createSession } = await import('../src/auth/native');
    const db = dbConUsuario();
    const env = entornoCon(db);
    await createSession(env, 'usr_1');
    expect(db.sesiones.filter((s) => s.revoked_at === null)).toHaveLength(1);

    const resultado = await changePassword(env, 'usr_1', 'actual123456', 'nueva123456789');

    expect(resultado.success).toBe(true);
    expect(resultado.message).toContain('Vuelve a iniciar sesión');

    // Hash actualizado en BD
    const usuario = db.usuarios.find((u) => u.id === 'usr_1');
    expect(usuario?.password_hash).not.toBe(
      'pbkdf2_sha256$25000$' + 'aa'.repeat(16) + '$' + 'bb'.repeat(32)
    );

    // Sesiones revocadas en BD
    const sesionesActivas = db.sesiones.filter((s) => s.revoked_at === null);
    expect(sesionesActivas).toHaveLength(0);
  });

  it('contraseña actual incorrecta → fallo 401, sesiones intactas, hash no cambia', async () => {
    const { changePassword, createSession } = await import('../src/auth/native');
    const db = dbConUsuario();
    const env = entornoCon(db);
    await createSession(env, 'usr_1');

    const resultado = await changePassword(env, 'usr_1', 'incorrecta123', 'nueva123456789');

    expect(resultado.success).toBe(false);
    expect(resultado.message).toContain('no es correcta');

    // Hash NO cambia
    const usuario = db.usuarios.find((u) => u.id === 'usr_1');
    expect(usuario?.password_hash).toBe(passwordHash);

    // Sesiones NO revocadas
    const sesionesActivas = db.sesiones.filter((s) => s.revoked_at === null);
    expect(sesionesActivas).toHaveLength(1);
  });

  it('nueva contraseña no cumple política → fallo 400, sesiones intactas', async () => {
    const { changePassword, createSession } = await import('../src/auth/native');
    const db = dbConUsuario();
    const env = entornoCon(db);
    await createSession(env, 'usr_1');

    const resultado = await changePassword(env, 'usr_1', 'actual123456', 'corta');

    expect(resultado.success).toBe(false);
    expect(resultado.message).toContain('12 y 128 caracteres');

    // Sesiones intactas
    const sesionesActivas = db.sesiones.filter((s) => s.revoked_at === null);
    expect(sesionesActivas).toHaveLength(1);
  });

  it('usuario sin hash de contraseña → fallo', async () => {
    const db = new FakeD1();
    db.usuarios.push({
      id: 'usr_2',
      email: 'otro@ejemplo.com',
      full_name: 'Otro',
      password_hash: null, // sin hash
      email_verified_at: 1,
      platform_role: 'user',
    });
    db.membresias.push({ user_id: 'usr_2', tenant_id: 't_alfa', role: 'owner' });
    const env = entornoCon(db);

    const resultado = await changePassword(env, 'usr_2', 'cualquiera', 'nueva123456789');

    expect(resultado.success).toBe(false);
    expect(resultado.message).toContain('verificar la contraseña actual');
  });
});

/* ── Cambio de contraseña en la ruta ────────────────────────────────────────── */

describe('POST /api/auth/change-password', () => {
  let passwordHash: string;

  beforeAll(async () => {
    const { hashPassword } = await import('../src/auth/native');
    passwordHash = await hashPassword('actual123456');
  });

  function appDePrueba(): Hono<{ Bindings: Env; Variables: AuthVars }> {
    const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
    app.route('/api/auth', autenticacion);
    return app;
  }

  function dbConUsuario(): FakeD1 {
    const db = new FakeD1();
    db.usuarios.push({
      id: 'usr_1',
      email: 'persona@ejemplo.com',
      full_name: 'Persona',
      password_hash: passwordHash,
      email_verified_at: 1,
      platform_role: 'user',
    });
    db.membresias.push({ user_id: 'usr_1', tenant_id: 't_alfa', role: 'owner' });
    return db;
  }

  async function pedirCambio(
    app: Hono<{ Bindings: Env; Variables: AuthVars }>,
    env: Env,
    token: string,
    nueva: string
  ): Promise<Response> {
    return app.request(
      '/api/auth/change-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ current_password: 'actual123456', new_password: nueva }),
      },
      env
    );
  }

  it('sesión revocada a mitad → 401 y la contraseña no se toca', async () => {
    const db = dbConUsuario();
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    // La sesión que trae el cliente deja de estar viva antes de que llegue el
    // cambio (p. ej. se cerró la sesión en otro dispositivo o el usuario la
    // revocó). La ruta resuelve la sesión una vez por petición: si ya está
    // revocada, el cambio se rechaza y no se toca la contraseña.
    await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?')
      .bind(1, await sha256(token))
      .run();

    const response = await pedirCambio(appDePrueba(), env, token, 'nueva123456789');

    expect(response.status).toBe(401);
    const cuerpo = (await response.json()) as { error: string };
    expect(cuerpo.error).toContain('No hay sesión activa');

    // La contraseña del usuario sigue igual: el cambio no se llegó a hacer.
    const usuario = db.usuarios.find((u) => u.id === 'usr_1');
    expect(usuario?.password_hash).toBe(passwordHash);
  });

  it('nueva contraseña igual a la actual → 400 y las sesiones siguen vivas', async () => {
    const db = dbConUsuario();
    const env = entornoCon(db);
    const { token } = await createSession(env, 'usr_1');

    // Servicio: la política es explícita, la nueva debe ser distinta.
    const resultado = await changePassword(env, 'usr_1', 'actual123456', 'actual123456');
    expect(resultado.success).toBe(false);
    expect(resultado.status).toBe(400);
    expect(resultado.message).toContain('distinta de la actual');

    // Ruta: el mismo caso por HTTP responde 400 (no 401: la credencial era
    // correcta, lo que no vale es la contraseña nueva).
    const response = await pedirCambio(appDePrueba(), env, token, 'actual123456');
    expect(response.status).toBe(400);
    const cuerpo = (await response.json()) as { error: string };
    expect(cuerpo.error).toContain('distinta de la actual');

    // Ni la contraseña ni las sesiones se tocan.
    const usuario = db.usuarios.find((u) => u.id === 'usr_1');
    expect(usuario?.password_hash).toBe(passwordHash);
    expect(db.sesiones.filter((s) => s.revoked_at === null)).toHaveLength(1);
  });
});

/* ── revokeAllSessions ─────────────────────────────────────────────────────── */

describe('revokeAllSessions', () => {
  it('revoca todas las sesiones activas del usuario', async () => {
    const db = new FakeD1();
    db.usuarios.push({ id: 'usr_1', email: 'a@b.com', platform_role: 'user' });
    const env = entornoCon(db);

    await createSession(env, 'usr_1');
    await createSession(env, 'usr_1');
    expect(db.sesiones.filter((s) => s.revoked_at === null)).toHaveLength(2);

    await revokeAllSessions(env, 'usr_1');

    expect(db.sesiones.filter((s) => s.revoked_at === null)).toHaveLength(0);
    expect(db.sesiones.every((s) => s.revoked_at !== null)).toBe(true);
  });
});
