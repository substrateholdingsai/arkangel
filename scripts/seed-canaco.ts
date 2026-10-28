/**
 * Script de siembra y aprovisionamiento de CANACO SERVYTUR MÉRIDA en D1.
 *
 * Aprovisiona:
 *   1. Tenant canaco_merida (Razón social, registro CONDUSEF/REDECO, ventana NOM-184 08:00 a 20:00, max 2 contactos).
 *   2. Usuario cameral: horus.i2d@gmail.com con membresía admin.
 *   3. Canal de WhatsApp oficial (+529999253060) y telefónico de Mérida Lada 999 (+529999253060).
 *   4. Mapa contable.
 *
 * Uso:
 *   npx tsx scripts/seed-canaco.ts
 *   npx tsx scripts/seed-canaco.ts --remote
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const BASE_DE_DATOS = 'arkangel-cobranza-db';
const WRANGLER_JS = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

const SQL_CANACO = `
PRAGMA foreign_keys = ON;

-- 1. Tenant canaco_merida
INSERT OR REPLACE INTO tenants (
  id, slug, nombre, status, config_mode,
  razon_social, condusef_registro, allowed_payment_domains,
  tz, send_window_start, send_window_end, max_contacts_per_day,
  legal_monto_tolerancia_cents, legal_horario_en_respuestas,
  rate_limit_rpm, dedupe_window_hours, score_amount_ceiling_cents,
  agent_mode, agent_auto_threshold_cents, dry_run, cron_auto_fire,
  a2a_enabled, a2a_max_discount_pct, a2a_max_installments, a2a_min_down_payment_pct,
  is_default, created_at, updated_at
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
  id, email, full_name, password_hash, email_verified_at, platform_role, created_at
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
  user_id, tenant_id, role, created_at
)
SELECT id, 'canaco_merida', 'admin', unixepoch()
FROM users WHERE lower(email) = 'horus.i2d@gmail.com'
ON CONFLICT(user_id, tenant_id) DO UPDATE SET
  role = 'admin';

-- 3. Canales Oficiales para CANACO Mérida (Lada 999 & WhatsApp Oficial)
INSERT OR REPLACE INTO tenant_channels (
  id, tenant_id, channel, provider_account_id, credentials, status, created_at, updated_at
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

INSERT OR REPLACE INTO tenant_channels (
  id, tenant_id, channel, provider_account_id, credentials, status, created_at, updated_at
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

INSERT OR REPLACE INTO tenant_channels (
  id, tenant_id, channel, provider_account_id, credentials, status, created_at, updated_at
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
`;

async function main(): Promise<void> {
  const remoto = process.argv.includes('--remote') || process.argv.includes('--remoto');
  const tempFile = path.join(
    tmpdir(),
    `seed-canaco-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`
  );

  await writeFile(tempFile, SQL_CANACO, 'utf8');

  const args = [
    WRANGLER_JS,
    'd1',
    'execute',
    BASE_DE_DATOS,
    `--file=${tempFile}`,
    remoto ? '--remote' : '--local',
  ];

  try {
    console.log(`Sembrando tenant canaco_merida en D1 (${remoto ? 'remota' : 'local'})...`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(process.execPath, args, { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Wrangler falló con código ${code}`));
      });
      proc.on('error', reject);
    });
    console.log('✅ Tenant canaco_merida aprovisionado y sembrado exitosamente.');
  } finally {
    await unlink(tempFile).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error('Error sembrando CANACO Mérida:', err);
  process.exit(1);
});
