-- Arkangel · multi-tenant — tenants, canales por cliente y mapa contable por cliente
-- Migración 0004 (D1 · SQLite)
--
-- Por qué esta migración:
--   · Hoy TODA la configuración legal y operativa vive en variables de entorno del
--     Worker. Con dos empresas de cobranza, ambas se presentarían ante el deudor
--     con la misma razón social y el mismo registro CONDUSEF (regla 1.1), y la
--     cadena de hashes del ledger tampoco podría separarse por cliente.
--   · `tenants` es la fuente de verdad de esa configuración. Cada fila es una
--     empresa de cobranza con su identidad, su ventana de contacto y sus límites.
--
-- Reglas de esta migración:
--   · D1 NO activa las claves foráneas por defecto: el PRAGMA va explícito.
--   · La tabla `tenants` NO lleva todavía `tenant_id` en las tablas de negocio:
--     eso es la Fase 4 (propagar `ctx`). Aquí sólo se crea el catálogo de tenants
--     y su configuración, sin tocar los datos operativos existentes.
--   · El tenant que ya operaba se migra con `config_mode = 'platform_env'`: sigue
--     leyendo la configuración del entorno, así que el comportamiento NO cambia ni
--     un byte. Cuando su fila esté completa, se cambia a 'db' (ver docs).

PRAGMA foreign_keys = ON;

-- ── Catálogo de tenants ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'onboarding')),
  -- 'db'          → la fila es la fuente de verdad (modo normal, fail-closed).
  -- 'platform_env'→ la configuración se lee del entorno del Worker. Es el puente
  --                 de transición del tenant que ya existía; los tenants nuevos
  --                 NUNCA deben usar este modo (heredarían la identidad de la
  --                 plataforma, que es exactamente el bug que motiva el multi-tenant).
  config_mode   TEXT NOT NULL DEFAULT 'db'
                CHECK (config_mode IN ('db', 'platform_env')),

  -- Identidad legal (regla 1.1 · CONDUSEF)
  razon_social          TEXT NOT NULL DEFAULT '',
  condusef_registro     TEXT NOT NULL DEFAULT '',
  -- Lista separada por comas. Vacío = ningún link permitido (fail-closed).
  allowed_payment_domains TEXT NOT NULL DEFAULT '',

  -- Ventana y límites legales
  tz                        TEXT NOT NULL DEFAULT 'America/Mexico_City',
  send_window_start         INTEGER NOT NULL DEFAULT 8,
  send_window_end           INTEGER NOT NULL DEFAULT 22,
  max_contacts_per_day      INTEGER NOT NULL DEFAULT 3,
  legal_monto_tolerancia_cents INTEGER NOT NULL DEFAULT 0,
  legal_horario_en_respuestas  INTEGER NOT NULL DEFAULT 0
                                CHECK (legal_horario_en_respuestas IN (0, 1)),

  -- Config operativa
  rate_limit_rpm               INTEGER NOT NULL DEFAULT 42,
  dedupe_window_hours          INTEGER NOT NULL DEFAULT 24,
  score_amount_ceiling_cents   INTEGER NOT NULL DEFAULT 200000,
  agent_mode                   TEXT NOT NULL DEFAULT 'supervised',
  agent_auto_threshold_cents   INTEGER NOT NULL DEFAULT 200000,
  dry_run                      INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  cron_auto_fire               INTEGER NOT NULL DEFAULT 0 CHECK (cron_auto_fire IN (0, 1)),

  -- 1 = tenant por defecto de la plataforma (el que se usa si no se resuelve otro).
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Como mucho un tenant por defecto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_default
  ON tenants(is_default) WHERE is_default = 1;

-- Búsqueda por slug para el routing del panel y de los webhooks.
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- ── Canales por tenant ────────────────────────────────────────────────────────
-- `provider_account_id` es el identificador que el proveedor manda en el webhook:
--   whatsapp → phone_number_id (Meta)
--   sms      → messaging_profile_id (Telnyx)
--   email    → dominio receptor (Resend)
-- Es lo que permite resolver de qué tenant es un mensaje entrante.
-- `credentials` es un JSON opcional con credenciales propias del tenant; si no
-- hay, se usan las de la plataforma.
CREATE TABLE IF NOT EXISTS tenant_channels (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  provider_account_id TEXT,
  credentials         TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_channels_routing
  ON tenant_channels(channel, provider_account_id) WHERE provider_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_channels_tenant
  ON tenant_channels(tenant_id, channel);

-- ── Mapa contable por tenant ──────────────────────────────────────────────────
-- El mapa global `legal_accounting_map` asume un solo catálogo de cuentas. Con
-- varios clientes, cada uno tiene su propio plan de cuentas en Alegra, así que
-- el mapa pasa a ser por tenant.
CREATE TABLE IF NOT EXISTS tenant_accounting_map (
  tenant_id      TEXT NOT NULL,
  regla_id       TEXT NOT NULL,
  cuenta_debito  TEXT NOT NULL,
  cuenta_credito TEXT NOT NULL,
  tipo_asiento   TEXT NOT NULL,   -- provision | gasto | contingencia
  descripcion    TEXT,
  PRIMARY KEY (tenant_id, regla_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── Backfill: el tenant que ya operaba ───────────────────────────────────────
-- Los valores son los de `wrangler.jsonc`. `config_mode='platform_env'` hace que
-- la configuración efectivo siga viniendo del entorno: comportamiento idéntico.
INSERT OR IGNORE INTO tenants (
  id, slug, nombre, status, config_mode,
  razon_social, condusef_registro, allowed_payment_domains,
  tz, send_window_start, send_window_end, max_contacts_per_day,
  legal_monto_tolerancia_cents, legal_horario_en_respuestas,
  rate_limit_rpm, dedupe_window_hours,
  score_amount_ceiling_cents, agent_mode, agent_auto_threshold_cents,
  dry_run, cron_auto_fire, is_default
) VALUES (
  't_arkangel', 'arkangel', 'Arkangel', 'active', 'platform_env',
  '', '', '',
  'America/Mexico_City', 8, 22, 3,
  0, 0,
  42, 24,
  200000, 'supervised', 200000,
  0, 0, 1
);

-- El mapa contable del tenant hereda el catálogo global como punto de partida.
INSERT OR IGNORE INTO tenant_accounting_map (
  tenant_id, regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion
)
SELECT
  't_arkangel', regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion
FROM legal_accounting_map;
