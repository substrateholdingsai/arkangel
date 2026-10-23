/**
 * Autenticación nativa de Arkangel: identidad, sesiones y cookies sobre D1.
 *
 * Por qué es nativa y no un SaaS: el panel es la única puerta de entrada al
 * Worker y depender de un proveedor externo para abrirlo convertía la
 * operación en una suscripción. Con esta capa no hay red de por medio: la
 * contraseña se verifica con PBKDF2 en el propio Worker y la sesión es un
 * token aleatorio que D1 guarda **hasheado**.
 *
 * Reglas que no se negocian:
 *   · El token de sesión sólo existe en texto plano en la cookie del
 *     navegador (HttpOnly). En D1 sólo vive su SHA-256: leer la base no
 *     permite suplantar a nadie.
 *   · La contraseña nunca se guarda ni se compara en claro: `password_hash`
 *     es `pbkdf2_sha256$25000$salt$hash`.
 *   · Ser miembro de un tenant es lo que autoriza a operar sobre él. El
 *     `X-Tenant-Id` del navegador *selecciona* entre los despachos del
 *     usuario; nunca amplía lo que la membresía concede.
 *   · Las credenciales de máquina (tokens de servicio) NO pasan por aquí:
 *     son otro actor y se resuelven en `guards.ts`.
 */

import { logger } from '../lib/logger';
import { esErrorDeTablaFaltante } from '../tenancy/repository';
import type { Env } from '../types/env';
import type { Role } from './scopes';

/** Nombre de la cookie de sesión. */
export const SESSION_COOKIE = 'ark_session';

/** Vida de la sesión: 30 días (2592000 s). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Iteraciones de PBKDF2 para el hash de la contraseña. */
export const PASSWORD_ITERATIONS = 100_000;

/** Vida del token de restablecimiento de contraseña: 30 minutos. */
export const RESET_TTL_SECONDS = 60 * 30;

/** Vida del token de invitación a un despacho: 7 días. */
export const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Longitud mínima de la contraseña. */
export const PASSWORD_MIN_LENGTH = 12;

/** Longitud máxima de la contraseña (evita que PBKDF2 se coma la CPU). */
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const HASH_BYTES = 32;

/** Rol de plataforma: `super_admin` opera sobre cualquier tenant. */
export type PlatformRole = 'user' | 'super_admin';

/** Rol de la membresía dentro de un tenant. */
export type MembershipRole = 'owner' | 'admin' | 'member';

/** Usuario autenticado. */
export interface NativeUser {
  id: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
}

/** Membresía de un usuario en un tenant. */
export interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

/** Sesión resuelta: quién es y en qué despachos puede operar. */
export interface NativeSession {
  user: NativeUser;
  memberships: Membership[];
}

/**
 * Traducción del rol de Ark Ledger al rol de Arkangel.
 *
 * Arkangel tiene una matriz de scopes más fina (owner, compliance, operator,
 * viewer) y una separación de funciones deliberada: quien edita la config
 * legal no es quien dispara el envío. El orden se conserva:
 *
 *   · `owner`  → `owner`   (todo el tenant, incluidos `legal:config`).
 *   · `admin`  → `operator` (trabaja casos y dispara cobranza).
 *   · `member` → `viewer`  (sólo lectura: fail-safe).
 *
 * Es el único punto donde se decide qué puede hacer un humano, así que
 * cambiar el reparto de permisos es cambiar esta tabla.
 */
export const ROLE_POR_MEMBRESIA: Record<MembershipRole, Role> = {
  owner: 'owner',
  admin: 'operator',
  member: 'viewer',
};

/* ── Primitivas ────────────────────────────────────────────────────────────── */

/** Token aleatorio en hexadecimal (32 bytes → 64 caracteres). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 en hexadecimal. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Hashea una contraseña con PBKDF2 (SHA-256, 100 000 iteraciones, sal de 16
 * bytes). Formato: `pbkdf2_sha256$100000$salt$hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
    key,
    HASH_BYTES * 8
  );
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

/**
 * ¿El hash guardado usa menos iteraciones que `PASSWORD_ITERATIONS`?
 * Si es así, el login recalcula el hash para endurecerlo sin pedir cambio.
 */
