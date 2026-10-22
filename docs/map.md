# ARKANGEL — Mapa del proyecto y bitácora de sprints

> **Estado**: `main` · 247 tests verdes · lint + typecheck + build limpios.
> Última actualización: 2026-10-22 (mini-spike latencia: streaming LLM + modelo 8B + prompt voz implementados; **falta plan de pago Workers AI** para medir p50/p95 reales).

## Vista general

Worker Cloudflare (Hono/TS) de cobranza asistida por IA sobre WhatsApp/SMS/Email.
D1 + KV + Queues + Durable Objects + R2. Workers AI (Llama 3.3) con fallback
heurístico. Motor legal fail-closed (12 reglas). Scoring Sherman v2. Dashboard
"1 botón · 0 tablas". Módulo contable: `legal_audit` → asientos → Alegra (MCP).
**Multi-tenant completo en datos**: `tenant_id` en todas las tablas de negocio (Fase 4),
identidad nativa en D1, config por tenant (Fase 2), catálogo de tenants (Fase 1).

## Estructura

```
src/
├── index.ts                 entry, routing, dispatch de cron (6 AM cobranza / 23:59 CDMX contable)
├── routes/                  health · ingest · api · webhooks · agent (Grok Bot) · contabilidad ·
│                            autenticacion (login/register/logout/session) · guard (scope por
│                            ruta) · tenant (contexto) · auth (cabeceras)
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
├── auth/                    native (PBKDF2, sesiones, membresías) · middleware (sesión +
│                            membresía) · guards (principal + scope) · scopes (catálogo) ·
│                            principal
├── durable/                 call-lock
├── lib/                     crypto, csv, http, idempotencia, logger, money, phone, score
└── types/                   env, cobranza
frontend/                    React + Vite (dashboard) + AuthProvider/AuthGate
│                            (frontend/src/auth/: AuthContext · AuthGate)
design-system/               tokens + componentes reutilizables
migrations/                  0001_init · 0002_legal · 0003_alegra_sync · 0004_tenants ·
│                             0005_clerk_auth · 0006_tenant_isolation · 0007_native_auth ·
│                             0008_drop_clerk
scripts/                     seed.sql, seed-owner.ts, forge_arkangel_watermark.py
docs/                        arquitectura.md · map.md · runbook-cobranza.md
tests/                       13 archivos (unit + auth nativa + transporte MCP sobre HTTP real)
```

## Endpoints

Auth = sesión nativa (cookie `ark_session`) o token de máquina.
Cada ruta exige **su** scope: sin credencial → 401, con credencial pero sin scope → 403.

| Método | Ruta | Scope | Descripción |
|---|---|---|---|
| POST | `/api/auth/register` | — | **Cerrado** (403 `registro_cerrado`): el panel es por invitación; altas con `seed-owner` |
| POST | `/api/auth/login` | público | Verifica la contraseña (PBKDF2) y emite la cookie `ark_session` |
| POST | `/api/auth/logout` | sesión | Revoca la sesión en D1 y borra la cookie |
| GET | `/api/auth/session` | público | Usuario y despachos, si la cookie es válida |
| POST | `/api/auth/request-password-reset` | público | Envía el enlace de restablecimiento (siempre 202) |
| POST | `/api/auth/reset-password` | público | Consume el enlace y fija la nueva contraseña |
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

