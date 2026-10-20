# ARKANGEL — Mapa del proyecto y bitácora de sprints

## Vista general
Worker Cloudflare (Hono/TS) de cobranza asistida por IA sobre WhatsApp/SMS/Email. D1 + KV + Queues + DO + R2. Workers AI (Llama 3.3) con fallback heurístico. Motor legal fail-closed (12 reglas). Scoring Sherman v2. Dashboard "1 botón · 0 tablas". Módulo contable: legal_audit → asientos → Alegra (MCP).

## Estructura
- src/index.ts — entry, routing, cron/queue
- src/routes — health, ingest, api, webhooks, agent (Grok Bot), contabilidad
- src/services — casos, clientes, deudas, mensajes, promesas, metricas, legalAudit, eventos, db
- src/orquestacion — disparador, consumidor, inbound
- src/legal — motor, reglas, config, sanitizador, tipos
- src/ai — agent, classify, prompts
- src/channels — whatsapp, telnyx, resend, types
- src/cron — manana, contabilidadDaily, reconciliacion
- src/contabilidad — buildPayload, sendToAlegra, alegraClient, schemas
- src/durable — call-lock
- frontend — React dashboard (Vite)
- design-system — tokens + components
- migrations, scripts, tests

## Endpoints clave
- GET /api/v1/health
- POST /api/v1/ingest/csv
- GET /api/v1/cases/today, /metrics/today
- POST /api/v1/disparar
- GET /api/v1/cases/:id, /clients/:id, /clients/:id/conversation
- GET /api/v1/legal/catalogo, /legal/hoy
- GET /api/v1/contabilidad/resumen — corte contable del día (JSON de R2)
- GET/POST /api/v1/agent/* (state, decide, dispatch, audit) — Grok Bot

## Sprints / bitácora

### Sprint 0 — Base
- [x] Worker Hono + D1/KV/Queue/DO
- [x] Canales WhatsApp/SMS/Email
- [x] Workers AI redacción/respuestas + fallback
- [x] Motor legal fail-closed (12 reglas)
- [x] Scoring Sherman v2
- [x] Dashboard 1 botón
- [x] Cron 6 AM + ingesta CSV

### Sprint 1 — Grok Bot (agentico)
- [x] Auth scope GROK_BOT_TOKEN (isAgent)
- [x] Modo supervisado / autónomo (AGENT_MODE)
- [x] Endpoints agent/state, decide, dispatch, audit
- [x] Escalamiento por monto (AGENT_AUTO_THRESHOLD_CENTS) y casos molesto
- [x] Auditoría de decisiones vía eventos
- [ ] Webhook clasificación en tiempo real por Grok
- [ ] Ajuste continuo de prompts/scoring por resultados
- [ ] Reporte diario automatizado

### Sprint 2 — Módulo contable (Alegra MCP)
- [x] Migración 003: alegra_sync, legal_accounting_map (seed), alegra_journal_lines, ledger_checkpoint, contract_cfdi (con PRAGMA foreign_keys = ON)
- [x] buildAccountingPayload(): JOIN D1 + cadena de hashes del ledger + validación Zod + ventana UTC/CDMX
- [x] alegraClient: MCP por HTTP (JSON-RPC 2.0) con SSE, cache de sesión en KV y mapa de errores retry/fail
- [x] sendToAlegra(): idempotencia con salt, cache 24 h del catálogo de cuentas, dos fases y warning accionable
- [x] Reconciliation: src/cron/reconciliacion.ts (cortes pending/failed sin duplicar asientos)
- [x] Cron 23:59 CDMX (`59 5 * * *`) → R2 → Alegra (fail-closed si el ledger no verifica)
- [x] GET /api/v1/contabilidad/resumen (lectura del JSON de R2)
- [x] Tests: 3 asientos con cuentas correctas, idempotencia, ledger roto, ingreso no reconocido, SSE, fallback de cuenta y reconciliación
- [ ] Configurar ALEGRA_MCP_URL/TOKEN/ALEGRA_IDEMPOTENCY_SALT y crear el bucket R2 `arkangel-contabilidad`
- [ ] Aplicar la migración 003 (PRAGMA foreign_keys = ON) en remoto
- [ ] Validar el catálogo de cuentas reales en Alegra contra `legal_accounting_map`

## Próximos
- Implementar webhooks → Grok Bot clasificación
- Modo autónomo completo con guardrails
- Tests para rutas agent
" filePath="C:\Users\PAV\Desktop\e-commerce\arkangel\map.md