export function passwordNeedsRehash(encoded: string): boolean {
  const [algorithm, iterationsText] = encoded.split('$');
  const iterations = Number(iterationsText);
  return (
    algorithm === 'pbkdf2_sha256' &&
    Number.isSafeInteger(iterations) &&
    iterations < PASSWORD_ITERATIONS
  );
}

/**
 * Verifica una contraseña contra su hash.
 *
 * La comparación es en tiempo constante (acorta la ventana para adivinar el
 * hash) y devuelve `false` —no lanza— si el hash está mal formado: un hash
 * corrupto es "no coincide", no una excepción.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltHex, expectedHex] = encoded.split('$');
  const iterations = Number(iterationsText);
  if (
    algorithm !== 'pbkdf2_sha256' ||
    !Number.isSafeInteger(iterations) ||
    iterations < 5_000 ||
    iterations > 600_000 ||
    typeof saltHex !== 'string' ||
    !/^[0-9a-f]{32}$/.test(saltHex) ||
    typeof expectedHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expectedHex)
  ) {
    return false;
  }

  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BYTES * 8
  );
  const actual = toHex(new Uint8Array(bits));

  let difference = actual.length ^ expectedHex.length;
  for (let i = 0; i < Math.min(actual.length, expectedHex.length); i += 1) {
    difference |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return difference === 0;
}

/** ¿La contraseña cumple la política? */
export function passwordIsValid(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

/** Normaliza el correo: minúsculas y sin espacios. */
export function normalizaEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** ¿El correo tiene forma de correo? */
export function emailIsValid(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ── Cookies ───────────────────────────────────────────────────────────────── */

/**
 * Cabecera `Set-Cookie` de la sesión.
 *
 * `Secure` sólo se añade si la petición llegó por HTTPS: en local
 * (`http://127.0.0.1:8788`) un `Secure` haría que el navegador no guardara la
 * cookie y el panel quedaría imposible de usar.
 */
export function cookieHeader(token: string, secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Cabecera `Set-Cookie` que borra la sesión del navegador. */
export function clearCookieHeader(secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=0`;
}

/** ¿La petición llegó por HTTPS? */
export function requestIsSecure(request: Request): boolean {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Lee una cookie de la petición. */
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const pair = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

/* ── Usuarios y membresías ─────────────────────────────────────────────────── */

const SQL_USUARIO_POR_EMAIL =
  "SELECT id, email, COALESCE(full_name, '') AS fullName, password_hash AS passwordHash, email_verified_at AS emailVerifiedAt, platform_role AS platformRole FROM users WHERE lower(email) = ? LIMIT 1";

const SQL_MEMBRESIAS = `SELECT m.tenant_id AS tenantId, t.nombre AS tenantName, t.slug AS tenantSlug, m.role AS role
   FROM tenant_memberships m
   JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = ?
   ORDER BY t.nombre ASC`;

const SQL_MEMBRESIA_EN_TENANT = `SELECT m.tenant_id AS tenantId, t.nombre AS tenantName, t.slug AS tenantSlug, m.role AS role
   FROM tenant_memberships m
   JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = ? AND m.tenant_id = ?
   LIMIT 1`;

/** Fila de `users` tal y como la devuelve D1. */
export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  emailVerifiedAt: number | null;
  platformRole: PlatformRole;
}

/** Busca el usuario por correo. */
export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(SQL_USUARIO_POR_EMAIL)
    .bind(normalizaEmail(email))
    .first<UserRow>();
  return row ?? null;
}

/** Busca el usuario por id. */
export async function getUserById(env: Env, userId: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, COALESCE(full_name, '') AS fullName, password_hash AS passwordHash,
            email_verified_at AS emailVerifiedAt, platform_role AS platformRole
     FROM users WHERE id = ? LIMIT 1`
  )
    .bind(userId)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Membresías del usuario: los despachos en los que puede operar.
 *
 * Si las tablas de auth todavía no existen (migración 0007 sin aplicar) se
 * devuelve una lista vacía en vez de reventar: no hay identidades que
 * resolver, que es un estado válido.
 */
export async function getMemberships(env: Env, userId: string): Promise<Membership[]> {
  try {
    const result = await env.DB.prepare(SQL_MEMBRESIAS).bind(userId).all<Membership>();
    return result.results ?? [];
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_memberships', 'tenants'])) return [];
    throw error;
  }
}

/**
 * ¿El usuario es miembro de ese tenant?
 *
 * Es la pregunta que decide si puede operar sobre él: la cabecera
 * `X-Tenant-Id` selecciona entre los despachos del usuario, y esta función es
 * el filtro que impide seleccionar uno ajeno.
 */
export async function requireTenantMembership(
  env: Env,
  userId: string,
  tenantId: string
): Promise<Membership | null> {
  try {
    const row = await env.DB.prepare(SQL_MEMBRESIA_EN_TENANT)
      .bind(userId, tenantId)
      .first<Membership>();
    return row ?? null;
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_memberships', 'tenants'])) return null;
    throw error;
  }
}

/* ── Sesiones ──────────────────────────────────────────────────────────────── */

/**
 * Crea una sesión y devuelve el token **en texto plano**.
 *
 * El token plano viaja del Worker al navegador (en la cookie) y nunca se
 * guarda: a D1 va su SHA-256.
 */
export async function createSession(
  env: Env,
  userId: string
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(await sha256(token), userId, expiresAt, now)
    .run();
  return { token, expiresAt };
}

/**
 * Valida la cookie de sesión.
 *
 * `null` si no hay cookie, si el token no tiene forma de token o si la sesión
 * está caducada, revocada o su usuario ya no existe. Nunca lanza: la ausencia
 * de identidad es un dato, no un fallo.
 */
export async function validateSession(env: Env, request: Request): Promise<NativeSession | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const now = Math.floor(Date.now() / 1000);
  let row: UserRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT u.id, u.email, COALESCE(u.full_name, '') AS fullName,
              u.password_hash AS passwordHash, u.email_verified_at AS emailVerifiedAt,
              u.platform_role AS platformRole
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       LIMIT 1`
    )
      .bind(await sha256(token), now)
      .first<UserRow>();
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['auth_sessions', 'users'])) return null;
    throw error;
  }

  if (!row) return null;

  const memberships = await getMemberships(env, row.id);
  return {
    user: {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      platformRole: row.platformRole,
    },
    memberships,
  };
}

/** Revoca la sesión de la petición (si la hay) y devuelve si revocó algo. */
export async function revokeSession(env: Env, request: Request): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'
  )
    .bind(now, await sha256(token))
    .run();
  return Boolean(result.success);
}

/** Revoca todas las sesiones de un usuario (cambio de contraseña). */
export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
  )
    .bind(now, userId)
    .run();
}

/**
 * Cambia la contraseña del usuario autenticado (requiere contraseña actual).
 *
 * `status` viaja con el resultado en vez de deducirse del texto del mensaje:
 * la ruta lo devuelve tal cual y así el código HTTP deja de depender de que
 * una palabra aparezca o no en la frase.
 */
export interface ChangePasswordResult {
  success: boolean;
  message: string;
  status: 200 | 400 | 401;
}

export async function changePassword(
  env: Env,
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  if (!currentPassword || !newPassword) {
    return {
      success: false,
      message: 'Se requieren la contraseña actual y la nueva.',
      status: 400,
    };
  }
  if (!passwordIsValid(newPassword)) {
    return {
      success: false,
      message: 'La contraseña nueva debe tener entre 12 y 128 caracteres.',
      status: 400,
    };
  }

  const user = await getUserById(env, userId);
  if (!user || !user.passwordHash) {
    return {
      success: false,
      message: 'No se pudo verificar la contraseña actual.',
      status: 400,
    };
  }

  const coincide = await verifyPassword(currentPassword, user.passwordHash);
  if (!coincide) {
    logger.warn('Contraseña actual incorrecta', { userId });
    return { success: false, message: 'La contraseña actual no es correcta.', status: 401 };
  }

  // Política: la nueva contraseña debe ser distinta de la actual. Reutilizar la
  // misma no cambia nada del secreto y sólo sirve para revocar todas las
  // sesiones del usuario, que es justo lo que un atacante que yaEntró en otra
  // cuenta provocaría. Se rechaza con 400 (la contraseña actual sí era
  // correcta: el problema es la nueva, no la credencial).
  if (currentPassword === newPassword) {
    return {
      success: false,
      message: 'La contraseña nueva debe ser distinta de la actual.',
      status: 400,
    };
  }

  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), userId)
    .run();
  await revokeAllSessions(env, userId);

  return {
    success: true,
    message: 'Contraseña actualizada. Vuelve a iniciar sesión.',
    status: 200,
  };
}

/* ── Tokens de acción (verificación / restablecimiento) ────────────────────── */

/** Emite un token de un solo uso y lo guarda hasheado. */
export async function issueActionToken(
  env: Env,
  userId: string,
  purpose: 'verify_email' | 'reset_password',
  ttlSeconds: number
): Promise<string> {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`
  )
    .bind(now, userId, purpose)
    .run();
  await env.DB.prepare(
    `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(await sha256(token), userId, purpose, now + ttlSeconds, now)
    .run();
  return token;
}

/**
 * Consume un token de acción: lo marca usado y devuelve el usuario al que
 * pertenece. `null` si no existe, ya se usó o caducó.
 */
export async function consumeActionToken(
  env: Env,
  token: string,
  purpose: 'verify_email' | 'reset_password'
): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ?
     WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
     RETURNING user_id`
  )
    .bind(now, await sha256(token), purpose, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/* ── Rate limiting ─────────────────────────────────────────────────────────── */

/**
 * ¿Se agotaron los intentos de este cubo?
 *
 * Ventana deslizante: si la ventana venció, el contador se reinicia. El cubo
 * se guarda hasheado (`scope:valor`) para que D1 no Guarde correos en claro.
 */
export async function rateLimit(
  env: Env,
  scope: string,
  value: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const key = await sha256(`${scope}:${value}`);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;

  try {
    const result = await env.DB.prepare(
      `INSERT INTO auth_rate_limits (bucket_key, window_started_at, attempts)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_key) DO UPDATE SET
         attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
         window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END
       RETURNING attempts`
    )
      .bind(key, now, windowStart, windowStart, now)
      .first<{ attempts: number }>();
    return (result?.attempts ?? 0) > limit;
  } catch (error) {
    // Sin la tabla de rate limits no se debe tumbar el login: es una defensa
    // adicional, no la única.
    if (esErrorDeTablaFaltante(error, ['auth_rate_limits'])) return false;
    throw error;
  }
}

/** Rate limit por IP y por correo a la vez. */
export async function rateLimited(
  request: Request,
  env: Env,
  scope: string,
  email: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const [ipLimited, emailLimited] = await Promise.all([
    rateLimit(env, `${scope}:ip`, ip, limit * 5, windowSeconds),
    rateLimit(env, `${scope}:email`, email, limit, windowSeconds),
  ]);
  return ipLimited || emailLimited;
}

/* ── Vistas públicas ───────────────────────────────────────────────────────── */

/** Lo que el navegador recibe: nunca el hash, nunca el token. */
export interface PublicSession {
  user: { id: string; email: string; fullName: string };
  tenants: Membership[];
  platformRole: PlatformRole;
}

/** Vista pública de la sesión. */
export function publicSession(session: NativeSession): PublicSession {
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      fullName: session.user.fullName,
    },
    tenants: session.memberships,
    platformRole: session.user.platformRole,
  };
}

/**
 * Registra un usuario nuevo con su primer despacho.
 *
 * El alta real la hace `scripts/seed-owner.ts`; esta vía existe para que el
 * propio panel pueda darse de alta. El usuario nace verificado (`email_verified_at`)
 * porque el panel es de invitación, no de registro público: poner un muro de
 * correo delante sin un servidor de correo configurado dejaría a la gente
 * fuera de su propio panel.
 */
export async function registerUser(
  env: Env,
  input: { email: string; password: string; fullName: string; tenantName: string }
): Promise<{ userId: string; tenantId: string }> {
  const email = normalizaEmail(input.email);
  const now = Math.floor(Date.now() / 1000);
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(env, input.tenantName);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, full_name, password_hash, email_verified_at, platform_role, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?)`
    ).bind(userId, email, input.fullName, passwordHash, now, now),
    env.DB.prepare(
      `INSERT INTO tenants (id, slug, nombre, status, config_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'db', datetime('now'), datetime('now'))`
    ).bind(tenantId, slug, input.tenantName),
    env.DB.prepare(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`
    ).bind(userId, tenantId, now),
  ]);

  logger.info('Usuario registrado', { userId, tenantId });
  return { userId, tenantId };
}

