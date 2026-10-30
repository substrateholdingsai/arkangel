-- Arkangel · Motor de Comunicación (marketing, eventos, avisos, transaccional)
-- Migración 0018 (D1 · SQLite)
--
-- Tablas propias del dominio de comunicación general. NO se reutiliza
-- `clients.*_opt_in`: ese consentimiento es de la relación de cobranza, no
-- autoriza publicidad. Aquí el consentimiento es por marca, canal y propósito,
-- con fecha y origen verificables (LFPDPPP · LFPC · política de Meta).

PRAGMA foreign_keys = ON;

-- ── Consentimiento ─────────────────────────────────────────────────────────────
-- Una fila por (marca, teléfono/email, canal, categoría). Sin fila vigente → no
-- se envía (fail-closed). `revoked_at` no NULL → revocado.
--   categoria: marketing    → promociones, eventos, cumpleaños, campañas.
--              avisos       → avisos institucionales de la organización.
--              transaccional→ confirmaciones derivadas de una operación.
CREATE TABLE IF NOT EXISTS comm_consents (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  contacto       TEXT NOT NULL,           -- E.164 o email en minúsculas
  channel        TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'voz')),
  categoria      TEXT NOT NULL CHECK (categoria IN ('marketing', 'avisos', 'transaccional')),
  opt_in_at      TEXT NOT NULL,
  opt_in_source  TEXT NOT NULL,           -- formulario_web, whatsapp_keyword, papel_firmado, crm_import...
  evidence       TEXT,                    -- JSON: IP, user-agent, id de formulario, URL del documento...
  revoked_at     TEXT,
  revoked_source TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_consents_key
  ON comm_consents(tenant_id, contacto, channel, categoria);
CREATE INDEX IF NOT EXISTS idx_comm_consents_contacto ON comm_consents(contacto);

-- ── Supresiones ────────────────────────────────────────────────────────────────
-- Lista negra por marca. Gana siempre sobre el consentimiento.
CREATE TABLE IF NOT EXISTS comm_suppressions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  contacto    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('opt_out', 'bounce', 'blocked', 'manual')),
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_suppressions_key
  ON comm_suppressions(tenant_id, contacto, reason);

-- ── Plantillas curadas ─────────────────────────────────────────────────────────
-- El operador ELIGE plantilla; no escribe texto. Sólo `status = 'APPROVED'`
-- puede salir. `shared = 1` → la organización la ofrece a sus socios.
-- `variables_json`: arreglo ordenado de nombres de variable; el orden es el de
-- los parámetros posicionales {{1}}, {{2}}... de la plantilla en Meta.
-- `body_preview` usa variables con nombre: "Hola {{nombre}}, {{marca}} te invita...".
CREATE TABLE IF NOT EXISTS comm_templates (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'voz')),
  nombre          TEXT NOT NULL,
  meta_name       TEXT,                   -- nombre de la plantilla HSM en Meta (WhatsApp)
  lang            TEXT NOT NULL DEFAULT 'es_MX',
  categoria       TEXT NOT NULL CHECK (categoria IN ('marketing', 'avisos', 'transaccional')),
  meta_category   TEXT CHECK (meta_category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
  subject         TEXT,                   -- email
  body_preview    TEXT NOT NULL,
  variables_json  TEXT NOT NULL DEFAULT '[]',
  shared          INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  last_synced_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comm_templates_tenant ON comm_templates(tenant_id, channel, status);

-- ── REPEP (PROFECO) ────────────────────────────────────────────────────────────
-- Se guarda el hash SHA-256 del E.164, nunca el número en claro.
-- `comm_repep_versions` registra cada ingesta: el motor exige una versión
-- vigente (fail-closed) para enviar publicidad a teléfonos.
CREATE TABLE IF NOT EXISTS comm_repep_versions (
  id           TEXT PRIMARY KEY,
  list_date    TEXT NOT NULL,             -- fecha de corte de la lista de PROFECO
  loaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  total        INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('loading', 'active', 'superseded'))
);
CREATE TABLE IF NOT EXISTS comm_repep_numbers (
  phone_hash   TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  PRIMARY KEY (phone_hash, version_id)
);
CREATE INDEX IF NOT EXISTS idx_comm_repep_version ON comm_repep_numbers(version_id);

-- ── Bitácora de envíos ─────────────────────────────────────────────────────────
-- Un registro por intento (enviado, diferido o excluido con motivo). Es la base
-- del reporte post-campaña y de la atribución de bajas a una marca.
CREATE TABLE IF NOT EXISTS comm_envios (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,            -- marca emisora
  org_tenant_id TEXT NOT NULL,            -- organización dueña del canal y la bolsa
  campaign_id   TEXT,
  contacto      TEXT NOT NULL,
  channel       TEXT NOT NULL,
  template_id   TEXT,
  categoria     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN (
                  'queued', 'deferred', 'excluded', 'sent', 'delivered', 'read',
                  'replied', 'failed')),
  motivo        TEXT,                     -- código de exclusión o error
  provider_id   TEXT,
  scheduled_for TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comm_envios_campaign ON comm_envios(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_comm_envios_contacto ON comm_envios(org_tenant_id, contacto, created_at);
CREATE INDEX IF NOT EXISTS idx_comm_envios_provider ON comm_envios(provider_id);
