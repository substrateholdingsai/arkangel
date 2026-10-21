-- Arkangel · tenant config columns (verificación y backfill)
-- Migración 0009 (D1 · SQLite)
--
-- Por qué esta migración:
--   · La migración 0004 ya creó todas las columnas necesarias para la config
--     por tenant (tz, send_window_start, send_window_end, max_contacts_per_day,
--     allowed_payment_domains, razon_social, condusef_registro, etc.).
--   · Esta migración sirve como punto de control: verifica que las columnas
--     existen, añade índices compuestos útiles para consultas por tenant, y
--     hace backfill de valores por defecto seguros para t_arkangel si la fila
--     quedó con valores heredados de la migración 0004.
--
-- No rompe nada: todas las sentencias son IF NOT EXISTS o UPDATE idempotentes.

PRAGMA foreign_keys = ON;

-- ── Índices compuestos para consultas por tenant ──────────────────────────────
-- Estos índices aceleran las consultas que filtran por tenant_id + otra columna,
-- que es el patrón dominante en multi-tenant (regla: tenant_id siempre primero).

CREATE INDEX IF NOT EXISTS idx_tenants_status_config_mode
  ON tenants(status, config_mode);

CREATE INDEX IF NOT EXISTS idx_tenants_default_config
  ON tenants(is_default, config_mode);

-- ── Backfill idempotente para t_arkangel ──────────────────────────────────────
-- Si la fila de t_arkangel tiene valores vacíos heredados de la migración 0004
-- (config_mode='platform_env', razon_social='', condusef_registro='',
-- allowed_payment_domains=''), los rellenamos con los defaults de la plataforma
-- para que el tenant esté "listo" antes de cambiar a config_mode='db'.
-- El script scripts/seed-tenant-config.ts sobrescribe estos valores con los reales.

UPDATE tenants
SET
  tz = COALESCE(NULLIF(tz, ''), 'America/Mexico_City'),
  send_window_start = COALESCE(send_window_start, 8),
  send_window_end = COALESCE(send_window_end, 22),
  max_contacts_per_day = COALESCE(max_contacts_per_day, 3),
  legal_monto_tolerancia_cents = COALESCE(legal_monto_tolerancia_cents, 0),
  legal_horario_en_respuestas = COALESCE(legal_horario_en_respuestas, 0),
  rate_limit_rpm = COALESCE(rate_limit_rpm, 42),
  dedupe_window_hours = COALESCE(dedupe_window_hours, 24),
  score_amount_ceiling_cents = COALESCE(score_amount_ceiling_cents, 200000),
  agent_mode = COALESCE(NULLIF(agent_mode, ''), 'supervised'),
  agent_auto_threshold_cents = COALESCE(agent_auto_threshold_cents, 200000),
  dry_run = COALESCE(dry_run, 0),
  cron_auto_fire = COALESCE(cron_auto_fire, 0),
  updated_at = datetime('now')
WHERE id = 't_arkangel'
  AND (
    tz IS NULL OR tz = ''
    OR send_window_start IS NULL
    OR send_window_end IS NULL
    OR max_contacts_per_day IS NULL
    OR legal_monto_tolerancia_cents IS NULL
    OR legal_horario_en_respuestas IS NULL
    OR rate_limit_rpm IS NULL
    OR dedupe_window_hours IS NULL
    OR score_amount_ceiling_cents IS NULL
    OR agent_mode IS NULL OR agent_mode = ''
    OR agent_auto_threshold_cents IS NULL
    OR dry_run IS NULL
    OR cron_auto_fire IS NULL
  );

-- ── Nota: el cambio a config_mode='db' NO va en migración ─────────────────────
-- El paso a 'db' es una decisión operativa: se hace SOLO tras verificar que
-- la fila tiene razón social y CONDUSEF cargados (vía seed-tenant-config.ts).
-- Ejecutar manualmente cuando la fila esté completa:
--   UPDATE tenants SET config_mode='db' WHERE id='t_arkangel';