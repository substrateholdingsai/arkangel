-- Arkangel · Ejecución de Campañas y Registro de Consumo (Bolsa de Créditos)
-- Migración 0019 (D1 · SQLite)
--
-- Tablas para seguimiento de campañas (CAMPAIGN_DISPATCH_V1) y consumo
-- de minutos / mensajes para la facturación a la cámara y atribución a sus socios.

PRAGMA foreign_keys = ON;

-- ── Campañas de comunicación general ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comm_campaigns (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,            -- socio o cámara emisora
  org_tenant_id       TEXT NOT NULL,            -- organización dueña de la bolsa
  canal               TEXT NOT NULL CHECK (canal IN ('whatsapp', 'sms', 'email', 'voz')),
  proposito           TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'running', 'paused', 'completed', 'failed')),
  total_recipients    INTEGER NOT NULL DEFAULT 0,
  sent_count          INTEGER NOT NULL DEFAULT 0,
  delivered_count     INTEGER NOT NULL DEFAULT 0,
  read_count          INTEGER NOT NULL DEFAULT 0,
  replied_count       INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  excluded_count      INTEGER NOT NULL DEFAULT 0,
  cost_cents          INTEGER NOT NULL DEFAULT 0,
  scheduled_for       TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comm_campaigns_tenant ON comm_campaigns(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_comm_campaigns_org ON comm_campaigns(org_tenant_id, created_at);

-- ── Eventos de consumo (Minutos y Mensajes) ───────────────────────────────────
-- Base del modelo de negocio de consumo. Cada mensaje enviado o minuto de voz
-- consumido genera una fila atribuida al socio y a la cámara.
CREATE TABLE IF NOT EXISTS usage_events (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,            -- socio emisor
  parent_tenant_id    TEXT NOT NULL,            -- cámara que provee la bolsa
  campaign_id         TEXT,
  channel             TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'voz')),
  unit                TEXT NOT NULL CHECK (unit IN ('message', 'minute')),
  qty                 INTEGER NOT NULL DEFAULT 1,
  unit_cost_cents     INTEGER NOT NULL,
  total_cost_cents    INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant ON usage_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_parent ON usage_events(parent_tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_campaign ON usage_events(campaign_id);
