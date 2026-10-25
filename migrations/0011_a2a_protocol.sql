-- Arkangel · Protocolo A2A (Agent-to-Agent Collections & Programmatic Negotiation)
-- Migración 0011 (D1 · SQLite)

PRAGMA foreign_keys = ON;

-- 1. Campos de autenticación y verificación de cliente para A2A
ALTER TABLE clients ADD COLUMN rfc TEXT;
ALTER TABLE clients ADD COLUMN auth_pin TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_tenant_rfc ON clients(tenant_id, rfc);

-- 2. Políticas A2A por Despacho (Tenant)
ALTER TABLE tenants ADD COLUMN a2a_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN a2a_max_discount_pct INTEGER NOT NULL DEFAULT 30;
ALTER TABLE tenants ADD COLUMN a2a_max_installments INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tenants ADD COLUMN a2a_min_down_payment_pct INTEGER NOT NULL DEFAULT 40;

-- 3. Tabla de convenios A2A acordados entre máquinas
CREATE TABLE IF NOT EXISTS a2a_agreements (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  case_id                 TEXT NOT NULL REFERENCES cases(id),
  client_id               TEXT NOT NULL REFERENCES clients(id),
  original_amount_cents   INTEGER NOT NULL,
  agreed_amount_cents     INTEGER NOT NULL,
  discount_pct            REAL NOT NULL,
  installments            INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'pending',
  clabe                   TEXT,
  expires_at              TEXT NOT NULL,
  agent_id                TEXT,
  one_click_url           TEXT,
  metadata                TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_a2a_agreements_tenant_case ON a2a_agreements(tenant_id, case_id);
CREATE INDEX IF NOT EXISTS idx_a2a_agreements_status ON a2a_agreements(status, expires_at);
