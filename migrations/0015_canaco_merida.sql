-- Arkangel · Aprovisionamiento y siembra de CANACO SERVYTUR MÉRIDA
-- Migración 0015 (D1 · SQLite)
--
-- Entidad: CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA
-- REDECO / Registro: CANACO-MERIDA-SIEM-2026
-- Ventana legal NOM-184: 08:00 a 20:00 (Zona horaria America/Merida)
-- Máximo de contactos permitidos: 2 contactos diarios
-- Canal telefónico Mérida (Lada 999): +529999253060
-- Canal WhatsApp oficial: +529999253060
-- Administrador Cameral: horus.i2d@gmail.com

PRAGMA foreign_keys = ON;

-- 1. Catálogo de Tenants: canaco_merida
INSERT OR REPLACE INTO tenants (
  id,
  slug,
  nombre,
  status,
  config_mode,
  razon_social,
  condusef_registro,
  allowed_payment_domains,
  tz,
  send_window_start,
  send_window_end,
  max_contacts_per_day,
  legal_monto_tolerancia_cents,
  legal_horario_en_respuestas,
  rate_limit_rpm,
  dedupe_window_hours,
  score_amount_ceiling_cents,
  agent_mode,
  agent_auto_threshold_cents,
  dry_run,
  cron_auto_fire,
  a2a_enabled,
  a2a_max_discount_pct,
  a2a_max_installments,
  a2a_min_down_payment_pct,
  is_default,
  created_at,
  updated_at
) VALUES (
  'canaco_merida',
  'canaco-merida',
  'CANACO SERVYTUR Mérida',
  'active',
  'db',
  'CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA',
  'CANACO-MERIDA-SIEM-2026',
  'arksystems.site,pagos.arksystems.site,ledger.arksystems.site,socios.canacomerida.com.mx',
  'America/Merida',
  8,
  20,
  2,
  0,
  0,
  42,
  24,
  500000,
  'supervised',
  200000,
  0,
  0,
  1,
  15,
  3,
  50,
  0,
  datetime('now'),
  datetime('now')
);

-- 2. Usuario Cameral y Membresía Admin
INSERT INTO users (
  id,
  email,
  full_name,
  password_hash,
  email_verified_at,
  platform_role,
  created_at
) VALUES (
  'usr_canaco_admin_horus',
  'horus.i2d@gmail.com',
  'Horus - Administrador Cameral CANACO Mérida',
  'pbkdf2_sha256$100000$canacomeridaseed1$d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2',
  unixepoch(),
  'user',
  unixepoch()
)
ON CONFLICT(email) DO UPDATE SET
  full_name = excluded.full_name,
  email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at);

INSERT INTO tenant_memberships (
  user_id,
  tenant_id,
  role,
  created_at
)
SELECT id, 'canaco_merida', 'admin', unixepoch()
FROM users WHERE lower(email) = 'horus.i2d@gmail.com'
ON CONFLICT(user_id, tenant_id) DO UPDATE SET
  role = 'admin';

-- 3. Canales Oficiales para CANACO Mérida (Lada 999 & WhatsApp Oficial)
-- Canal WhatsApp Oficial (+529999253060)
INSERT OR REPLACE INTO tenant_channels (
  id,
  tenant_id,
  channel,
  provider_account_id,
  credentials,
  status,
  created_at,
  updated_at
) VALUES (
  'chan_canaco_whatsapp',
  'canaco_merida',
  'whatsapp',
  '+529999253060',
  '{"whatsapp":{"from_number":"+529999253060","phone_number_id":"canaco_merida_wa_mid"}}',
  'active',
  datetime('now'),
  datetime('now')
);

-- Canal Telefónico y SMS Mérida Lada 999 (+529999253060)
INSERT OR REPLACE INTO tenant_channels (
  id,
  tenant_id,
  channel,
  provider_account_id,
  credentials,
  status,
  created_at,
  updated_at
) VALUES (
  'chan_canaco_sms',
  'canaco_merida',
  'sms',
  '+529999253060',
  '{"sms":{"from_number":"+529999253060","messaging_profile_id":"canaco_merida_prof_999"}}',
  'active',
  datetime('now'),
  datetime('now')
);

-- Canal Correo Institucional
INSERT OR REPLACE INTO tenant_channels (
  id,
  tenant_id,
  channel,
  provider_account_id,
  credentials,
  status,
  created_at,
  updated_at
) VALUES (
  'chan_canaco_email',
  'canaco_merida',
  'email',
  'canacomerida.com.mx',
  '{"email":{"from_email":"afiliaciones@canacomerida.com.mx"}}',
  'active',
  datetime('now'),
  datetime('now')
);

-- 4. Mapa contable inicial para canaco_merida
INSERT OR IGNORE INTO tenant_accounting_map (
  tenant_id, regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion
)
SELECT
  'canaco_merida', regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion
FROM legal_accounting_map;
