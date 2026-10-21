-- Arkangel · baja de la integración con Clerk
-- Migración 0008 (D1 · SQLite)
--
-- Por qué esta migración:
--   · La identidad ya no la da Clerk: la da la autenticación nativa de la
--     migración 0007 (`users`, `tenant_memberships`, `auth_sessions`). Lo que
--     dejó Clerk en D1 son tres cosas que ya no sirven para nada:
--       · `tenants.clerk_org_id` — el vínculo tenant ↔ Organization de Clerk.
--       · `tenant_users`         — los roles por tenant, ya están en
--                                  `tenant_memberships`.
--       · `platform_users`        — los admins de plataforma, ahora son los
--                                  `users` con `platform_role = 'super_admin'`.
--   · Se borran, no se archivan: una columna de Clerk que no usa nadie es una
--     puerta que alguien puede abrir por error.
--
-- Reglas de esta migración:
--   · El índice se cae ANTES de la columna: SQLite no permite eliminar una
--     columna que un índice referencie.
--   · `tenants` conserva su resto de columnas: el catálogo de tenants no
--     cambió, sólo desapareció el vínculo con el proveedor externo.
--   · Las claves foráneas que apuntaban a `tenant_users` no existen (nadie la
--     referenciaba), así que la orden es: tablas, índice, columna.

PRAGMA foreign_keys = ON;

-- ── Tablas de la era Clerk ─────────────────────────────────────────────────────
DROP TABLE IF EXISTS tenant_users;
DROP TABLE IF EXISTS platform_users;

-- ── Vínculo tenant ↔ Organization de Clerk ────────────────────────────────────
DROP INDEX IF EXISTS idx_tenants_clerk_org;
ALTER TABLE tenants DROP COLUMN clerk_org_id;