La sesión humana viaja en la cookie `ark_session` (`HttpOnly`, `SameSite=Lax`,
30 días). `X-Tenant-Id` **selecciona** entre los despachos del usuario: pedir
uno del que no es miembro es 403 `tenant_forbidden`, no un cambio de alcance.

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
| `tenants` | **Catálogo de clientes**: razón social, CONDUSEF, ventana, límites, modo de config |
| `tenant_channels` | Enrutado y credenciales por canal (phone_number_id, messaging_profile_id, dominio) |
| `tenant_accounting_map` | Mapa regla legal → cuentas contables, por tenant |
| `users` | Identidad humana: correo, hash PBKDF2, rol de plataforma |
| `tenant_memberships` | **Rol** del usuario dentro de cada despacho (`owner`/`admin`/`member`) |
| `auth_sessions` | Sesiones activas: `token_hash` (SHA-256), caducidad y revocación |
| `auth_tokens` | Tokens de un solo uso (restablecer contraseña) |
| `auth_rate_limits` | Ventana de intentos de acceso por correo e IP |

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
- [x] **Multi-tenant Fase 4 (tenant_id en tablas de negocio)**: Migración `0006_tenant_isolation.sql` añade `tenant_id` a 17 tablas (`cases`, `clients`, `debts`, `messages`, `promises`, `events`, `contracts`, `legal_audit`, `intakes`, `alegra_sync`, `alegra_journal_lines`, `contract_cfdi`, `ledger_checkpoint`, `tenant_accounting_map`, `tenant_channels`, `tenant_users`, `platform_users`) con índices compuestos `(tenant_id, ...)`. Todos los servicios (`casos`, `clientes`, `deudas`, `mensajes`, `promesas`, `contratos`, `legalAudit`, `eventos`, `metricas`, `ingesta`) actualizados a `TenantContext`. Contabilidad, crons, rutas y orquestación propagan el contexto. *(Las dos últimas tablas de esa lista, `tenant_users` y `platform_users`, quedaron después sustituidas por `tenant_memberships` y `users.platform_role` en el Sprint 5.)*
- [x] **Rate Limiter distribuido (Durable Object)**: `RateLimiterDO` (nuevo `src/durable/rate-limiter.ts`) reemplaza KV check-then-act con contador atómico por `tenantId:channel` persistido en DO storage. Binding `RATE_LIMITER` en `wrangler.jsonc` + migración `v2`. `acquireRateSlot` en consumidor lanza `DeferredError` con `retryAfter` correcto.
- [x] **Observabilidad (structured logging + OpenTelemetry traces)**: Logger extendido con `TraceContext` (W3C traceparent), `generateTraceId/spanId`, `extract/injectTraceContext`, `traceMiddleware` en Hono. Traza propagada en `fetch` → `queue` → `scheduled`. Tracer spans en `processCase` (por canal), `dispararHoy` (por caso encolado), crons (por tenant). Queue messages incluyen `traceId`/`spanId`. Logs JSON con `traceId`/`spanId` para correlación completa.

### Sprint 5 — Identidad nativa en D1 (fin del proveedor externo) (2026-10-21)

La identidad ya no depende de un SaaS: la contraseña se verifica con PBKDF2
dentro del Worker y la sesión es un token aleatorio que D1 guarda **hasheado**.

- [x] **Migración `0007_native_auth.sql`**: `users`, `tenant_memberships`,
      `auth_sessions`, `auth_tokens` y `auth_rate_limits` (mismo esquema que
      Ark Ledger, para que el `seed-owner.ts` sirva a los dos proyectos).
- [x] **Migración `0008_drop_clerk.sql`**: fuera `tenants.clerk_org_id`,
      `tenant_users` y `platform_users`. Los admins de plataforma pasan a ser
      `users.platform_role = 'super_admin'`.
- [x] **`src/auth/native.ts`**: PBKDF2 (SHA-256, 25 000 iteraciones, sal de 16
      bytes), `createSession`/`validateSession`/`revokeSession`, tokens de un
      solo uso, rate limiting por correo e IP, traducción del rol
      (`ROLE_POR_MEMBRESIA`: owner→owner, admin→operator, member→viewer).
- [x] **`src/auth/middleware.ts`**: `authenticateRequest` (resuelve la sesión
      una vez por petición y la adjunta al contexto) y `requireTenantMembership`
      (403 si el despacho pedido no es del usuario). Aplicados a `/api/v1/*`.
- [x] **`src/routes/autenticacion.ts`**: register · login · logout · session ·
      request-password-reset · reset-password.
- [x] **`src/auth/guards.ts`**: la rama de la sesión nativa sustituye a la de
      Clerk; una sesión válida **no** cae al token de máquina. Motivos de
      rechazo: `unauthorized` · `sin_membresia` · `tenant_forbidden`.
- [x] **Frontend**: `AuthContext.tsx` (bootstrap silencioso, sesión
      persistente, selector de despacho) y `AuthGate.tsx` (login ⇄ registro).
      `api.ts` manda `credentials: 'include'`; no queda ni un token en JS.
- [x] **`scripts/seed-owner.ts`**: alta del primer usuario (correo, contraseña,
      `tenant_id`, rol). Idempotente: si el correo ya existe, cambia la
      contraseña y actualiza la membresía.
- [x] **Limpieza**: fuera `@clerk/backend` y `@clerk/react`, las variables
      `CLERK_*`, `VITE_CLERK_PUBLISHABLE_KEY`, `tenants.clerk_org_id` y el
      `Tenant.clerk_org_id` del tipo. Cero referencias a Clerk en el código.
- [x] **Producción**: migraciones 0007/0008 aplicadas en D1 remoto, usuario
      owner dado de alta, worker y SPA redesplegados, flujo verificado
      (login → sesión → cambio de despacho → logout).
