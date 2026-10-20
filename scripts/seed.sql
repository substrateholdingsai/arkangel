-- Datos de prueba para desarrollo local (wrangler d1 execute --local)
INSERT OR IGNORE INTO clients (id, name, phone, email, curp, whatsapp_opt_in, sms_opt_in, email_opt_in, do_not_disturb, source, created_at, updated_at)
VALUES
  ('cli_seed_1', 'JUAN PEREZ LOPEZ', '+525511110001', 'juan@example.com', NULL, NULL, NULL, 0, 0, 'seed', datetime('now'), datetime('now')),
  ('cli_seed_2', 'MARIA GARCIA RUIZ', '+525522220002', 'maria@example.com', NULL, NULL, NULL, 1, 0, 'seed', datetime('now'), datetime('now')),
  ('cli_seed_3', 'CARLOS MENDOZA', '+525298765432', NULL, NULL, NULL, NULL, 0, 0, 'seed', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO debts (id, client_id, amount_cents, currency, due_date, status, description, source, created_at, updated_at)
VALUES
  ('dbt_seed_1', 'cli_seed_1', 845000, 'MXN', '2026-09-15', 'pending', 'Ref INV-1001', 'seed', datetime('now'), datetime('now')),
  ('dbt_seed_2', 'cli_seed_2', 1230000, 'MXN', '2026-08-01', 'pending', 'Ref INV-1002', 'seed', datetime('now'), datetime('now')),
  ('dbt_seed_3', 'cli_seed_3', 490000, 'MXN', '2026-10-01', 'pending', 'Ref INV-1003', 'seed', datetime('now'), datetime('now'));
