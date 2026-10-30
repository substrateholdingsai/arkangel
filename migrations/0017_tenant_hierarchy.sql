-- Arkangel · Jerarquía de tenants (cámara → socio) y marca comercial
-- Migración 0017 (D1 · SQLite)
--
-- Por qué esta migración:
--   · El Motor de Comunicación (src/comunicacion) envía a nombre de dos niveles
--     de emisor: la organización (p. ej. CANACO hablándole a sus agremiados) y
--     el socio (el negocio hablándole a sus clientes con el canal y la bolsa de
--     créditos de la cámara).
--   · Para eso Arkangel necesita saber (a) de quién es el canal, (b) quién paga
--     y (c) qué marca se firma en cada mensaje (LFPC: identificación del
--     proveedor). Hoy `tenants` es plano.
--
-- Reglas de esta migración:
--   · Sólo AÑADE columnas con default: el flujo de cobranza no cambia ni un byte.
--   · La herencia de canales del socio la resuelve sólo el Motor de Comunicación;
--     la resolución de canales de cobranza sigue siendo exactamente la de antes.

PRAGMA foreign_keys = ON;

-- Tenant padre (la organización de la que cuelga un socio). NULL = raíz.
ALTER TABLE tenants ADD COLUMN parent_tenant_id TEXT REFERENCES tenants(id);

-- Nivel del tenant en la jerarquía:
--   platform     → el tenant por defecto de la plataforma.
--   organizacion → cámara, asociación o despacho (dueño de canales y bolsa).
--   socio        → negocio agremiado; usa canales y bolsa de su organización.
ALTER TABLE tenants ADD COLUMN tenant_level TEXT NOT NULL DEFAULT 'organizacion'
  CHECK (tenant_level IN ('platform', 'organizacion', 'socio'));

-- Nombre comercial que se firma en cada mensaje de comunicación general.
-- Vacío = el motor de comunicación NO envía (fail-closed, regla de marca).
ALTER TABLE tenants ADD COLUMN marca_comercial TEXT NOT NULL DEFAULT '';

-- Política de comunicación del tenant (marketing / avisos).
-- Mensajes de marketing por marca y número en 7 días.
ALTER TABLE tenants ADD COLUMN comm_max_por_semana INTEGER NOT NULL DEFAULT 2
  CHECK (comm_max_por_semana BETWEEN 0 AND 7);
-- Alcance de una baja (BAJA/STOP) recibida por un canal compartido:
--   marca        → sólo la marca que envió el último mensaje a ese número.
--   organizacion → toda la organización (la cámara y todos sus socios).
ALTER TABLE tenants ADD COLUMN comm_optout_scope TEXT NOT NULL DEFAULT 'marca'
  CHECK (comm_optout_scope IN ('marca', 'organizacion'));

CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id);

-- Backfill
UPDATE tenants SET tenant_level = 'platform' WHERE is_default = 1;
UPDATE tenants SET marca_comercial = 'CANACO SERVYTUR Mérida' WHERE id = 'canaco_merida';
