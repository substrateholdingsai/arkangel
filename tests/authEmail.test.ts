import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { construirEnlace, enviarCorreoAuth, remitenteAuth } from '../src/auth/email';
import type { AuthVars } from '../src/auth/middleware';
import { sha256 } from '../src/auth/native';
import { autenticacion } from '../src/routes/autenticacion';
import type { Env } from '../src/types/env';

/** D1 de mentira: usuarios, tokens de acción y lo mínimo de sesiones/rate limit. */
class DbTokens {
  usuarios: Record<string, unknown>[] = [];
  tokens: {
    token_hash: string;
    user_id: string;
    purpose: string;
    expires_at: number;
    used_at: number | null;
  }[] = [];
  sesionesRevocadas: string[] = [];

  prepare = (sql: string) => {
    const limpio = sql.replace(/\s+/g, ' ').trim();
    const ejecutar = (args: unknown[]) => ({
      first: async () => this.primero(limpio, args),
      run: async () => {
        this.correr(limpio, args);
        return { success: true };
      },
      all: async () => ({ results: [] }),
    });
    return { ...ejecutar([]), bind: (...args: unknown[]) => ejecutar(args) };
  };

  primero(sql: string, args: unknown[]): unknown {
    if (sql.includes('FROM users WHERE lower(email)')) {
      return this.usuarios.find((u) => u.email === args[0]) ?? null;
    }
    if (sql.includes('INSERT INTO auth_rate_limits')) return { attempts: 1 };
    if (sql.includes('UPDATE auth_tokens SET used_at') && sql.includes('RETURNING')) {
      const [ahora, hash, proposito] = args as [number, string, string, number];
      const fila = this.tokens.find(
        (t) =>
          t.token_hash === hash &&
          t.purpose === proposito &&
          t.used_at === null &&
          t.expires_at > Number(args[3])
      );
      if (!fila) return null;
      fila.used_at = ahora;
      return { user_id: fila.user_id };
    }
    return null;
  }

  correr(sql: string, args: unknown[]): void {
    if (sql.includes('INSERT INTO auth_tokens')) {
      this.tokens.push({
        token_hash: String(args[0]),
        user_id: String(args[1]),
        purpose: String(args[2]),
        expires_at: Number(args[3]),
        used_at: null,
      });
    }
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const usuario = this.usuarios.find((u) => u.id === args[1]);
      if (usuario) {
        usuario.passwordHash = args[0];
        usuario.emailVerifiedAt ??= 1;
      }
    }
    if (sql.includes('UPDATE auth_sessions SET revoked_at')) {
      this.sesionesRevocadas.push(String(args[1]));
    }
  }
}

function entorno(db: DbTokens, extra: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database,
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'Arkangel <cobranza@arksystems.site>',
    AUTH_FROM_EMAIL: 'Arkangel <auth@arksystems.site>',
    APP_URL: 'https://panel.arksystems.site',
    ...extra,
  } as unknown as Env;
}

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  a.route('/api/auth', autenticacion);
  return a;
}

function post(ruta: string, cuerpo: unknown, env: Env) {
  return app().request(
    ruta,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    },
    env
  );
}

const usuario = {
  id: 'usr_1',
  email: 'duenio@arksystems.site',
  fullName: 'Dueño',
  passwordHash: 'viejo',
  emailVerifiedAt: 1,
  platformRole: 'user',
};

afterEach(() => vi.restoreAllMocks());

describe('correo de auth', () => {
  it('usa el remitente de auth, no el de cobranza', () => {
    expect(remitenteAuth(entorno(new DbTokens()))).toContain('auth@arksystems.site');
    expect(remitenteAuth(entorno(new DbTokens(), { AUTH_FROM_EMAIL: undefined }))).toContain(
      'cobranza@'
    );
  });

  it('el enlace sale de APP_URL, no del origen de la petición', () => {
    const enlace = construirEnlace(
      entorno(new DbTokens()),
      'restablecer',
      'a'.repeat(64),
      'https://evil.test'
    );
    expect(enlace.startsWith('https://panel.arksystems.site/')).toBe(true);
    expect(enlace).toContain('auth=restablecer');
  });

  it('sin RESEND_API_KEY devuelve false y no llama a la red', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ok = await enviarCorreoAuth(
      entorno(new DbTokens(), { RESEND_API_KEY: '' }),
      'x@y.com',
      'restablecer',
      'a'.repeat(64),
      'https://o.test'
    );
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('registro cerrado', () => {
  it('POST /register responde 403 registro_cerrado', async () => {
    const res = await post(
      '/api/auth/register',
      { email: 'a@b.com', password: 'una contrasena larga' },
      entorno(new DbTokens())
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('registro_cerrado');
  });
});

describe('restablecer contraseña', () => {
  it('cuenta existente: 202, correo por Resend con el remitente de auth y token hasheado', async () => {
    const db = new DbTokens();
    db.usuarios.push({ ...usuario });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await post(
      '/api/auth/request-password-reset',
      { email: usuario.email },
      entorno(db)
    );

    expect(res.status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const envio = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(envio.from).toContain('auth@arksystems.site');
    expect(envio.to).toEqual([usuario.email]);
    const token = /token=([0-9a-f]{64})/.exec(envio.text)?.[1] ?? '';
    expect(token).toHaveLength(64);
    // En D1 solo el SHA-256, nunca el token en claro.
    expect(db.tokens[0]?.token_hash).toBe(await sha256(token));
    expect(JSON.stringify(db.tokens)).not.toContain(token);
  });

  it('cuenta inexistente: misma 202 y NO se envía nada', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(
      '/api/auth/request-password-reset',
      { email: 'nadie@arksystems.site' },
      entorno(new DbTokens())
    );
    expect(res.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el token cambia la contraseña, revoca sesiones y solo sirve una vez', async () => {
    const db = new DbTokens();
    db.usuarios.push({ ...usuario });
    const token = 'b'.repeat(64);
    db.tokens.push({
      token_hash: await sha256(token),
      user_id: 'usr_1',
      purpose: 'reset_password',
      expires_at: Math.floor(Date.now() / 1000) + 600,
      used_at: null,
    });
    const env = entorno(db);

    const primera = await post(
      '/api/auth/reset-password',
      { token, password: 'nueva contrasena larga' },
      env
    );
    expect(primera.status).toBe(200);
    expect(db.usuarios[0]?.passwordHash).not.toBe('viejo');
    expect(db.sesionesRevocadas).toContain('usr_1');

    const segunda = await post(
      '/api/auth/reset-password',
      { token, password: 'otra contrasena larga' },
      env
    );
    expect(segunda.status).toBe(400);
  });

  it('un token caducado se rechaza y no toca la contraseña', async () => {
    const db = new DbTokens();
    db.usuarios.push({ ...usuario });
    const token = 'c'.repeat(64);
    db.tokens.push({
      token_hash: await sha256(token),
      user_id: 'usr_1',
      purpose: 'reset_password',
      expires_at: 1,
      used_at: null,
    });
    const res = await post(
      '/api/auth/reset-password',
      { token, password: 'nueva contrasena larga' },
      entorno(db)
    );
    expect(res.status).toBe(400);
    expect(db.usuarios[0]?.passwordHash).toBe('viejo');
  });
});
