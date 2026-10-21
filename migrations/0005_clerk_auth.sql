-- Arkangel · integración con Clerk como provider de identidad
-- Migración 0005 (D1 · SQLite)
--
-- Por qué esta migración:
--   · Clerk es el proveedor de autenticación (SSO, organizations, sesiones JWT).
--     La identidad humana ya no llega por API key: llega por cookie de sessión.
--   · Una Organization de Clerk = un tenant. El mapeo es `tenants.clerk_org_id`
--     ↔ `Organization.id` de Clerk, así que el worker puede resolver de qué
--     tenant es una petición sin confiar en un header del cliente.
--   · El *rol* del usuario dentro del tenant NO lo da Clerk (Clerk only knows
--     orgRole, que es 'admin'/'member'). La matriz de scopes de Arkangel
--     (owner, compliance, operator, viewer) la concede D1: la tabla
--     `tenant_users` es la fuente de verdad. Estar en la Organization no basta.
--   · Los administradores de plataforma son transversales: pueden actuar sobre
--     cualquier tenant. Van en `platform_users`, sin tenant.
--
-- Reglas de esta migración:
--   · D1 NO activa las claves foráneas por defecto: el PRAGMA va explícito.
--   · `clerk_org_id` es NULLABLE: el tenant heredado de la plataforma (el de
--     siempre, `t_arkangel`) no tiene Organization de Clerk todavía. Nulos no
--     rompen el índice parcial (WHERE clerk_org_id IS NOT NULL).
--   · Los CHECK de `tenant_users.role` están acotados a los roles de humano:
--     owner, compliance, operator, viewer. Los roles de servicio
--     (service_ingest, service_agent, service_readonly) no entran aquí porque
--     son para API keys, no para usuarios de Clerk.

PRAGMA foreign_keys = ON;

-- ── Vínculo tenant ↔ Organization de Clerk ────────────────────────────────────
-- Una Organization de Clerk = un tenant de Arkangel. El índice parcial
-- garantiza que no haya dos tenants apuntando al mismo clerk_org_id, y que los
-- nulos (tenant sin organization) no choquen.
ALTER TABLE tenants ADD COLUMN clerk_org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_clerk_org
  ON tenants(clerk_org_id) WHERE clerk_org_id IS NOT NULL;

-- ── Roles de humano por tenant ────────────────────────────────────────────────
-- La matriz de scopes del código decide qué puede hacer cada rol. Clerk
-- aporta la identidad (userId, orgId, orgRole); esta tabla aporta el rol de
-- Arkangel. Un usuario que esté en la Organization pero sin fila aquí no tiene
-- rol → la petición se cae a `null` (no hay sesión válida para el tenant).
CREATE TABLE IF NOT EXISTS tenant_users (
  user_id    TEXT NOT NULL,          -- user_xxx de Clerk
  tenant_id  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','compliance','operator','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── Administradores de plataforma ─────────────────────────────────────────────
-- Alcance transversal sobre todos los tenants: pueden actuar sobre cualquier
-- tenant sin necesidad de ser miembro de su Organization. Su rol es
-- `platform_admin` (todos los scopes) y su `tenantId` es null en el Principal.
CREATE TABLE IF NOT EXISTS platform_users (
  user_id    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);