- [x] **Typecheck limpio** (partía de 136 errores) y **suite en verde** (partía
      de 25 tests rojos). Al cerrar los huecos aparecieron tres defectos
      preexistentes que también quedaron corregidos: `inbound.ts` y `agent.ts`
      pasaban `env` donde los servicios esperan `ctx: TenantContext` (aislamiento
      de tenant roto en el camino de entrada), `api.ts` usaba un `ctx` que no
      existía, y `SQL_LEER_LINEAS` ataba 3 parámetros contra 2 placeholders
      (un reintento de corte en Alegra devolvía el journal id de **otro**
      asiento y se saltaba de enviarlo).

### Bloques A/B/C + Tareas 0-2 — Cierre con CI real y spike de voz (2026-10-21)

- [x] **Bloque A · config por tenant (Fase 6)**: migración `0009`, índices
      compuestos por tenant, `assertTenantListoParaOperar()` fail-closed (sin
      razón social ni CONDUSEF el tenant en modo `db` no opera),
      `scripts/seed-tenant-config.ts` y 9 tests de config por tenant.
- [x] **Bloque C · cambio de contraseña**: `changePassword()` con política
      explícita — la contraseña nueva **debe ser distinta** de la actual (400)
      y una sesión revocada no puede cambiar la contraseña (401). El `status`
      viaja en el resultado en vez de deducirse del texto del mensaje.
- [x] **Tarea 0 · cuadre del conteo**: la suite de `changePassword` quedó con
      7 tests nuevos. Total: 207 + 7 = 232 (+ 7 del spike de voz = **239**).
- [x] **Tarea 2 · spike de voz (Bloque D)**: implementado y en CI (**PR #2 mergeado**,
      run 39688865320 verde). Código completo: `CallSessionDO`, pipeline STT→LLM→TTS con barge-in,
      signaling tras `SPIKE_VOZ_ENABLED`, cliente `spike/index.html`, arnés `scripts/spike-voz.ts` (20 llamadas),
      migración `0010_spike_calls.sql` con `tenant_id`. **EJECUTADO** (2026-10-22): 20 llamadas reales
      con el guion hablado de 3 turnos. La ruta de voz es **Workers AI** (`@cf/deepgram/nova-3` para STT
      y `@cf/deepgram/aura-2-es` para TTS, por WebSocket): misma casa (Deepgram), **sin cuenta nueva**;
      el cambio se hizo con confirmación explícita, no en silencio. El arnés es `npm run spike:voz`.
      p50/p95 medidos y veredicto en `docs/spike-voz.md`.
- [x] **Mini-spike latencia (2026-10-22)**: aplicadas 3 palancas al pipeline de voz:
  1. **Streaming LLM** (`runAIStream` + `redactMessageVozStream` en `src/ai/agent.ts`) — emite chunks conforme llegan.
  2. **Modelo chico** (`@cf/meta/llama-3.1-8b-instruct` via `DEFAULT_VOZ_MODEL` / `SPIKE_VOZ_MODEL`) — objetivo < 800 ms p95.
  3. **Prompt voz acortado** (`SYSTEM_REDACT_VOZ` en `src/ai/prompts.ts`) — ≤ 1 frase, ≤ 20 palabras, identificación de bot obligatoria.
  Pipeline `voice.ts` reescrito para lanzar TTS al primer fin de frase. **`npm run verify` verde (239 tests)**.
  **Bloqueante de medición**: la cuenta gratuita de Workers AI (10 000 neuronas/día) agotó antes de completar las 10 llamadas de prueba. **Requiere plan de pago** (cuesta centavos/día) para repetir el arnés y obtener p50/p95 reales.

## Verificación realizada

