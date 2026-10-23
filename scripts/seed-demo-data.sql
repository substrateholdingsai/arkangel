-- ============================================================================
-- ARKANGEL · Seed Sintético de Demostración (t_arkangel & t_ark_systems)
-- Configura razón social de prueba ante CONDUSEF y puebla clientes, contratos,
-- deudas, casos del día, promesas, conversaciones omnicanal y auditoría legal.
-- ============================================================================

-- 1. Configurar identidad legal sintética en ambos despachos
UPDATE tenants
SET config_mode = 'db',
    razon_social = 'Arkangel Cobranza Legal S.A.P.I. de C.V.',
    condusef_registro = 'REDECO-2026-0042',
    allowed_payment_domains = 'arksystems.site,pagos.arksystems.site',
    updated_at = datetime('now')
WHERE id = 't_arkangel';

UPDATE tenants
SET config_mode = 'db',
    razon_social = 'Ark Systems Cobranza S.A. de C.V.',
    condusef_registro = 'REDECO-2026-0099',
    allowed_payment_domains = 'arksystems.site,pagos.arksystems.site',
    updated_at = datetime('now')
WHERE id = 't_ark_systems';

-- 2. Clientes sintéticos (t_arkangel)
INSERT OR REPLACE INTO clients (
  id, tenant_id, name, phone, email, curp,
  whatsapp_opt_in, sms_opt_in, email_opt_in, do_not_disturb, source, created_at, updated_at
) VALUES
  ('cli_demo_01', 't_arkangel', 'Carlos Eduardo Mendoza Silva', '+525548901234', 'cmendoza@ejemplo.mx', 'MESC850412HDFRRL09', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('cli_demo_02', 't_arkangel', 'Fernanda Guadalupe Ríos Ortega', '+525571234567', 'frios.ortega@ejemplo.mx', 'RIOF910823MDFNNS04', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('cli_demo_03', 't_arkangel', 'Jorge Alberto Domínguez Treviño', '+528183456789', 'jdominguez@ejemplo.mx', 'DOTJ791105HNLTRJ02', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('cli_demo_04', 't_arkangel', 'Patricia Elena Vázquez Lozano', '+523336789012', 'pvazquez@ejemplo.mx', 'VALP880219MJCVZR07', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('cli_demo_05', 't_arkangel', 'Ricardo Sebastián Mora Pineda', '+525560987654', 'rmora.pineda@ejemplo.mx', 'MOPR940630HDFMPR01', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('cli_demo_06', 't_arkangel', 'Gabriela Monserrat Herrera Cruz', '+525523456701', 'gherrera@ejemplo.mx', 'HECG871214MDFRRC05', 1, 1, 1, 0, 'csv', datetime('now', '-2 hours'), datetime('now'));

-- 3. Contratos vigentes con CLABE autorizada y tasa anual pactada (Reglas 3.2, 4.2 y 8.1)
DELETE FROM contracts WHERE id IN ('con_demo_01', 'con_demo_02', 'con_demo_03', 'con_demo_04', 'con_demo_05', 'con_demo_06');
INSERT INTO contracts (
  id, tenant_id, client_id, monto_pactado_cents, tasa_pct, clabe, nombre_legal, condusef, created_at, updated_at
) VALUES
  ('con_demo_01', 't_arkangel', 'cli_demo_01', 845000,  24.0, '646180157000000101', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-30 days'), datetime('now')),
  ('con_demo_02', 't_arkangel', 'cli_demo_02', 1520000, 18.5, '646180157000000202', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-45 days'), datetime('now')),
  ('con_demo_03', 't_arkangel', 'cli_demo_03', 390000,  24.0, '646180157000000303', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-20 days'), datetime('now')),
  ('con_demo_04', 't_arkangel', 'cli_demo_04', 2150000, 16.0, '646180157000000404', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-60 days'), datetime('now')),
  ('con_demo_05', 't_arkangel', 'cli_demo_05', 1240000, 20.0, '646180157000000505', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-35 days'), datetime('now')),
  ('con_demo_06', 't_arkangel', 'cli_demo_06', 675000,  24.0, '646180157000000606', 'Arkangel Cobranza Legal S.A.P.I. de C.V.', 'REDECO-2026-0042', datetime('now', '-15 days'), datetime('now'));

-- 4. Deudas pendientes / pagadas
DELETE FROM debts WHERE id IN ('deb_demo_01', 'deb_demo_02', 'deb_demo_03', 'deb_demo_04', 'deb_demo_05', 'deb_demo_06');
INSERT INTO debts (
  id, tenant_id, client_id, amount_cents, currency, due_date, status, description, source, created_at, updated_at
) VALUES
  ('deb_demo_01', 't_arkangel', 'cli_demo_01', 845000,  'MXN', '2026-09-18', 'pending', 'Crédito Revolvente PyME · Folio 8841', 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('deb_demo_02', 't_arkangel', 'cli_demo_02', 1520000, 'MXN', '2026-08-10', 'pending', 'Arrendamiento Equipo · Folio 7712', 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('deb_demo_03', 't_arkangel', 'cli_demo_03', 390000,  'MXN', '2026-10-02', 'pending', 'Línea Comercial · Folio 9104', 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('deb_demo_04', 't_arkangel', 'cli_demo_04', 2150000, 'MXN', '2026-07-25', 'pending', 'Crédito Simple · Folio 6620', 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('deb_demo_05', 't_arkangel', 'cli_demo_05', 1240000, 'MXN', '2026-09-05', 'pending', 'Factura Vencida CFDI · Folio 8390', 'csv', datetime('now', '-2 hours'), datetime('now')),
  ('deb_demo_06', 't_arkangel', 'cli_demo_06', 675000,  'MXN', '2026-10-08', 'paid',    'Crédito Nómina · Folio 9455', 'csv', datetime('now', '-2 hours'), datetime('now'));

-- 5. Registro de ingesta matutina de hoy (6:00 AM CDMX)
INSERT OR REPLACE INTO intakes (
  id, tenant_id, source, file_name, rows_total, rows_accepted, created_at
) VALUES (
  'int_demo_hoy', 't_arkangel', 'csv', 'cartera-mora-temprana-oct22.csv', 6, 6, datetime('now', '-2 hours')
);

-- 6. Casos del día en distintos estados para probar todas las bandejas
DELETE FROM cases WHERE id IN ('cas_demo_01', 'cas_demo_02', 'cas_demo_03', 'cas_demo_04', 'cas_demo_05', 'cas_demo_06');
INSERT INTO cases (
  id, tenant_id, case_date, client_id, debt_id, name, phone, email,
  amount_cents, status, score, score_band, channel_state, source, created_at, updated_at
) VALUES
  -- 2 Escalados a Humano (para probar el Drawer + Softphone + Guardián Legal)
  ('cas_demo_01', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_01', 'deb_demo_01',
   'Carlos Eduardo Mendoza Silva', '+525548901234', 'cmendoza@ejemplo.mx',
   845000, 'human', 0.72, 'alto', '{"lastChannel":"whatsapp","intentos":2}', 'csv', datetime('now', '-2 hours'), datetime('now', '-20 minutes')),

  ('cas_demo_02', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_02', 'deb_demo_02',
   'Fernanda Guadalupe Ríos Ortega', '+525571234567', 'frios.ortega@ejemplo.mx',
   1520000, 'human', 0.89, 'alto', '{"lastChannel":"whatsapp","intentos":1}', 'csv', datetime('now', '-2 hours'), datetime('now', '-15 minutes')),

  -- 2 En Cola listos para disparo IA (ready)
  ('cas_demo_03', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_03', 'deb_demo_03',
   'Jorge Alberto Domínguez Treviño', '+528183456789', 'jdominguez@ejemplo.mx',
   390000, 'ready', 0.41, 'medio', '{}', 'csv', datetime('now', '-2 hours'), datetime('now', '-2 hours')),

  ('cas_demo_04', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_04', 'deb_demo_04',
   'Patricia Elena Vázquez Lozano', '+523336789012', 'pvazquez@ejemplo.mx',
   2150000, 'ready', 0.94, 'alto', '{}', 'csv', datetime('now', '-2 hours'), datetime('now', '-2 hours')),

  -- 1 Promesa de pago (promised)
  ('cas_demo_05', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_05', 'deb_demo_05',
   'Ricardo Sebastián Mora Pineda', '+525560987654', 'rmora.pineda@ejemplo.mx',
   1240000, 'promised', 0.68, 'alto', '{"lastChannel":"whatsapp","intentos":1}', 'csv', datetime('now', '-2 hours'), datetime('now', '-40 minutes')),

  -- 1 Pagado (paid)
  ('cas_demo_06', 't_arkangel', strftime('%Y-%m-%d', 'now', '-6 hours'), 'cli_demo_06', 'deb_demo_06',
   'Gabriela Monserrat Herrera Cruz', '+525523456701', 'gherrera@ejemplo.mx',
   675000, 'paid', 0.35, 'medio', '{"lastChannel":"whatsapp","intentos":1}', 'csv', datetime('now', '-2 hours'), datetime('now', '-10 minutes'));

-- 7. Promesa de pago abierta
DELETE FROM promises WHERE id = 'prm_demo_05';
INSERT INTO promises (
  id, tenant_id, case_id, client_id, amount_cents, promised_date, confidence, status, source, created_at
) VALUES (
  'prm_demo_05', 't_arkangel', 'cas_demo_05', 'cli_demo_05', 1240000,
  strftime('%Y-%m-%d', 'now', '+3 days'), 0.94, 'open', 'ai', datetime('now', '-40 minutes')
);

-- 8. Conversaciones omnicanal realistas (inbound / outbound)
DELETE FROM messages WHERE id LIKE 'msg_demo_%';
INSERT INTO messages (
  id, tenant_id, case_id, client_id, channel, direction, provider_id, body, status, error, meta, created_at
) VALUES
  -- Caso 1: Carlos Mendoza (Pide factura y desglose -> Escalado a humano)
  ('msg_demo_01', 't_arkangel', 'cas_demo_01', 'cli_demo_01', 'whatsapp', 'outbound', 'wamid.demo01',
   'Estimado Carlos Eduardo Mendoza Silva, le saluda Arkangel Cobranza Legal S.A.P.I. de C.V. (Registro CONDUSEF: REDECO-2026-0042). Le recordamos su saldo pendiente de $8,450.00 MXN correspondiente al Folio 8841. Puede realizar su pago vía SPEI a la CLABE autorizada 646180157000000101.',
   'delivered', NULL, '{"ai_generated":true}', datetime('now', '-90 minutes')),

  ('msg_demo_02', 't_arkangel', 'cas_demo_01', 'cli_demo_01', 'whatsapp', 'inbound', 'wamid.demo02',
   'Hola, sí reconozco el saldo pero necesito que me manden primero el CFDI y me confirmen si me pueden respetar dos pagos quincenales con un ejecutivo.',
   'received', NULL, '{"intencion":"pide_factura","confianza":0.91}', datetime('now', '-25 minutes')),

  -- Caso 2: Fernanda Ríos (Cliente molesta / solicita hablar con supervisor -> Escalado a humano)
  ('msg_demo_03', 't_arkangel', 'cas_demo_02', 'cli_demo_02', 'whatsapp', 'outbound', 'wamid.demo03',
   'Estimada Fernanda Guadalupe Ríos Ortega, le contactamos de Arkangel Cobranza Legal S.A.P.I. de C.V. (REDECO-2026-0042) respecto a su saldo de $15,200.00 MXN (Folio 7712). CLABE autorizada en contrato: 646180157000000202.',
   'delivered', NULL, '{"ai_generated":true}', datetime('now', '-75 minutes')),

  ('msg_demo_04', 't_arkangel', 'cas_demo_02', 'cli_demo_02', 'whatsapp', 'inbound', 'wamid.demo04',
   'Ya les había comentado que tuve un atraso con mi banco. Comuníquenme con una persona para acordar fecha exacta de pago por favor.',
   'received', NULL, '{"intencion":"molesto","confianza":0.88}', datetime('now', '-15 minutes')),

  -- Caso 5: Ricardo Mora (Promesa de pago capturada por IA)
  ('msg_demo_05', 't_arkangel', 'cas_demo_05', 'cli_demo_05', 'whatsapp', 'outbound', 'wamid.demo05',
   'Estimado Ricardo Sebastián Mora Pineda, le contacta Arkangel Cobranza Legal S.A.P.I. de C.V. (REDECO-2026-0042) por su saldo vencido de $12,400.00 MXN (Folio 8390). CLABE SPEI: 646180157000000505.',
   'delivered', NULL, '{"ai_generated":true}', datetime('now', '-55 minutes')),

  ('msg_demo_06', 't_arkangel', 'cas_demo_05', 'cli_demo_05', 'whatsapp', 'inbound', 'wamid.demo06',
   'Perfecto, el viernes sin falta hago la transferencia completa de los $12,400 a esa CLABE.',
   'received', NULL, '{"intencion":"promete","confianza":0.95}', datetime('now', '-40 minutes')),

  -- Caso 6: Gabriela Herrera (Pago confirmado)
  ('msg_demo_07', 't_arkangel', 'cas_demo_06', 'cli_demo_06', 'whatsapp', 'outbound', 'wamid.demo07',
   'Estimada Gabriela Monserrat Herrera Cruz, le saluda Arkangel Cobranza Legal S.A.P.I. de C.V. (REDECO-2026-0042) sobre su saldo de $6,750.00 MXN (Folio 9455). CLABE SPEI: 646180157000000606.',
   'delivered', NULL, '{"ai_generated":true}', datetime('now', '-50 minutes')),

  ('msg_demo_08', 't_arkangel', 'cas_demo_06', 'cli_demo_06', 'whatsapp', 'inbound', 'wamid.demo08',
   'Listo, acabo de realizar la transferencia SPEI por $6,750.00 con clave de rastreo 20261022STP99812.',
   'received', NULL, '{"intencion":"paga","confianza":0.98}', datetime('now', '-10 minutes'));

-- 9. Bitácora de auditoría legal (demostración de bloqueos y saneamientos QA hoy)
DELETE FROM legal_audit WHERE id IN ('leg_demo_01', 'leg_demo_02');
INSERT INTO legal_audit (
  id, tenant_id, regla_id, seccion, conducta, ley, articulo, castigo, accion, detalle, evidencia, case_id, client_id, canal, created_at
) VALUES
  ('leg_demo_01', 't_arkangel', '3.2', 'III · Fraude y Suplantación Digital',
   'Solicitar pagos en cuentas o CLABEs distintas a las del contrato original',
   'CPF / LFPC', 'Art. 386 CPF / Art. 112 Bis LFPC', '3 a 10 años de prisión; multa hasta $2.24M MXN',
   'BLOCK', 'CLABE no reconocida en el contrato del cliente (posible desvío de fondos): 012180009988776655.',
   'Favor de depositar hoy mismo a la cuenta alterna 012180009988776655', 'cas_demo_02', 'cli_demo_02', 'whatsapp',
   datetime('now', '-30 minutes')),

  ('leg_demo_02', 't_arkangel', '4.1', 'IV · Lenguaje y Trato Degradante',
   'Uso de lenguaje intimidatorio, ofensivo, coercitivo o amenazante',
   'LFPC / Disposiciones CONDUSEF', 'Art. 112 Bis LFPC', 'Multa de $197,000 a $2,240,000 MXN',
   'SANITIZE', 'Lenguaje intimidatorio o coercitivo detectado: "último aviso".',
   'Removido: "último aviso"', 'cas_demo_01', 'cli_demo_01', 'whatsapp',
   datetime('now', '-45 minutes'));
