-- Arkangel · autenticación nativa en D1 (fin de Clerk)
-- Migración 0007 (D1 · SQLite)
--
-- Por qué esta migración:
--   · Clerk era el proveedor de identidad: la sesión del panel llegaba como
--     cookie y de ella salían el userId y la Organization. Eso obligaba a
--     depender de un SaaS externo (y de su plan) para abrir el panel.
--   · Ahora la identidad es 100% nativa: la contraseña se hashea con PBKDF2 en
--     el Worker, la sesión es un token aleatorio que D1 guarda **hasheado** y
--     el navegador sólo lleva la cookie `ark_session`.
--   · El esquema replica el de Ark Ledger (`users`, `tenant_memberships`,
--     `auth_sessions`, `auth_tokens`, `auth_rate_limits`) para que el mismo
--     `scripts/seed-owner.ts` sirva a los dos proyectos.
--
-- Reglas de esta migración:
--   · D1 NO activa las claves foráneas por defecto: el PRAGMA va explícito.
--   · Los tokens NUNCA se guardan en claro: en D1 va el SHA-256; el texto
--     plano sólo existe en la cookie del navegador (HttpOnly).
--   · `tenant_memberships.tenant_id` referencia a `tenants(id)`: la membresía
--     es la que autoriza a operar sobre un tenant. Un `X-Tenant-Id` confiado
--     desde el navegador no amplía nada (ver `requireTenantMembership`).
--   · `users.platform_role = 'super_admin'` es el alcance transversal: el
--     sustituto de la tabla `platform_users` de la era Clerk.
--   · `email_verified_at` se marca al registrarse: el panel es de invitación
--     (el alta real la hace `scripts/seed-owner.ts`), no de auto-registro
--     público, así que el correo no es una barrera. La tabla `auth_tokens`
--     queda disponible para el flujo de restablecimiento de contraseña.

PRAGMA foreign_keys = ON;

-- ── Usuarios ───────────────────────────────────────────────────────────────────
-- `password_hash` usa el formato `pbkdf2_sha256$25000$salt$hash` (PBKDF2 con
-- SHA-256, 25 000 iteraciones y sal de 16 bytes).
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  full_name         TEXT,
  password_hash     TEXT,
  email_verified_at INTEGER,
  platform_role     TEXT NOT NULL DEFAULT 'user'
                    CHECK (platform_role IN ('user', 'super_admin')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Unicidad sin distinguir mayúsculas: `A@x.com` y `a@x.com` son la misma
-- cuenta, y el login normaliza a minúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
  ON users(lower(email));

-- ── Membresías multi-tenant ───────────────────────────────────────────────────
-- El rol de Ark Ledger se traduce al de Arkangel en `src/auth/native.ts`
-- (`ROLE_POR_MEMBRESIA`): owner → owner, admin → operator, member → viewer.
CREATE TABLE IF NOT EXISTS tenant_memberships (
  user_id    TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant
  ON tenant_memberships(tenant_id, role);

-- ── Sesiones ───────────────────────────────────────────────────────────────────
-- `token_hash` es el SHA-256 del token en texto plano: si alguien lee D1 no
-- puede suplantar a nadie.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON auth_sessions(user_id, expires_at);

-- ── Tokens de verificación / restablecimiento ──────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at    INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose
  ON auth_tokens(user_id, purpose, expires_at);

-- ── Rate limiting ──────────────────────────────────────────────────────────────
-- Ventana deslizante por cubo: login (10/15 min por correo, 50/15 min por IP) y
-- registro (5/hora por correo).
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key       TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1
);
