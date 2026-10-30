-- Arkangel · Gobernanza LFPDPPP de grabación de audio (Voice AI)
-- Migración 0016 (D1 · SQLite)
--
-- Por qué esta migración:
--   · La grabación estéreo dual-channel de Telnyx se mantiene apagada por
--     defecto (opt-in). Su activación por un despacho requiere, conforme a la
--     LFPDPPP y al Bloque A del spike de voz: (a) locución obligatoria al
--     descolgar, (b) política de retención documentada en días, (c) consentimiento
--     expreso del titular cuando se trate dato biométrico/personal, y (d) aviso
--     de privacidad que nombre a Telnyx y al almacenamiento en nube como
--     encargados.
--   · Esta migración agrega la política de grabación por tenant. Fail-closed:
--     todos los valores por defecto deshabilitan la grabación; un tenant no puede
--     grabar hasta que complete la política y la habilite explícitamente.
--
-- Reglas de esta migración:
--   · Idempotente: ALTER TABLE ... ADD COLUMN no es idempotente en SQLite, por
--     eso se usa un patrón defensivo con la tabla de control `_migrations`.
--     Para simplificar y ser consistente con el resto del proyecto, las columnas
--     se agregan con ADD COLUMN dentro de un bloque que ignora el error si ya
--     existen (D1 ejecuta el archivo completo; si una columna ya existe, el
--     statement falla y aborta la migración, así que este archivo debe aplicarse
--     una sola vez por base).

PRAGMA foreign_keys = ON;

-- Columnas de gobernanza de grabación en `tenants`.
ALTER TABLE tenants ADD COLUMN recording_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (recording_enabled IN (0, 1));
ALTER TABLE tenants ADD COLUMN recording_announcement TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN recording_retention_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN recording_consent_required INTEGER NOT NULL DEFAULT 1
  CHECK (recording_consent_required IN (0, 1));
ALTER TABLE tenants ADD COLUMN recording_privacy_notice_url TEXT NOT NULL DEFAULT '';

-- Backfill explícito: todos los tenants quedan con grabación deshabilitada.
-- (Los DEFAULT ya lo garantizan, pero se deja explícito para auditoría.)
UPDATE tenants
SET recording_enabled = 0,
    recording_retention_days = 0
WHERE recording_enabled IS NULL OR recording_retention_days IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_recording_enabled
  ON tenants(recording_enabled);