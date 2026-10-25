-- Arkangel · Conector ATEB Servicios PSC y Capa de Custodia WORM
-- Migración 0013 (D1 · SQLite)

PRAGMA foreign_keys = ON;

-- 1. Tabla de configuración de credenciales del Prestador de Servicios de Certificación (PSC) por Tenant
CREATE TABLE IF NOT EXISTS tenant_psc_settings (
  tenant_id               TEXT PRIMARY KEY REFERENCES tenants(id),
  ateb_enabled            INTEGER NOT NULL DEFAULT 0,
  ateb_environment        TEXT NOT NULL DEFAULT 'sandbox', -- 'sandbox' | 'production'
  ateb_client_id          TEXT,
  ateb_api_key            TEXT,
  ateb_tsa_enabled        INTEGER NOT NULL DEFAULT 1,
  auto_stamp_outbound     INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Capa Transversal de Custodia y Auditoría Inmutable (WORM 10 años conforme a Art. 49 Código de Comercio)
CREATE TABLE IF NOT EXISTS worm_audit_log (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  case_id                 TEXT REFERENCES cases(id),
  record_type             TEXT NOT NULL, -- 'nom151_certificate' | 'telnyx_call' | 'debtor_agreement' | 'judicial_docket_export'
  record_id               TEXT NOT NULL,
  action                  TEXT NOT NULL, -- 'created' | 'verified' | 'exported' | 'tamper_check'
  actor                   TEXT NOT NULL, -- 'operator' | 'system' | 'telnyx_webhook' | 'public_verifier'
  prev_hash               TEXT NOT NULL, -- Encadenamiento SHA-256 (trazabilidad WORM)
  record_hash             TEXT NOT NULL,
  entry_hash              TEXT NOT NULL,
  timestamp_utc           TEXT NOT NULL,
  metadata                TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_worm_tenant_case ON worm_audit_log(tenant_id, case_id);
CREATE INDEX IF NOT EXISTS idx_worm_record ON worm_audit_log(tenant_id, record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_worm_entry_hash ON worm_audit_log(entry_hash);

-- 3. Ampliación de nom151_certificates para registrar proveedor PSC, nivel de cumplimiento y custodia WORM
ALTER TABLE nom151_certificates ADD COLUMN psc_provider TEXT NOT NULL DEFAULT 'arkangel_internal';
ALTER TABLE nom151_certificates ADD COLUMN psc_compliance_level TEXT NOT NULL DEFAULT 'modo_b_presuntivo';
ALTER TABLE nom151_certificates ADD COLUMN psc_constancia_id TEXT;
ALTER TABLE nom151_certificates ADD COLUMN psc_timestamp_token TEXT;
ALTER TABLE nom151_certificates ADD COLUMN psc_response_payload TEXT;
ALTER TABLE nom151_certificates ADD COLUMN custody_worm_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_nom151_compliance ON nom151_certificates(tenant_id, psc_compliance_level);
