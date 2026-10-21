-- Arkangel · spike de voz (tabla experimental)
-- Migración 0010 (D1 · SQLite)
--
-- QUÉ ES Y QUÉ NO ES
--   Esta tabla es EXPERIMENTAL y existe sólo para el spike de voz (Tarea 2).
--   No es parte del dominio: en producción no hay tablas de calls, transcripts
--   ni recordings. Sprint 6 decidirá el modelo definitivo (y puede ser otro).
--
--   · No se guarda audio. Jamás.
--   · No se guarda la transcripción de lo que dijo el deudor.
--   · Sólo se guardan MÉTRICAS de latencia agregadas (p50/p95 se calculan al
--     leer) y los datos mínimos para auditar la llamada.
--
-- POR QUÉ D1 Y NO R2 EFÍMERO
--   Las métricas ya son un dato que hay que poder comparar entre llamadas y
--   entre ejecuciones del spike (y después, en Sprint 6, entre tenants). En D1
--   se pueden consultar y agregar con SQL; en R2 habría que bajar los objetos
--   uno por uno. Como el contenido es no sensible (números de latencia) y el
--   volumen es bajo, D1 es la opción simple. La alternativa R2 queda
--   documentada en docs/spike-voz.md por si el volumen crece.
--
-- AISLAMIENTO
--   tenant_id desde el día uno, con índice (tenant_id, ...) y llave foránea
--   al tenant: una llamada sin tenant no existe.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS spike_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Identificador de la llamada tal como lo ve el proveedor (Realtime).
  call_id TEXT NOT NULL,

  -- Estado del spike: idle → ringing → active → ended.
  estado TEXT NOT NULL DEFAULT 'idle',

  -- Traza W3C de la llamada: liga logs, métricas y audio en una sola línea.
  trace_id TEXT,

  -- Turnos medidos y cuántas veces hubo interrupción.
  turnos INTEGER NOT NULL DEFAULT 0,
  interrumpidas INTEGER NOT NULL DEFAULT 0,

  -- Métricas de latencia en milisegundos (JSON con un arreglo por métrica).
  metricas_json TEXT,

  -- Marcador explícito: esta fila es de un spike, no del dominio.
  experimental INTEGER NOT NULL DEFAULT 1,

  iniciada_en TEXT,
  terminada_en TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Regla multi-tenant: tenant_id primero en el índice.
CREATE INDEX IF NOT EXISTS idx_spike_calls_tenant_created
  ON spike_calls(tenant_id, created_at DESC);

-- Índice por trace para encontrar una llamada concreta en los logs.
CREATE INDEX IF NOT EXISTS idx_spike_calls_trace
  ON spike_calls(trace_id);

-- No se puede cerrar el spike con una llamada sin tenant.
CREATE INDEX IF NOT EXISTS idx_spike_calls_call
  ON spike_calls(call_id);
