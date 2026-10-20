-- Arkangel · módulo contable — integración Alegra (MCP)
-- Migración 0003 (D1 · SQLite)
--
-- Reglas de esta migración:
--   · `legal_audit` y `events` son append-only: aquí no se toca ninguna de las dos.
--   · Las cuentas contables NO se hardcodean en el Worker: viven en `legal_accounting_map`.
--   · La traza es legal_audit.id → alegra_sync.alegra_journal_id → asiento en Alegra.
--
-- D1 NO activa las claves foráneas por defecto: el PRAGMA debe declarar en cada
-- migración que use FKs (si no, la FK queda decorativa y no se valida).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS alegra_sync (
  id              TEXT PRIMARY KEY,
  fecha_corte     TEXT NOT NULL,              -- YYYY-MM-DD
  idempotency_key TEXT UNIQUE NOT NULL,       -- SHA256 con salt del payload
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | reconciled
  payload_r2_key  TEXT NOT NULL,              -- ruta en R2 del JSON normalizado
  alegra_journal_id TEXT,                     -- ID del asiento en Alegra
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alegra_sync_fecha ON alegra_sync(fecha_corte);
CREATE INDEX IF NOT EXISTS idx_alegra_sync_status ON alegra_sync(status);

-- Mapa regla legal → cuentas contables de Alegra.
CREATE TABLE IF NOT EXISTS legal_accounting_map (
  regla_id      TEXT PRIMARY KEY,
  cuenta_debito TEXT NOT NULL,
  cuenta_credito TEXT NOT NULL,
  tipo_asiento  TEXT NOT NULL,   -- provision | gasto | contingencia
  descripcion   TEXT
);

-- Seed inicial: una cuenta por regla del catálogo legal ejecutable.
INSERT OR IGNORE INTO legal_accounting_map (regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion) VALUES
  ('1.1', '5101-001', '1102-003', 'provision', 'Provisión por usurpación de identidad corporativa'),
  ('1.2', '5101-001', '1102-003', 'provision', 'Provisión por representación sin poder legal'),
  ('2.1', '5101-001', '1102-003', 'provision', 'Provisión por amenaza de cobranza fuera de proceso'),
  ('2.3', '5101-001', '1102-003', 'provision', 'Provisión por hostigamiento continuo'),
  ('2.4', '6101-001', '1102-003', 'gasto', 'Gasto por contacto en horario prohibido (NOM-184)'),
  ('3.1', '5101-002', '1102-003', 'contingencia', 'Contingencia por smishing y suplantación de la entidad'),
  ('3.2', '5101-002', '1102-003', 'contingencia', 'Contingencia por destino de pago no trazable'),
  ('4.2', '5101-001', '1102-003', 'provision', 'Provisión por interés sobre interés no pactado'),
  ('4.4', '5101-002', '1102-003', 'contingencia', 'Contingencia por extorsión vía contactos'),
  ('5.2', '5101-003', '1102-003', 'contingencia', 'Contingencia por simulación de orden judicial'),
  ('8.1', '5101-003', '1102-003', 'contingencia', 'Contingencia por monto contrato vs CRM'),
  ('8.7', '5101-003', '1102-003', 'contingencia', 'Contingencia por falsedad de registros CRM');

-- Checkpoint del ledger append-only: guarda la cabeza de la cadena de hashes por día
-- para detectar cualquier alteración posterior de `legal_audit`.
-- `total_registros` es la posición acumulada en la cadena al cierre de ese día.
CREATE TABLE IF NOT EXISTS ledger_checkpoint (
  fecha_corte     TEXT PRIMARY KEY,
  hash_cadena     TEXT NOT NULL,
  total_registros INTEGER NOT NULL,
  verificado      INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Trazabilidad asiento por asiento: legal_audit.id → asiento en Alegra.
-- Evita duplicar asientos cuando un reintento falla a medio camino.
-- La línea se escribe ANTES de actualizar `alegra_sync`: si ese UPDATE falla,
-- la reconciliación encuentra la línea y no vuelve a asentar.
CREATE TABLE IF NOT EXISTS alegra_journal_lines (
  alegra_sync_id  TEXT NOT NULL,
  linea_numero    INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  legal_audit_id  TEXT NOT NULL,
  alegra_journal_id TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (idempotency_key, legal_audit_id),
  FOREIGN KEY (alegra_sync_id) REFERENCES alegra_sync(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alegra_journal_lines_unique
  ON alegra_journal_lines(alegra_sync_id, linea_numero);

CREATE INDEX IF NOT EXISTS idx_alegra_journal_lines_journal ON alegra_journal_lines(alegra_journal_id);

-- CFDI timbrado (opcional). La mayoría de los asientos serán "Provisión sin CFDI"
-- porque el bloqueo de compliance evitó la emisión; cuando existe, se enlaza.
CREATE TABLE IF NOT EXISTS contract_cfdi (
  id          TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  cfdi_uuid   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_contract_cfdi_contract ON contract_cfdi(contract_id);
