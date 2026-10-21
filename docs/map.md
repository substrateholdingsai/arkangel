# ARKANGEL — Mapa del proyecto y bitácora de sprints

> **Estado**: `main` · 187 tests verdes · lint + typecheck + build limpios.
> Última actualización: 2026-10-21 (Sprint 4 completado: tenant isolation, rate limiter, observabilidad).

## Vista general

Worker Cloudflare (Hono/TS) de cobranza asistida por IA sobre WhatsApp/SMS/Email.
D1 + KV + Queues + Durable Objects + R2. Workers AI (Llama 3.3) con fallback
heurístico. Motor legal fail-closed (12 reglas). Scoring Sherman v2. Dashboard
"1 botón · 0 tablas". Módulo contable: `legal_audit` → asientos → Alegra (MCP).
**Multi-tenant completo en datos**: `tenant_id` en todas las tablas de negocio (Fase 4),
identidad por Clerk (Fase 3), config por tenant (Fase 2), catálogo de tenants (Fase 1).

## Estructura

```
src/
├── index.ts                 entry, routing, dispatch de cron (6 AM cobranza / 23:59 CDMX contable)
├── routes/                  health · ingest · api · webhooks · agent (Grok Bot) · contabilidad ·
│                            guard (scope por ruta) · tenant (contexto) · auth (cabeceras)
├── services/                casos, clientes, deudas, mensajes, promesas, metricas,
│                            legalAudit (ledger append-only), eventos, contratos, db
├── orquestacion/            disparador, consumidor (cola), inbound
├── legal/                   motor, reglas (catálogo), config, sanitizador, tipos
├── ai/                      agent (redactMessage), classify, prompts
├── channels/                whatsapp, telnyx, resend, types
├── cron/                    manana · contabilidadDaily · reconciliacion
├── contabilidad/            buildPayload · sendToAlegra · alegraClient · schemas
├── tenancy/                 types · config (resolución) · context · repository · channels · keys ·
│                            referencia (cabecera de tenant)
├── auth/                    clerk (identidad) · guards (principal + scope) · scopes (catálogo) ·
│                            principal
├── durable/                 call-lock
├── lib/                     crypto, csv, http, idempotencia, logger, money, phone, score
└── types/                   env, cobranza
frontend/                    React + Vite (dashboard) + ClerkProvider
design-system/               tokens + componentes reutilizables
migrations/                  0001_init · 0002_legal · 0003_alegra_sync · 0004_tenants ·
                             0005_clerk_auth · 0006_tenant_isolation
scripts/                     seed.sql, forge_arkangel_watermark.py
docs/                        arquitectura.md · map.md · runbook-cobranza.md
tests/                       13 archivos (unit + auth Clerk + transporte MCP sobre HTTP real)
```

## Endpoints

Auth = sesión de Clerk (`Authorization: Bearer <JWT de sesión>`) o token de máquina.
Cada ruta exige **su** scope: sin credencial → 401, con credencial pero sin scope → 403.

| Método | Ruta | Scope | Descripción |
|---|---|---|---|
| GET | `/api/v1/health` | público | Liveness del worker |
| POST | `/api/v1/ingest/csv` | `ingest:write` | Ingesta del CSV (multipart o JSON) |
| GET | `/api/v1/cases/today` | `cases:read` | Casos del día + vista previa |
| GET | `/api/v1/metrics/today` | `metrics:read` | Métricas del día |
| POST | `/api/v1/disparar` | `cases:dispatch` | Encola los casos listos (botón verde) |
| GET | `/api/v1/cases/:id` | `cases:read` | Detalle de un caso |
| GET | `/api/v1/clients/:id` | `clients:read` | Cliente + deudas pendientes |
| GET | `/api/v1/clients/:id/conversation` | `messages:read` | Historial de mensajes |
| GET | `/api/v1/legal/catalogo` | `legal:read` | 12 reglas con ley, artículo y castigo |
| GET | `/api/v1/legal/hoy` | `legal:read` | Resumen de cumplimiento + auditoría |
| GET | `/api/v1/contabilidad/resumen` | `accounting:read` | Corte contable (JSON de R2) |
| GET | `/api/v1/state` | `agent:read` | Estado del bot (modo, cola, pendientes) |
| POST | `/api/v1/decide` · `/dispatch` · `/audit` | `agent:decide` · `agent:dispatch` · `agent:audit` | Decisión, envío y auditoría de acciones |
| GET/POST | `/webhooks/whatsapp` | firma de Meta | Verificación del challenge + mensajes y estados |
| POST | `/webhooks/telnyx` | firma Ed25519 | SMS entrante y estados |
| POST | `/webhooks/resend` | — | Email entrante |

