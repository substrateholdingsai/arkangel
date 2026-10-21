-- Arkangel · aislamiento multi-tenant — tenant_id en tablas de negocio
-- Migración 0006 (D1 · SQLite)
--
-- Por qué esta migración:
--   · Migraciones 0004/0005 crearon el catálogo de tenants y la integración con Clerk,
--     pero los datos operativos (cases, clients, debts, messages, promises, etc.)
--     seguían siendo globales. Dos tenants veían los mismos casos, mensajes, deudas.
--   · Esta migración añade `tenant_id` a TODAS las tablas de negocio y backfillea
--     el tenant por defecto (`t_arkangel`) para datos existentes.
--   · A partir de aquí, **toda query operativa DEBE filtrar por tenant_id**.
--   · Se añaden índices compuestos (tenant_id, ...) para performance.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- 1) CLIENTS
-- =====================================================================
ALTER TABLE clients ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_clients_tenant_phone ON clients(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_tenant_curp ON clients(tenant_id, curp) WHERE curp IS NOT NULL;

-- =====================================================================
-- 2) DEBTS
-- =====================================================================
ALTER TABLE debts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_debts_tenant_client_status ON debts(tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_debts_tenant_due ON debts(tenant_id, status, due_date);

-- =====================================================================
-- 3) CASES
-- =====================================================================
ALTER TABLE cases ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
-- El índice único por (client_id, case_date) ahora debe incluir tenant_id
DROP INDEX IF EXISTS idx_cases_client_day;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_tenant_client_day ON cases(tenant_id, client_id, case_date);
CREATE INDEX IF NOT EXISTS idx_cases_tenant_day_status ON cases(tenant_id, case_date, status);

-- =====================================================================
-- 4) MESSAGES
-- =====================================================================
ALTER TABLE messages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_messages_tenant_case ON messages(tenant_id, case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_provider ON messages(tenant_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_client ON messages(tenant_id, client_id, created_at);

-- =====================================================================
-- 5) PROMISES
-- =====================================================================
ALTER TABLE promises ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_promises_tenant_client_status ON promises(tenant_id, client_id, status);
CREATE INDEX IF NOT EXISTS idx_promises_tenant_case ON promises(tenant_id, case_id);

-- =====================================================================
-- 6) EVENTS
-- =====================================================================
ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_events_tenant_type ON events(tenant_id, type, created_at);

-- =====================================================================
-- 7) CONTRACTS
-- =====================================================================
ALTER TABLE contracts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_contracts_tenant_client ON contracts(tenant_id, client_id);

-- =====================================================================
-- 8) LEGAL_AUDIT
-- =====================================================================
ALTER TABLE legal_audit ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_legal_audit_tenant_created ON legal_audit(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_legal_audit_tenant_regla ON legal_audit(tenant_id, regla_id);
CREATE INDEX IF NOT EXISTS idx_legal_audit_tenant_client ON legal_audit(tenant_id, client_id);

-- =====================================================================
-- 9) INTAKES
-- =====================================================================
ALTER TABLE intakes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_intakes_tenant ON intakes(tenant_id, created_at);

-- =====================================================================
-- 10) ALEGRA_SYNC
-- =====================================================================
ALTER TABLE alegra_sync ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_alegra_sync_tenant_fecha ON alegra_sync(tenant_id, fecha_corte);
CREATE INDEX IF NOT EXISTS idx_alegra_sync_tenant_status ON alegra_sync(tenant_id, status);

-- =====================================================================
-- 11) ALEGRA_JOURNAL_LINES
-- =====================================================================
ALTER TABLE alegra_journal_lines ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_alegra_journal_lines_tenant ON alegra_journal_lines(tenant_id, alegra_sync_id);

-- =====================================================================
-- 12) CONTRACT_CFDI
-- =====================================================================
ALTER TABLE contract_cfdi ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
CREATE INDEX IF NOT EXISTS idx_contract_cfdi_tenant_contract ON contract_cfdi(tenant_id, contract_id);

-- =====================================================================
-- 13) LEDGER_CHECKPOINT
-- =====================================================================
-- El ledger checkpoint es por tenant + fecha_corte
ALTER TABLE ledger_checkpoint ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 't_arkangel';
DROP INDEX IF EXISTS idx_ledger_checkpoint_fecha; -- no existe, pero por si acaso
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_checkpoint_tenant_fecha ON ledger_checkpoint(tenant_id, fecha_corte);

-- =====================================================================
-- 14) TENANT_ACCOUNTING_MAP (ya tiene tenant_id en PK)
-- =====================================================================
-- Ya está correcto: PRIMARY KEY (tenant_id, regla_id)

-- =====================================================================
-- 15) TENANT_CHANNELS (ya tiene tenant_id en FK)
-- =====================================================================
-- Ya está correcto: FOREIGN KEY (tenant_id) REFERENCES tenants(id)

-- =====================================================================
-- 16) TENANT_USERS (ya tiene tenant_id en PK)
-- =====================================================================
-- Ya está correcto: PRIMARY KEY (user_id, tenant_id)

-- =====================================================================
-- 17) PLATFORM_USERS (transversal, no tiene tenant_id - correcto)
-- =====================================================================

-- =====================================================================
-- BACKFILL: los datos existentes ya tienen tenant_id = 't_arkangel'
-- por el DEFAULT de las ALTER TABLE. No hace falta UPDATE explícito.
-- =====================================================================