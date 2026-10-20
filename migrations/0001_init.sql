-- Arkangel · esquema inicial de cobranza asistida por IA
-- Migración 0001 (D1 · SQLite)

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  curp            TEXT,
  whatsapp_opt_in INTEGER,
  sms_opt_in      INTEGER,
  email_opt_in    INTEGER,
  do_not_disturb  INTEGER NOT NULL DEFAULT 0,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_curp ON clients(curp) WHERE curp IS NOT NULL;

CREATE TABLE IF NOT EXISTS debts (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'MXN',
  due_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  description  TEXT,
  source       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_debts_client_status ON debts(client_id, status);
CREATE INDEX IF NOT EXISTS idx_debts_due ON debts(status, due_date);

CREATE TABLE IF NOT EXISTS cases (
  id            TEXT PRIMARY KEY,
  case_date     TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  debt_id       TEXT,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ready',
  score         REAL NOT NULL DEFAULT 0,
  score_band    TEXT NOT NULL DEFAULT 'bajo',
  channel_state TEXT NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL DEFAULT 'csv',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_client_day ON cases(client_id, case_date);
CREATE INDEX IF NOT EXISTS idx_cases_day_status ON cases(case_date, status);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  direction   TEXT NOT NULL,
  provider_id TEXT,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',
  error       TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_id);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, created_at);

CREATE TABLE IF NOT EXISTS promises (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  promised_date TEXT,
  confidence    REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  source        TEXT NOT NULL DEFAULT 'ai',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_promises_client_status ON promises(client_id, status);
CREATE INDEX IF NOT EXISTS idx_promises_case ON promises(case_id);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  case_id    TEXT,
  client_id  TEXT,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);

CREATE TABLE IF NOT EXISTS intakes (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  file_name      TEXT,
  rows_total     INTEGER NOT NULL DEFAULT 0,
  rows_accepted  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
