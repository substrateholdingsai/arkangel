-- Arkangel · Constancias de Notificación Digital NOM-151-SCFI-2016
-- Migración 0012 (D1 · SQLite)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nom151_certificates (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  case_id                 TEXT REFERENCES cases(id),
  client_id               TEXT NOT NULL REFERENCES clients(id),
  message_id              TEXT REFERENCES messages(id),
  certificate_folio       TEXT NOT NULL UNIQUE,
  tipo_notificacion       TEXT NOT NULL, -- 'requerimiento_pago' | 'carta_convenio' | 'carta_finiquito' | 'aviso_cobranza'
  channel                 TEXT NOT NULL, -- 'whatsapp' | 'sms' | 'email' | 'portal'
  provider_id             TEXT,
  recipient_masked        TEXT NOT NULL,
  message_content         TEXT NOT NULL,
  message_digest_sha256   TEXT NOT NULL,
  cadena_original         TEXT NOT NULL,
  sello_digital           TEXT NOT NULL,
  timestamp_utc           TEXT NOT NULL,
  timestamp_local         TEXT NOT NULL,
  verification_url        TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'issued', -- 'issued' | 'delivered' | 'verified'
  metadata                TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nom151_tenant_case ON nom151_certificates(tenant_id, case_id);
CREATE INDEX IF NOT EXISTS idx_nom151_folio ON nom151_certificates(certificate_folio);
CREATE INDEX IF NOT EXISTS idx_nom151_digest ON nom151_certificates(message_digest_sha256);