Tokens de máquina: `ADMIN_TOKEN` (plataforma, break-glass), `INTAKE_TOKEN`
(`service_ingest`) y `GROK_BOT_TOKEN` (`service_agent`). Los de servicio quedan
acotados al tenant de la cabecera y nunca obtienen alcance de plataforma.

## Datos

| Tabla | Rol |
|---|---|
| `clients` · `debts` · `cases` | Cartera y casos del día |
| `contracts` | Monto pactado, CLABE, razón legal (base de las reglas 8.1/3.2/4.2) |
| `messages` · `promises` | Bitácora de mensajes y promesas de pago |
| `events` | Auditoría append-only de cada acción |
| `legal_audit` | **Ledger append-only** del cumplimiento (regla, ley, artículo, castigo) |
| `alegra_sync` | Corte enviado a Alegra (idempotency key, estado, journal id) |
| `legal_accounting_map` | Mapa regla legal → cuentas contables (12 reglas sembradas) |
| `alegra_journal_lines` | Trazabilidad asiento por asiento (`legal_audit.id` → journal id) |
| `ledger_checkpoint` | Cabeza de la cadena de hashes del ledger por día |
| `contract_cfdi` | UUID del CFDI timbrado por contrato (opcional) |
| `tenants` | **Catálogo de clientes**: razón social, CONDUSEF, ventana, límites, modo de config, `clerk_org_id` |
| `tenant_channels` | Enrutado y credenciales por canal (phone_number_id, messaging_profile_id, dominio) |
| `tenant_accounting_map` | Mapa regla legal → cuentas contables, por tenant |
| `tenant_users` | **Rol** del usuario de Clerk dentro del tenant (`owner`/`compliance`/`operator`/`viewer`) |
| `platform_users` | Administradores de plataforma: alcance transversal, sin tenant |

## Sprints / bitácora

### Sprint 0 — Base
- [x] Worker Hono + D1/KV/Queue/DO
- [x] Canales WhatsApp/SMS/Email
- [x] Workers AI redacción/respuestas + fallback
- [x] Motor legal fail-closed (12 reglas)
- [x] Scoring Sherman v2
- [x] Dashboard 1 botón
- [x] Cron 6 AM + ingesta CSV

### Sprint 1 — Grok Bot (agéntico)
- [x] Auth por scope del bot (`GROK_BOT_TOKEN` → rol de servicio `service_agent`:
      `agent:read`, `agent:decide`, `agent:dispatch`, `agent:audit`). Ya no existe
      `isAgent`: la validación de tokens vive en `src/auth/guards.ts`
- [x] Modo supervisado / autónomo (`AGENT_MODE`)
- [x] Endpoints state, decide, dispatch, audit
- [x] Escalamiento por monto (`AGENT_AUTO_THRESHOLD_CENTS`) y casos molesto
- [x] Auditoría de decisiones vía `events`
- [ ] Webhook clasificación en tiempo real por Grok
- [ ] Ajuste continuo de prompts/scoring por resultados
- [ ] Reporte diario automatizado

### Sprint 2 — Módulo contable (Alegra MCP) — **código listo, pendiente de producción**
- [x] Migración 003: `alegra_sync`, `legal_accounting_map` (seed), `alegra_journal_lines`,
      `ledger_checkpoint`, `contract_cfdi` (FK + `PRAGMA foreign_keys = ON`)
- [x] `buildAccountingPayload()`: JOIN D1, cadena de hashes del ledger, ventana del
      día hábil CDMX, validación Zod, idempotency key con salt
- [x] `alegraClient`: MCP por HTTP (JSON-RPC 2.0) con SSE, cache de sesión en KV y
      mapa de errores retry/fail
- [x] `sendToAlegra()`: idempotencia, cache 24 h del catálogo de cuentas, envío en
      dos fases, warning accionable `alegra_account_fallback`
- [x] `reconciliacion.ts`: reintenta cortes a medio camino **sin duplicar asientos**
- [x] Cron 23:59 CDMX (`59 5 * * *`) → R2 → Alegra; fail-closed si el ledger no verifica
- [x] `GET /api/v1/contabilidad/resumen` (JSON de R2, o el último corte publicado)
- [x] Tests: 3 asientos con cuentas correctas, idempotencia, ledger roto, ingreso no
      reconocido, SSE, fallback de cuenta, reconciliación y transporte MCP real
- [ ] **Producción**: secrets (`ALEGRA_MCP_URL`, `ALEGRA_MCP_TOKEN`,
      `ALEGRA_IDEMPOTENCY_SALT`), bucket R2 `arkangel-contabilidad`, migración 003
      en remoto
- [ ] **Validar** el catálogo real de cuentas de Alegra contra `legal_accounting_map`
      (las cuentas del FR son sugerencias)
- [ ] **Ensayo end-to-end** contra un Alegra de pruebas

