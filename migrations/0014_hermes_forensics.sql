-- Arkangel · Agente Forense Autónomo Hermes en Cloudflare Sandboxes
-- Migración 0014 (D1 · SQLite)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hermes_forensic_jobs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  case_id             TEXT REFERENCES cases(id),
  client_id           TEXT REFERENCES clients(id),
  task_type           TEXT NOT NULL, -- 'skip_trace' | 'sat_materiality' | 'judicial_synthesis'
  status              TEXT NOT NULL DEFAULT 'processing', -- 'pending' | 'processing' | 'completed' | 'failed'
  result_summary      TEXT,
  result_payload      TEXT, -- JSON con dictamen forense detallado
  worm_entry_hash     TEXT, -- Hash inmutable en worm_audit_log
  r2_snapshot_path    TEXT, -- Ruta en HERMES_MEMORY_BUCKET
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hermes_tenant_case ON hermes_forensic_jobs(tenant_id, case_id);
CREATE INDEX IF NOT EXISTS idx_hermes_tenant_client ON hermes_forensic_jobs(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_hermes_status ON hermes_forensic_jobs(tenant_id, status);