/** Slug legible y único a partir del nombre del despacho. */
export async function uniqueSlug(env: Env, name: string): Promise<string> {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'despacho';

  for (let intento = 0; intento < 25; intento += 1) {
    const candidato = intento === 0 ? base : `${base}-${intento + 1}`;
    const existe = await env.DB.prepare('SELECT 1 FROM tenants WHERE slug = ? LIMIT 1')
      .bind(candidato)
      .first<unknown>();
    if (!existe) return candidato;
  }
  return `${base}-${randomToken().slice(0, 8)}`;
}

/* ── Gestión de Miembros e Invitaciones Self-Serve por Tenant ────────────── */

export interface TenantMemberRow {
  userId: string;
  email: string;
  fullName: string;
  role: MembershipRole;
  active: boolean;
  createdAt: number;
}

/** Lista los miembros de un despacho con su estado de activación. */
export async function listTenantMembers(env: Env, tenantId: string): Promise<TenantMemberRow[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT m.user_id AS userId,
              u.email AS email,
              COALESCE(u.full_name, '') AS fullName,
              m.role AS role,
              CASE WHEN u.password_hash IS NOT NULL AND u.email_verified_at IS NOT NULL THEN 1 ELSE 0 END AS active,
              m.created_at AS createdAt
       FROM tenant_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ?
       ORDER BY m.created_at ASC`
    )
      .bind(tenantId)
      .all<{
        userId: string;
        email: string;
        fullName: string;
        role: MembershipRole;
        active: number;
        createdAt: number;
      }>();

    return (res.results ?? []).map((r) => ({
      userId: r.userId,
      email: r.email,
      fullName: r.fullName,
      role: r.role,
      active: Boolean(r.active),
      createdAt: Number(r.createdAt ?? 0),
    }));
  } catch (error) {
    if (esErrorDeTablaFaltante(error, ['tenant_memberships', 'users'])) return [];
    throw error;
  }
}

/**
 * Invita o actualiza un miembro en el despacho (`owner`, `admin` o `member`).
 * Si el usuario no existe aún, lo crea en `users` y emite un token de activación
 * (`reset_password`, 7 días) para que elija su contraseña inicial.
 */
export async function inviteTenantMember(
  env: Env,
  input: {
    tenantId: string;
    email: string;
    fullName: string;
    role: MembershipRole;
  }
): Promise<{
  userId: string;
  email: string;
  fullName: string;
  role: MembershipRole;
  isNewUser: boolean;
  activationToken: string;
}> {
  const email = normalizaEmail(input.email);
  const fullName = input.fullName.trim() || email.split('@')[0] || 'Operador';
  const now = Math.floor(Date.now() / 1000);

  const existing = await getUserByEmail(env, email);
  let userId: string;
  let isNewUser = false;

  if (!existing) {
    userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
    isNewUser = true;
    await env.DB.prepare(
      `INSERT INTO users (id, email, full_name, password_hash, email_verified_at, platform_role, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'user', ?)`
    )
      .bind(userId, email, fullName, now)
      .run();
  } else {
    userId = existing.id;
    if (input.fullName.trim() && !existing.fullName) {
      await env.DB.prepare('UPDATE users SET full_name = ? WHERE id = ?')
        .bind(fullName, userId)
        .run();
    }
  }

  await env.DB.prepare(
    `INSERT INTO tenant_memberships (user_id, tenant_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`
  )
    .bind(userId, input.tenantId, input.role, now)
    .run();

  const activationToken = await issueActionToken(env, userId, 'reset_password', INVITE_TTL_SECONDS);

  return {
    userId,
    email,
    fullName: existing?.fullName || fullName,
    role: input.role,
    isNewUser,
    activationToken,
  };
}

/**
 * Revoca la membresía de un usuario en el despacho.
 * Impide eliminar al último `owner` del despacho para no dejarlo huérfano.
 */
export async function removeTenantMember(
  env: Env,
  tenantId: string,
  userId: string
): Promise<{ ok: boolean; error?: string }> {
  const members = await listTenantMembers(env, tenantId);
  const target = members.find((m) => m.userId === userId);
  if (!target) {
    return { ok: false, error: 'El usuario no es miembro de este despacho.' };
  }

  if (target.role === 'owner') {
    const owners = members.filter((m) => m.role === 'owner');
    if (owners.length <= 1) {
      return {
        ok: false,
        error: 'No puedes revocar al único propietario (owner) del despacho.',
      };
    }
  }

  await env.DB.prepare('DELETE FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?')
    .bind(tenantId, userId)
    .run();

  return { ok: true };
}
