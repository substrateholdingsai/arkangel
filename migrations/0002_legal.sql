-- Arkangel · capa de cumplimiento legal
-- Migración 0002 (D1 · SQLite)

CREATE TABLE IF NOT EXISTS contracts (
  id                  TEXT PRIMARY KEY,
  client_id           TEXT NOT NULL,
  monto_pactado_cents INTEGER NOT NULL,
  tasa_pct            REAL,
  clabe               TEXT,
  nombre_legal        TEXT,
  condusef            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_id);

CREATE TABLE IF NOT EXISTS legal_audit (
  id         TEXT PRIMARY KEY,
  regla_id   TEXT NOT NULL,
  seccion    TEXT,
  conducta   TEXT,
  ley        TEXT,
  articulo   TEXT,
  castigo    TEXT,
  accion     TEXT NOT NULL,
  detalle    TEXT,
  evidencia  TEXT,
  case_id    TEXT,
  client_id  TEXT,
  canal      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legal_audit_created ON legal_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_legal_audit_regla ON legal_audit(regla_id);
CREATE INDEX IF NOT EXISTS idx_legal_audit_client ON legal_audit(client_id);