### Sprint 4 — Tenant Isolation, Distributed Rate Limiter, Observabilidad (2026-10-21)
- [x] **Multi-tenant Fase 4 (tenant_id en tablas de negocio)**: Migración `0006_tenant_isolation.sql` añade `tenant_id` a 17 tablas (`cases`, `clients`, `debts`, `messages`, `promises`, `events`, `contracts`, `legal_audit`, `intakes`, `alegra_sync`, `alegra_journal_lines`, `contract_cfdi`, `ledger_checkpoint`, `tenant_accounting_map`, `tenant_channels`, `tenant_users`, `platform_users`) con índices compuestos `(tenant_id, ...)`. Todos los servicios (`casos`, `clientes`, `deudas`, `mensajes`, `promesas`, `contratos`, `legalAudit`, `eventos`, `metricas`, `ingesta`) actualizados a `TenantContext`. Contabilidad, crons, rutas y orquestación propagan el contexto.
- [x] **Rate Limiter distribuido (Durable Object)**: `RateLimiterDO` (nuevo `src/durable/rate-limiter.ts`) reemplaza KV check-then-act con contador atómico por `tenantId:channel` persistido en DO storage. Binding `RATE_LIMITER` en `wrangler.jsonc` + migración `v2`. `acquireRateSlot` en consumidor lanza `DeferredError` con `retryAfter` correcto.
- [x] **Observabilidad (structured logging + OpenTelemetry traces)**: Logger extendido con `TraceContext` (W3C traceparent), `generateTraceId/spanId`, `extract/injectTraceContext`, `traceMiddleware` en Hono. Traza propagada en `fetch` → `queue` → `scheduled`. Tracer spans en `processCase` (por canal), `dispararHoy` (por caso encolado), crons (por tenant). Queue messages incluyen `traceId`/`spanId`. Logs JSON con `traceId`/`spanId` para correlación completa.

## Verificación realizada