| Qué | Cómo | Resultado |
|---|---|---|
| Suite unitaria | `npm test` (14 archivos) | 239/239 |
| Estilo y tipos | `npm run lint` · `npm run typecheck` | limpios |
| Build del worker | `npm run build:worker` | limpio |
| Migraciones | `wrangler d1 migrations apply --local` (BD nueva) | 8 migraciones OK; esquema igual al que lee el código |
| Foreign keys | insert con `tenant_id` inexistente | `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Backfill multi-tenant | `SELECT` sobre `tenants` y `tenant_accounting_map` | 1 tenant, 12 reglas contables copiadas |
| Identidad por tenant | test de dos tenants con razón social distinta | cada uno firma con la suya; sin herencia de la plataforma |
| Resolución de tenant | test con `tenants` inexistente | sin tenant explícito → tenant de respaldo (`t_arkangel`); con tenant explícito → 404, no hereda la config |
| Enrutado del inbound | test de routing id por canal | WhatsApp/SMS/email se atribuyen al tenant de su `provider_account_id` |
| Dedupe en la transición | test de `reserveOnceConLegado` | una reserva legacy viva bloquea la nueva: no se reinicia la ventana |
| SQL contable | queries reales contra D1 local | ingreso reconoce sólo `delivered`/`read`; `sent` excluido |
| Transporte MCP | servidor HTTP real (`tests/alegraMcp.test.ts`) | handshake, SSE, cache de sesión, mapeo de errores |
| Auth por sesión (nativa) | test de `tests/authNative.test.ts` (D1 de mentira, sin red) | cookie válida → principal del usuario con su membresía; cabecera `X-Tenant-Id` de otro despacho → 403 `tenant_forbidden`; usuario sin membresías → 401 `sin_membresia`; sesión válida no cae al token de máquina |
| Scopes por ruta | test de la guardia en cada router | sin credencial → 401 `unauthorized`; con credencial pero scope insuficiente → 403 `forbidden` + `scope`; un `viewer` lee casos pero no despacha |
| **Aislamiento multi-tenant** | test de dos tenants accediendo a `/cases/:id` del otro | 403 `tenant_mismatch` en lectura por id; cada tenant ve solo sus datos |
| **Rate limiter DO** | test de burst concurrente 100 req/tenant+canal | ≤ `rateLimitRpm` por minuto, sin race conditions |
| **Trace propagation** | request → queue consumer → scheduled cron | mismo `traceId` en logs de toda la cadena; `spanId` único por operación |
| **Hash de contraseña** | test de `src/auth/native.ts` | PBKDF2 con 25 000 iteraciones y sal de 16 bytes; la misma contraseña sale con distinta sal; un hash mal formado no verifica |
| **Sesión nativa** | test de `tests/authNative.test.ts` (D1 de mentira) | en D1 sólo se guarda el SHA-256 del token; cookie inválida o sesión revocada no dan sesión |
| **Ciclo de vida en producción** | `curl` contra el worker desplegado | login 200 + `Set-Cookie`; `session` 200; logout 200 y la cookie deja de servir; sin cookie → 401; despacho ajeno → 403 |
| **CI en GitHub Actions** | 4 runs reales (`push` y `pull_request` a `main`) | PR #1 (run 39684812269, 38 s), push a `main` (39685011657, 33 s), PR #2 (39688865320, 33 s), push a `main` (39689054239, 31 s): los cuatro verdes |
| **Spike de voz** | 25 tests de `tests/spikeVoz.test.ts` + **20 llamadas reales** (`npm run spike:voz`) | percentiles (nearest rank), DO (estado, métricas, barge-in, cierre), credenciales de voz y pipeline con dobles; y la corrida real: **16/20 llamadas con turnos medidos (32 turnos)** — `round_trip_ms` p50 2525 ms / **p95 3914 ms** (criterio < 1500 ms → **NO-GO por latencia**), `stt_final_ms` p50 1680 ms, `tts_first_chunk_ms` p50 799 ms. El LLM sin streaming se come el round-trip. Las 4 llamadas restantes chocaron con el tope de 10 000 neuronas/día de Workers AI |
| **Mini-spike latencia** | `npm run verify` (239 tests) + código listo; arnés ejecutado pero **truncado por cuota gratuita** | 3 palancas aplicadas (streaming LLM, modelo 8B, prompt voz ≤20 palabras). **Falta: activar plan de pago Workers AI** y repetir `SPIKE_LLAMADAS=20 npm run spike:voz` para p50/p95 reales y veredicto definitivo. |

## Deuda técnica y riesgos abiertos

### Multi-tenant (pendiente por fase)

- **Fase 4 completada**: `tenant_id` en todas las tablas de negocio + propagación de `ctx` a servicios + prefijo en R2/DO. **Se puede dar de alta un segundo cliente.**
- **Fase 5 (parcial)**: webhooks resuelven tenant por `provider_account_id`; falta firma de Meta en POST.
- **Fase 6**: contabilidad por tenant (Alegra propio, `tenant_accounting_map`, idempotency key con tenant, ledger por tenant).

### Identidad (nativa, sin proveedor externo)

- **La identidad ya no depende de nadie.** Contraseña con PBKDF2 (SHA-256, 25 000 iteraciones) verificada dentro del Worker; la sesión es un token aleatorio que D1 guarda **hasheado** (`auth_sessions.token_hash`) y que en el navegador viaja sólo en la cookie `ark_session` (`HttpOnly`, `SameSite=Lax`, 30 días).
- **Ya hay usuario owner en el entorno remoto** (`substrateholdingsai@gmail.com`, con membresía `owner` en `t_arkangel` y `admin` en `t_ark_systems`). Para dar de alta a otro: `npm run seed:owner:remote -- --email ... --password ... --tenant t_xxx --role owner`. Sin usuarios, el panel devuelve 401 y sólo funcionan los tokens de máquina.
- **El rol lo concede la membresía, no la cabecera.** `tenant_memberships` es la fuente de verdad (`owner` → `owner`, `admin` → `operator`, `member` → `viewer`; tabla `ROLE_POR_MEMBRESIA` en `src/auth/native.ts`). `X-Tenant-Id` sólo *selecciona* entre las membresías del usuario: pedir un despacho ajeno es 403 `tenant_forbidden`.
- **Registro público cerrado** (2026-10-22): `POST /api/auth/register` → 403. Altas sólo con `seed-owner`.
- **Restablecer contraseña por correo** (2026-10-22): `src/auth/email.ts` envía por Resend desde `AUTH_FROM_EMAIL` (`auth@arksystems.site`, dominio verificado) con enlace a `APP_URL` (`https://arkangel.arksystems.site/?auth=restablecer&token=…`). El envío corre en `waitUntil` (misma 202 exista o no la cuenta), el hash se calcula antes de consumir el token y el reset marca el correo como verificado. Pantallas "¿Olvidaste tu contraseña?" y "Nueva contraseña" en `AuthGate.tsx`. Secret `RESEND_API_KEY` cargado.
- **Pendiente auth**: PBKDF2 25 000 → 100 000 con rehash en login; invitaciones por correo; rotar la API key de Resend.
- **El cambio de contraseña ya está en el panel** (`POST /api/auth/change-password`): valida la actual, aplica la política de la nueva, revoca todas las sesiones y limpia la cookie. La nueva debe ser **distinta** de la actual (400) y una sesión revocada no puede cambiar la contraseña (401).
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
- **Sin CI**: no hay `.github/workflows`. `npm run verify` corre format, lint, typecheck, test y build, pero sólo en local. → **Resuelto**: `.github/workflows/ci.yml` está en `main` y corre en GitHub Actions (PR #1, run verde).
- **Spike de voz: requiere plan de pago Workers AI** para medir latencia real. La cuenta gratuita (10 000 neuronas/día) no permite completar 20 llamadas. Sin plan de pago, el veredicto definitivo de latencia (GO / GO CONDICIONADO / NO-GO) no puede emitirse.

## Próximos (por riesgo)

1. **[x] Cambio de contraseña en el panel** — implementado en `POST /api/auth/change-password` (valida la actual, aplica política de la nueva, revoca todas las sesiones y limpia la cookie).
2. **Activar plan de pago Workers AI** y repetir `SPIKE_LLAMADAS=20 npm run spike:voz` — bloquea la medición de latencia real (cuota gratuita 10 k neuronas/día agotada).
3. **Cargar la fila de `t_arkangel`** (razón social + CONDUSEF) y pasarla a `config_mode='db'`.
4. **Fase 5** — firma de Meta en POST (el enrutado por tenant ya está).
5. **Fase 6** — contabilidad por tenant (Alegra propio, mapa de cuentas por cliente).
6. **Ensayo end-to-end** con un Alegra de pruebas + cerrar el contrato MCP.
7. **Secretos + bucket R2 + primera corrida real** (las migraciones 003/004/005/006/007/008 ya están en remoto).
8. **[x] Alinear el cron de cobranza** con el huso CDMX — `wrangler.jsonc` pasó de `"0 6 * * *"` (06:00 UTC = 00:00 CDMX) a `"0 12 * * *"` (12:00 UTC = 6 AM CDT).
9. **[x] CI en GitHub Actions** — `.github/workflows/ci.yml` corre `npm run verify` (format, lint, typecheck, test, build) en `push` y `PR` a `main`.
10. **[x] Ejecutar el spike de voz** — **hecho** (2026-10-22): 20 llamadas con `npm run spike:voz`, p50/p95 medidos. Veredicto **NO-GO por latencia** (round-trip p95 3914 ms vs 1500 ms), a causa del LLM sin streaming; el ajuste es `agent.ts` con streaming. Detalle en `docs/spike-voz.md`.