| Qué | Cómo | Resultado |
|---|---|---|
| Suite unitaria | `npm test` (13 archivos) | 187/187 |
| Estilo y tipos | `npm run lint` · `npm run typecheck` | limpios |
| Build del worker | `npm run build:worker` | limpio |
| Migraciones | `wrangler d1 migrations apply --local` (BD nueva) | 6 migraciones OK; esquema igual al que lee el código |
| Foreign keys | insert con `tenant_id` inexistente | `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Backfill multi-tenant | `SELECT` sobre `tenants` y `tenant_accounting_map` | 1 tenant, 12 reglas contables copiadas |
| Identidad por tenant | test de dos tenants con razón social distinta | cada uno firma con la suya; sin herencia de la plataforma |
| Resolución de tenant | test con `tenants` inexistente | sin tenant explícito → tenant de respaldo (`t_arkangel`); con tenant explícito → 404, no hereda la config |
| Enrutado del inbound | test de routing id por canal | WhatsApp/SMS/email se atribuyen al tenant de su `provider_account_id` |
| Dedupe en la transición | test de `reserveOnceConLegado` | una reserva legacy viva bloquea la nueva: no se reinicia la ventana |
| SQL contable | queries reales contra D1 local | ingreso reconoce sólo `delivered`/`read`; `sent` excluido |
| Transporte MCP | servidor HTTP real (`tests/alegraMcp.test.ts`) | handshake, SSE, cache de sesión, mapeo de errores |
| Auth por sesión (Clerk) | test de `tests/authClerk.test.ts` (se sustituye `sessionVerifier.fn`, sin red) | Organization mapeada → tenant de esa Organization + rol de D1; usuario sin fila en `tenant_users` → 401 `sin_acceso` (no cae al token); Organization sin tenant → 401 `org_sin_tenant`; cabecera de otro tenant → 403 `tenant_mismatch` |
| Scopes por ruta | test de la guardia en cada router | sin credencial → 401 `unauthorized`; con credencial pero scope insuficiente → 403 `forbidden` + `scope`; un `viewer` lee casos pero no despacha |
| **Aislamiento multi-tenant** | test de dos tenants accediendo a `/cases/:id` del otro | 403 `tenant_mismatch` en lectura por id; cada tenant ve solo sus datos |
| **Rate limiter DO** | test de burst concurrente 100 req/tenant+canal | ≤ `rateLimitRpm` por minuto, sin race conditions |
| **Trace propagation** | request → queue consumer → scheduled cron | mismo `traceId` en logs de toda la cadena; `spanId` único por operación |

## Deuda técnica y riesgos abiertos

### Multi-tenant (pendiente por fase)

- **Fase 4 completada**: `tenant_id` en todas las tablas de negocio + propagación de `ctx` a servicios + prefijo en R2/DO. **Se puede dar de alta un segundo cliente.**
- **Fase 5 (parcial)**: webhooks resuelven tenant por `provider_account_id`; falta firma de Meta en POST.
- **Fase 6**: contabilidad por tenant (Alegra propio, `tenant_accounting_map`, idempotency key con tenant, ledger por tenant).

### Configuración Clerk (Fase 3 operativa)

- **Clerk todavía no está configurado en este entorno.** Falta `npx -y clerk@latest auth login` (el login del Dashboard no autentica el CLI) y las claves: `CLERK_SECRET_KEY` (secret), `CLERK_PUBLISHABLE_KEY` y `CLERK_AUTHORIZED_PARTIES` (vars de `wrangler.jsonc`), `CLERK_JWT_KEY` (secret, opcional: verificación de JWT sin red) y `VITE_CLERK_PUBLISHABLE_KEY` (`frontend/.env.local`). Sin `CLERK_SECRET_KEY`, `clerkActivo(env)` devuelve `false` y el Worker sigue operando con los tokens de máquina.
- **Falta dar de alta el primer usuario y mapear la Organization.** Estar en la Organization de Clerk **no basta**: el rol lo concede D1. Sin fila en `tenant_users` (rol dentro del tenant) ni en `platform_users` (admin de plataforma) toda sesión de Clerk responde 401 (`sin_acceso` u `org_sin_tenant`). También falta el mapeo `tenants.clerk_org_id` → `Organization.id` de Clerk.
- **La allowlist de dominios y la ventana horaria del módulo contable** siguen viniendo de `env.TZ` (Fase 6).
- **Un tenant en `config_mode='platform_env'` hereda la config del Worker.** Hoy sólo lo usa el tenant heredado. Para pasarlo a `db` hay que cargar su fila (razón social y CONDUSEF incluidos) y ejecutar: `UPDATE tenants SET config_mode='db' WHERE id='t_arkangel';` Sin razón social, el motor legal bloquea todos sus mensajes (regla 1.1, fail-closed) y el worker lo avisa por log.
- **La migración 0004 debe aplicarse ANTES de desplegar el worker.** Si la tabla `tenants` no existe, el worker cae al tenant de respaldo con la config del entorno (sin regresión), pero el multi-tenant no queda habilitado. El respaldo usa el id `t_arkangel`, el mismo que crea el backfill, para que el namespace de claves de KV no cambie al aplicar la migración.

### Preexistentes

- **El contrato MCP con Alegra es una suposición**: nombres de tool (`alegra.list_accounts`, `alegra.create_journal_entry`, `alegra.list_journal_entries`), forma de los argumentos (`partidas` debe/haber) y formatos de respuesta **nunca se han validado contra el servidor real**. El ajuste está aislado en `src/contabilidad/alegraClient.ts`.
- **Cuentas contables sin validar** contra el catálogo real de Alegra. El runtime cae a `5101-004` con warning accionable, pero el mapa hay que corregirlo.
- **Desfase de huso horario entre crons**: `"0 6 * * *"` dispara a las 06:00 UTC = **00:00 CDMX**, no a las 6 AM (los triggers de Cloudflare son UTC). El cron contable sí está anclado a CDMX (05:59 UTC). Conviene alinear el de cobranza.
- **Publicación contable T+1**: el corte publicado a las 23:59 CDMX es el día hábil anterior (decisión del code review). Confirmar con el contador.
- **`iva_acreditable_estimado`** es un cálculo provisional sobre gastos de Arkangel; hay que sustituirlo por el IVA acreditable real cuando exista el módulo de CFDI de proveedores.
- **`promise_made`** está reservado en `ESTADOS_INGRESO_RECONOCIDO` pero nada lo escribe: las promesas viven en la tabla `promises`.
- **Sin CI**: no hay `.github/workflows`. `npm run verify` corre format, lint, typecheck, test y build, pero sólo en local.

## Próximos (por riesgo)

1. **Configurar Clerk en el entorno**: `npx -y clerk@latest auth login`, las claves (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY`, `CLERK_AUTHORIZED_PARTIES`, `VITE_CLERK_PUBLISHABLE_KEY`), la migración 0005 en remoto, el mapeo `tenants.clerk_org_id` → Organization y el alta del primer usuario en `tenant_users` / `platform_users`. La Fase 3 está en código pero no operativa hasta que esto esté hecho.
2. **Cargar la fila de `t_arkangel`** (razón social + CONDUSEF) y pasarla a `config_mode='db'`.
3. **Fase 5** — firma de Meta en POST (el enrutado por tenant ya está).
4. **Fase 6** — contabilidad por tenant (Alegra propio, mapa de cuentas por cliente).
5. **Ensayo end-to-end** con un Alegra de pruebas + cerrar el contrato MCP.
6. **Secretos + bucket R2 + migraciones 003/004/005/006 en remoto**; primera corrida real.
7. **Alinear el cron de cobranza** con el huso CDMX.
8. **CI en GitHub Actions** (`npm run verify`).
