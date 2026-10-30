# ARKANGEL — Mapa del proyecto y bitácora de sprints

> **Estado**: `main` · **34 suites / 422 tests verdes** (incluye Motor de Comunicación Multi-Marca, aislamiento estricto de dominios, suite REPEP PROFECO SHA-256 edge, TrunkGovernorDO con 30 DPS y arbitraje de cobranza, arnés E2E de 10 contactos, suite forense Hermes-flare y arnés de regresión de voz) · lint + typecheck + build limpios · desplegado en `https://arkangel.arksystems.site`.  
> Última actualización: **2026-10-29** (Sprints 16–18 completados al 100%: Motor de Comunicación, Contrato CAMPAIGN_DISPATCH_V1, FrequencyCapDO, CampaignRunnerDO, REPEP PROFECO 35 días, TrunkGovernorDO 30 DPS/concurrencia, bolsa de consumo `usage_events`, opt-out automático y jerarquía cámara → socio en migraciones 0017, 0018 y 0019).

---

## 1. Vista general y nuevos paradigmas

Arkangel es una plataforma de cobranza agéntica, omnicanal y de certeza procesal ejecutada en el edge sobre **Cloudflare Workers (Hono/TypeScript)** con stack desacoplado:
* **Almacenamiento y Eventos**: Cloudflare D1 (SQLite distribuido) + KV (caché distribuida) + Queues (despacho asíncrono) + Durable Objects (rate limiter por tenant/canal y gestión de estados de llamadas) + R2 (almacenamiento de cortes y evidencias).
* **Inteligencia Artificial Dual**:
  * Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) para redacción asistida, clasificación de intenciones y Copilot del operador.
  * **Telnyx Voice AI Assistants**: Telefonía saliente PSTN a números móviles y fijos de México (+52), cota y objetivo de diseño < 800 ms de latencia conversacional (medición formal en producción en curso), Answering Machine Detection (AMD hardware), grabación estéreo dual-channel (apagada por defecto / opt-in) y puenteo en caliente a humanos (`call.bridge`).
* **Protocolo A2A (Agent-to-Agent Collections)**: Servidor MCP JSON-RPC 2.0 (`/api/v1/a2a/mcp`) y endpoints REST para negociación autónoma programática entre agentes deudores de IA y el despacho, con verificación estricta de secreto financiero (Reglas CONDUSEF 4.1 y 4.2) y quitas algorítmicas deterministas.
* **Portal de Autoservicio del Deudor**: Riel público `/pay/:id` con desglose de quita, **1-Click SPEI Checkout** (resolución automática de banco receptor STP/BBVA/Banamex/etc.) y emisión digital de Carta Convenio y Carta Finiquito con sello SHA-256 (Art. 112 Bis LFPC).
* **Certeza Jurídica & Prueba Plena (NOM-151 + ATEB PSC)**:
  * Motor de Constancias Digitales NOM-151-SCFI-2016 con hash determinista SHA-256 de mensajes de datos.
  * **Conector Dual-Engine ATEB PSC**: Modo A (Cumplimiento Pleno Oficial con estampillas RFC 3161 TSA y constancias ASN.1 DER del PSC acreditado por la Secretaría de Economía) y Modo B (Evidencia Interna Preparada para Migración con failover resiliente).
  * **Custodia WORM interna (bitácora encadenada `worm_audit_log`, retención 10 años Art. 49 CCom)** como evidencia preparada para migración; la constancia NOM-151 plena se obtiene al conmutar a Modo A con ATEB PSC (ver §8, Frontera Activa #1).
  * **Cuaderno Procesal Judicial & Carpeta SAT**: Expediente foliado descargable e imprimible para Juicios Ejecutivos y Orales Mercantiles (Art. 1298-A CCom) con liquidación de saldo e intereses moratorios calculados al 6% anual (Art. 362 CCom) y materialidad fiscal probatoria ante el SAT (Arts. 29-A y 69-B CFF, y deducción de incobrables Art. 27 Fracc. XV LISR). El expediente distingue expresamente mediante distintivos visuales los folios timbrados en Modo A (Oficial ATEB PSC) de los generados en Modo B (Evidencia Interna Presuntiva).
* **Plano 2: Alta Inteligencia Forense con Agente Hermes en Cloudflare Sandboxes (`hermes-flare`)**:
  * **Separación de Planos de Cómputo**: Desacoplamiento arquitectónico entre Plano 1 (Edge V8 Isolates, transaccional, latencia < 50 ms) y Plano 2 (Firecracker microVMs aisladas vía `@cloudflare/sandbox`, Python 3.11, Nous Research Hermes Agent, trabajos de 30s a 15 min).
  * **Skip-Tracing Patrimonial**: Cruce autónomo de RPPC, boletines judiciales y SAT para dictamen clasificado de solvencia (`Clase A: Solvente con bienes inscritos`, `Clase B: Flujo bancario`, `Clase C: Insolvente`).
  * **Peritaje de Materialidad SAT**: Escrutinio masivo de CFDIs contra listas negras EFOS (Art. 69-B CFF) y validación matemática de deducibilidad para ISR conforme al Art. 27 Fracción XV de la LISR.
  * **Síntesis del Cuaderno Judicial Mercantil**: Redacción pericial estructurada de hechos y agravios (Art. 1298-A CCom) y liquidación automatizada de intereses moratorios al 6% anual legal (Art. 362 CCom).
  * **Persistencia Episódica & Bitácora WORM**: Snapshots de `/home/hermes` en Cloudflare R2 (`HERMES_MEMORY_BUCKET`) y sellado inmutable en `worm_audit_log` bajo `hermes_forensic_opinion` / `hermes_agent`.
* **Motor Legal Fail-Closed**: Auditoría estricta de 12 reglas / 48 conductas prohibidas (CONDUSEF / REDECO / NOM-184 / LFPC / Código Penal Federal).
* **Scoring Sherman v2**: Algoritmo de propensión de pago y priorización de cartera con calibración continua.
* **Módulo Contable (Alegra MCP)**: Reconciliación contable en dos fases, idempotencia criptográfica y publicación diaria en R2 y Alegra.
* **Multi-Tenant Total**: Aislamiento estricto de datos con `tenant_id` en todas las tablas, RBAC en tres roles (`owner`, `admin`/operador, `member`/auditor), catálogo contable por despacho y consola de configuración self-serve.

---

## 2. Estructura del repositorio

```
src/
├── index.ts                 Entry point, routing global, triggers de cron (6:00 AM CDMX cobranza / 23:59 CDMX contable)
├── routes/                  
│   ├── health.ts            Health check (/api/v1/health) y liveness del worker
│   ├── ingest.ts            Ingesta de carteras CSV multipart o JSON (/api/v1/ingest/csv)
│   ├── api.ts               Core API: casos, softphone, llamadas, notas, CFDI, conciliación, métricas, copilot, tenants
│   ├── hermes.ts            Endpoints forenses Hermes (/api/v1/hermes/*): skip-trace, peritaje SAT 69-B y síntesis judicial
│   ├── nom151.ts            Constancias NOM-151, emisión, verificación judicial pública, bitácora WORM, cuaderno procesal y config ATEB PSC
│   ├── portal.ts            Portal público de autoservicio del deudor (/api/v1/portal/*, /pay/:id, cartas finiquito)
│   ├── a2a.ts               Protocolo Agent-to-Agent: auth con secreto financiero, negociación de quitas y servidor MCP JSON-RPC 2.0
│   ├── webhooks.ts          Recepción y validación criptográfica (Telnyx Ed25519, Meta HMAC-SHA256, Resend, Conekta RSA, Cobre HMAC, opt-out automático)
│   ├── agent.ts             Endpoints agénticos del Grok Bot (/api/v1/state, /decide, /dispatch, /audit, /classify, /calibrate)
│   ├── contabilidad.ts      Corte contable diario y resumen para auditoría (/api/v1/contabilidad/resumen)
│   ├── comunicacion.ts      Endpoints de marketing y avisos (/comunicacion/preview, /campaigns, /pause, /repep/upload, /repep/status)
│   ├── autenticacion.ts     Auth nativa (login, logout, session, request-password-reset, reset-password, change-password)
│   ├── guard.ts             Guardias de seguridad y validación de scopes por rol
│   ├── tenant.ts            Resolución de contexto multitenant
│   ├── auth.ts              Helpers de autenticación y cabeceras
│   └── spike.ts             Rutas de benchmarking experimental (archivado)
├── comunicacion/            Motor de Marketing y Comunicación General (multi-marca, anti-spam, fail-closed)
│   ├── tipos.ts             Tipos, categorías, propósitos, canales y motivos de exclusión
│   ├── reglas.ts            Catálogo de 6 reglas anti-spam y argumentos de valor pro-negocio
│   ├── horarios.ts          Quiet hours 21:00-08:00 local time, zonas horarias de México y cálculo de siguiente apertura
│   ├── plantillas.ts        Interpolación de variables, inyección obligatoria de marca y componentes Meta HSM
│   ├── motorMarketing.ts    Función principal evaluarEnvio(ctx) con evaluación secuencial fail-closed
│   └── contrato.ts          Esquema Zod estricto CAMPAIGN_DISPATCH_V1 para contrato entre Ark Sales CRM y Arkangel
├── services/                
│   ├── hermesForensics.ts   Orquestador de Plano 2: Skip-tracing patrimonial, peritaje SAT (Arts. 29-A/69-B CFF/27-XV LISR) y síntesis judicial
│   ├── casos.ts             Gestión del ciclo de vida de casos (ready, queued, contacted, promised, paid, escalated, dnd)
│   ├── clientes.ts          Directorio de titulares deudores, teléfonos E.164, CURP y RFC
│   ├── deudas.ts            Obligaciones financieras, saldos pendientes y fechas de vencimiento
│   ├── contratos.ts         Contratos base, razones sociales, cuentas CLABE de 18 dígitos y registro REDECO
│   ├── mensajes.ts          Bitácora omnicanal de mensajes (WhatsApp, SMS, Email, Softphone)
│   ├── promesas.ts          Registro y cómputo de promesas de pago (IA, Softphone, A2A, Portal)
│   ├── metricas.ts          Cómputo en tiempo real de KPIs diarios (incluyendo llamadas y minutos Voice AI)
│   ├── pagos.ts             Motor de conciliación canónica de pagos (Conekta, Cobre, extracto bancario CSV)
│   ├── legalAudit.ts        Ledger criptográfico append-only de cumplimiento legal y reglas CONDUSEF
│   ├── eventos.ts           Trazabilidad de auditoría unificada de plataforma
│   ├── ingesta.ts           Procesamiento y saneamiento de archivos CSV de carteras
│   ├── nom151.ts            Motor criptográfico de constancias digitales NOM-151-SCFI-2016 y hashing SHA-256
│   ├── atebPscClient.ts     Cliente WebService SOAP/REST para ATEB Servicios PSC (Modo A oficial / Modo B presuntivo)
│   ├── custodyWorm.ts       Bitácora de custodia inmutable encadenada WORM (retención a 10 años Art. 49 CCom)
│   ├── judicialDocket.ts    Generador de Cuaderno Procesal Judicial (Art. 1298-A CCom) y Carpeta Fiscal SAT (Arts. 29-A, 69-B CFF, 27-XV LISR)
│   ├── debtorPortal.ts      Lógica de consulta, cálculo de quitas y emisión de finiquitos para deudores
│   ├── a2a.ts               Lógica de secreto financiero, evaluación de ofertas y convenios entre agentes
│   ├── comunicacion.ts      Gestión D1 de consentimientos, supresiones, plantillas y detección de cobranza activa
│   ├── repep.ts             Ingesta y verificación REPEP PROFECO: hashes SHA-256 en edge y vigencia fail-closed 35 días
│   ├── arkLedgerWebhook.ts  Notificaciones asíncronas de eventos hacia Ark Ledger
│   └── db.ts                Helpers y tipos para consultas en Cloudflare D1
├── orquestacion/            Disparador de cartera, consumidor de cola Cloudflare Queues, inbound y orquestador
├── legal/                   Motor legal fail-closed, catálogo de 12 reglas, sanitizador y tipos legales
├── ai/                      Agente LLM Workers AI, streaming, clasificación de intenciones, copilot y prompts
├── channels/                
│   ├── whatsapp.ts          Adaptador WhatsApp Business vía Telnyx API v2 con validación Ed25519 y plantillas HSM
│   ├── telnyx.ts            Adaptador SMS transaccional con palabras clave de opt-out (STOP/BAJA)
│   ├── telnyxVoice.ts       Telefonía PSTN Call Control v2, Voice AI Assistants, AMD, gobernanza de troncal y bridging
│   ├── resend.ts            Adaptador de correo electrónico transaccional y reportes
│   ├── conekta.ts           Integración de pasarela SPEI / OXXO Pay con órdenes de CLABE dinámica
│   ├── cobre.ts             Integración de pagos B2B corporativos vía rieles SPEI
│   ├── diagnostics.ts       Diagnóstico interactivo de conectividad y handshake de canales con telemetría
│   └── types.ts             Interfaces comunes de adaptadores
├── cron/                    Crons programados: manana.ts (cobranza 6 AM CDMX), contabilidadDaily.ts (23:59 CDMX), reconciliacion.ts
├── contabilidad/            buildPayload, sendToAlegra, alegraClient (MCP JSON-RPC 2.0 / SSE) y esquemas Zod
├── tenancy/                 Tipos, resolución de contexto, repositorio, jerarquía cámara/socio (jerarquia.ts), canales y llaves
├── auth/                    Autenticación nativa (PBKDF2-SHA256), sesiones hasheadas en D1, membresías, guards, scopes y email Resend
├── durable/                 Durable Objects: HermesSandboxDO, RateLimiterDO, CallLockDO, CallSessionDO, FrequencyCapDO, CampaignRunnerDO y TrunkGovernorDO
├── lib/                     Criptografía, parseo CSV, utilidades HTTP, idempotencia, logger estructurado W3C, money, phone, score
└── types/                   Variables de entorno (env.ts), modelos de cobranza (cobranza.ts) y protocolos A2A (a2a.ts)

Dockerfile.sandbox           Definición de contenedor Firecracker para Cloudflare Sandboxes con sandbox-shim y runtime Hermes
migrations/                  0001 a 0019 (init, legal, alegra, tenants, native auth, tenant config, a2a, nom151, ateb_psc, hermes, canaco, recording governance, hierarchy, comunicacion, campaigns)

frontend/                    Single Page Application React + Vite + Tailwind CSS
├── App.tsx                  Dashboard principal: KPIs omnicanal y Voice AI, Dropzone CSV, tabla con buscador/orden/paginación, telemetría
├── OperatorDrawer.tsx       Workspace del operador: Diagnóstico IA, Semáforo NOM-184, Sherman v2, Softphone Telnyx PSTN/AI, links a NOM-151 y Cuaderno
├── Nom151Modal.tsx          Modal de constancias NOM-151, acta notarial imprimible y cotejo pericial
├── JudicialDocketModal.tsx  Modal del Cuaderno Judicial y Carpeta Fiscal SAT con liquidación de intereses (Art. 362 CCom) y exportación PDF
├── DebtorPortal.tsx         Portal público de autoservicio del deudor: 1-Click SPEI Checkout y descarga de Carta Finiquito
├── CopilotWidget.tsx        Mascota 3D interactiva Spline ("Ark"), reconocimiento de voz Web Speech API y asistente IA con Worker
├── TenantSettingsModal.tsx  Configuración self-serve del despacho: Razón Social, REDECO, Sincronización en 1-clic Asistente Telnyx, Test Canales
├── AccountingReportModal.tsx Visualización de corte contable en vivo (?live=1) y verificación de cadena de bloques del ledger
├── main.tsx                 Punto de entrada React
├── auth/                    AuthContext.tsx y AuthGate.tsx (inicio de sesión, selector de despachos y recuperación de contraseña)
└── landing/                 LandingPage, ComplianceMatrix, ProductTour, RoiCalculator, SplineShieldHero, TechArchitecture, TechnicalWhitepaperModal

design-system/               Meridian Core: componentes accesibles reutilizables (KpiCard, DataTable, PageShell, Dropzone, Button, Alert, etc.)
scripts/                     seed.sql, seed-demo-data.sql, seed-owner.ts, seed-canaco.ts, seed-tenant-config.ts, spike-voz.ts, forge_arkangel_watermark.py, forge_meridian_assets.py
docs/                        Documentación técnica de arquitectura, spike de voz, contrato Alegra MCP, instructivos por rol (INDEX + 01 al 06)
tests/                       34 suites unitarias y de integración (422 tests aprobados al 100%, incluye tests/spikeVoz.test.ts como arnés de regresión, tests/comunicacionAislamiento.test.ts, arnés E2E de 10 contactos y trunkGovernor)
```

---

## 3. Matriz de endpoints del Worker

| Método | Ruta | Scope / Auth | Descripción y propósito |
| :--- | :--- | :--- | :--- |
| **Autenticación Nativa** | | | |
| POST | `/api/auth/register` | — | Cerrado (403 `registro_cerrado`): altas exclusivas por invitación o script `seed-owner` |
| POST | `/api/auth/login` | público | Autenticación PBKDF2 y emisión de cookie segura `ark_session` (HttpOnly, SameSite=Lax, 30 días) |
| POST | `/api/auth/logout` | sesión | Revocación inmediata de sesión en D1 y limpieza de cookie |
| GET | `/api/auth/session` | público | Estado de la sesión actual, usuario y lista de despachos donde tiene membresía |
| POST | `/api/auth/request-password-reset` | público | Envío seguro de enlace de restablecimiento con token hash de un solo uso vía Resend |
| POST | `/api/auth/reset-password` | público | Validación del token de un solo uso y actualización de contraseña |
| POST | `/api/auth/change-password` | sesión | Cambio de contraseña por el usuario activo con política estricta y revocación de sesiones previas |
| **Operación de Cartera & Métricas** | | | |
| GET | `/api/v1/health` | público | Liveness y health check del worker |
| POST | `/api/v1/ingest/csv` | `ingest:write` | Ingesta de cartera (multipart CSV o JSON) con generación automática de contratos y CLABEs |
| GET | `/api/v1/cases/today` | `cases:read` | Listado de casos activos del día con paginación y búsqueda |
| GET | `/api/v1/metrics/today` | `metrics:read` | KPIs del día: casos, promesas, recaudación, más métricas de Voice AI (minutos, llamadas, audiopromesas) |
| POST | `/api/v1/disparar` | `cases:dispatch` | Disparo masivo de mensajes a la cola de Cloudflare Queues respetando ventana NOM-184 |
| GET | `/api/v1/cases/:id` | `cases:read` | Detalle específico de un caso |
| GET | `/api/v1/cases/:id/workspace` | `cases:read` | Ficha técnica completa del caso para el operador con Diagnóstico Ejecutivo IA |
| POST | `/api/v1/cases/:id/reply` | `messages:send` | Envío de mensaje humano filtrado e interceptado por las 12 reglas del Motor Legal (422 si viola) |
| POST | `/api/v1/cases/:id/resolve` | `cases:resolve` | Resolución manual de caso (`promise`, `paid`, `dnd`, `return_to_ai`) |
| POST | `/api/v1/cases/:id/notes` | `cases:resolve` | Notas internas del operador sobre el expediente del caso |
| PUT | `/api/v1/cases/:id/cfdi` | `cases:write` | Vinculación del UUID de CFDI timbrado ante el SAT con el contrato del caso |
| POST | `/api/v1/payments/reconcile` | `cases:resolve` | Conciliación de pagos manual individual o masiva mediante extracto bancario CSV |
| GET | `/api/v1/system/status` | `metrics:read` | Telemetría viva del sistema: latencia D1, Workers AI, Cola, Motor Legal, Ventana NOM-184 y RPM |
| POST | `/api/v1/copilot/chat` | `cases:read` | Chat conversacional del Copilot IA conectado en vivo a D1 y al caso en pantalla |
| **Telefonía & Telnyx Voice AI** | | | |
| POST | `/api/v1/cases/:id/call` | `messages:send` | Marcación saliente PSTN (+52) con AMD (detección de contestadora) o Softphone con guion legal |
| POST | `/api/v1/cases/:id/call/transfer` | `messages:send` | Transferencia en caliente de llamada activa (Call Bridging AI ↔ Supervisor Humano) |
| GET | `/api/v1/telnyx/webrtc-token` | `messages:send` | Generación de credenciales SIP/WebRTC para llamadas directas desde el navegador del operador |
| POST | `/api/v1/telnyx/assistant/sync` | `legal:config` | **Sincronización en 1 clic**: Aprovisiona o actualiza el Asistente de Voz Telnyx con reglas del tenant |
| **NOM-151, ATEB PSC & Cuaderno Judicial** | | | |
| GET | `/api/v1/nom151/:folio` | público | **Cotejo público judicial**: Validación matemática del hash SHA-256, sello y proveedor PSC (no-enumerable: timestamp base-36 + sufijo aleatorio de 6 caracteres; resguardo de secreto bancario: retiene texto en plano) |
| GET | `/api/v1/nom151/:folio/document` | público | Acta notarial formal de la constancia digital NOM-151 en formato imprimible |
| GET | `/api/v1/nom151/cases/:caseId` | `cases:read` | Listado de constancias NOM-151 emitidas para un expediente |
| POST | `/api/v1/nom151/cases/:caseId/issue` | `messages:send` | Emisión y sellado de constancia NOM-151 (Modo A ATEB PSC o Modo B presuntivo) |
| GET | `/api/v1/nom151/cases/:caseId/worm-chain` | `cases:read` | Verificación criptográfica de integridad de la bitácora WORM encadenada (Art. 49 CCom) |
| GET | `/api/v1/nom151/cases/:caseId/docket/printable` | `cases:read` | **Cuaderno Procesal Judicial & Carpeta SAT**: Vista imprimible oficial con liquidación de intereses (6%) y badges Modo A / B |
| GET | `/api/v1/nom151/psc/settings` | `legal:config` | Consulta de credenciales del Conector ATEB PSC del despacho (enmascaradas) |
| POST | `/api/v1/nom151/psc/settings` | `legal:config` | Configuración self-serve de credenciales ATEB PSC (Modo A Pleno vs Modo B) |
| **Portal de Autoservicio del Deudor** | | | |
| GET | `/api/v1/portal/:id` | público | Ficha pública segura de deudor con enmascaramiento CONDUSEF, quita autorizada y CLABE SPEI |
| POST | `/api/v1/portal/:id/report-payment` | público | Reporte de pago SPEI por el deudor con clave de rastreo bancario; genera promesa con confianza 0.99 |
| GET | `/pay/:id` o `/portal/:id` | público | Enrutamiento web amigable de acceso directo al portal de autoservicio |
| **Protocolo A2A (Agent-to-Agent)** | | | |
| POST | `/api/v1/a2a/auth` | público | Autenticación de agentes deudores con PIN o RFC/CURP conforme a Reglas 4.1 y 4.2 CONDUSEF |
| GET | `/api/v1/a2a/terms/:caseId` | público / token A2A | Consulta de condiciones y quita máxima autorizada por las políticas del despacho |
| POST | `/api/v1/a2a/negotiate` | público / token A2A | Negociación algorítmica de quita: emite convenio formal con CLABE o formula contraoferta |
| GET | `/api/v1/a2a/agreement/:id` | público / token A2A | Detalle y estado del convenio pactado entre agentes |
| POST | `/api/v1/a2a/mcp` | público / token A2A | Servidor Model Context Protocol (MCP) JSON-RPC 2.0 (`tools/list` y `tools/call` para agentes de IA) |
| **Configuración del Despacho (Tenant Self-Serve)** | | | |
| GET | `/api/v1/tenant/settings` | `legal:read` | Configuración legal/operativa del despacho, URLs de webhooks y política de grabación LFPDPPP |
| PUT | `/api/v1/tenant/settings` | `legal:config` | Guardado de Razón Social, REDECO, dominios, horario NOM-184, modo de agente y política de grabación (aviso, retención, consentimiento, aviso de privacidad) |
| GET | `/api/v1/tenant/channels` | `legal:read` | Consulta de canales operativos del despacho (`whatsapp`, `sms`, `email`) |
| PUT | `/api/v1/tenant/channels` | `legal:config` | Activación/desactivación de canales y credenciales de enrutado |
| POST | `/api/v1/tenant/channels/test` | `legal:read` | Test interactivo de conectividad y handshake en vivo con telemetría de latencia |
| GET | `/api/v1/tenant/members` | `legal:read` | Directorio de miembros del despacho |
| POST | `/api/v1/tenant/members/invite` | `legal:config` | Envío de invitación por correo a nuevos miembros con enlace seguro de activación |
| DELETE | `/api/v1/tenant/members/:userId` | `legal:config` | Revocación de acceso de un miembro del despacho (protege al último owner) |
| **Contabilidad, Legal & Agéntico** | | | |
| GET | `/api/v1/legal/catalogo` | `legal:read` | Catálogo de las 12 reglas con leyes, artículos y sanciones |
| GET | `/api/v1/legal/hoy` | `legal:read` | Resumen de cumplimiento y auditorías legales del día |
| GET | `/api/v1/contabilidad/resumen` | `accounting:read` | Resumen contable (desde R2 o proyectado en vivo con `?live=1`) |
| GET | `/api/v1/tenant/accounting-map` | `accounting:read` | Mapa de cuentas contables Alegra por regla legal del despacho |
| PUT | `/api/v1/tenant/accounting-map` | `legal:config` | Edición self-serve de cuentas contables débito/crédito por despacho |
| GET | `/api/v1/reports/daily` | `metrics:read` | Reporte Ejecutivo Diario consolidado |
| POST | `/api/v1/reports/daily/send` | `metrics:read` | Envío por correo (Resend) del Reporte Ejecutivo Diario a dueños y contadores |
| GET | `/api/v1/state` | `agent:read` | Estado del bot agéntico (modo, cola, pendientes) |
| POST | `/api/v1/decide` · `/dispatch` · `/audit` | `agent:decide` / etc. | Operación agéntica autónoma del bot |
| POST | `/api/v1/bot/classify` | `agent:decide` | Clasificación en tiempo real de mensajes entrantes con transición automática |
| POST | `/api/v1/scoring/calibrate` | `agent:decide` | Calibración algorítmica continua de Sherman v2 según cobranza real |
| **Motor de Comunicación General & Campañas (Marketing / Avisos)** | | | |
| POST | `/api/v1/comunicacion/preview` | `messages:send` | Evaluación previa fail-closed de audiencia (opt-in, REPEP, quiet hours, cap semanal) y cotización de costo |
| POST | `/api/v1/comunicacion/campaigns` | `messages:send` | Disparo formal de campaña masiva bajo contrato `CAMPAIGN_DISPATCH_V1` orquestado por `CampaignRunnerDO` |
| GET | `/api/v1/comunicacion/campaigns/:id` | `messages:read` | Reporte detallado post-campaña: enviados, diferidos, excluidos por regla y argumentos de valor legal |
| POST | `/api/v1/comunicacion/campaigns/:id/pause` | `messages:send` | Pausa inmediata de una campaña en ejecución gobernada por `CampaignRunnerDO` |
| POST | `/api/v1/comunicacion/repep/upload` | `legal:config` | Carga e ingesta de lista oficial REPEP (PROFECO) con hashing SHA-256 en edge |
| GET | `/api/v1/comunicacion/repep/status` | `legal:read` | Consulta de vigencia (< 35 días) y antigüedad de la versión activa de REPEP |
| **Webhooks Receptores** | | | |
| GET/POST | `/webhooks/whatsapp` | Meta HMAC-SHA256 | Verificación de challenge y recepción de mensajes WhatsApp Business |
| POST | `/webhooks/telnyx` | Telnyx Ed25519 | Webhook omnicanal Telnyx: SMS, WhatsApp v2, eventos de llamada, AMD, grabaciones y Voice AI |
| POST | `/webhooks/resend` | — | Recepción de eventos de correo electrónico |
| POST | `/webhooks/conekta` | Conekta RSA-SHA256 | Conciliación automática de órdenes SPEI / OXXO Pay (PyME México) |
| POST | `/webhooks/cobre` | Cobre HMAC-SHA256 | Conciliación automática de pagos SPEI corporativos (Enterprise) |

---

## 4. Esquema de base de datos D1

| Tabla | Migración | Rol y contenido |
| :--- | :--- | :--- |
| `tenants` | 0004, 0009, 0011, 0015, 0016, 0017 | Catálogo de despachos y agremiados: razón social, REDECO, ventana NOM-184, rate limit, config de agente y políticas A2A; columnas de gobernanza LFPDPPP de grabación de audio (`recording_enabled`, etc.) en 0016; jerarquía multi-tenant en 0017 (`parent_tenant_id`, `tenant_level`, `marca_comercial`, `comm_max_por_semana`, `comm_optout_scope`) |
| `tenant_channels` | 0004, 0009 | Enrutado y credenciales por canal de cada despacho (WhatsApp phone ID, SMS profile ID, dominio email) |
| `tenant_memberships` | 0007 | Relación usuario ↔ despacho con asignación estricta de roles (`owner`, `admin`, `member`) |
| `users` | 0007 | Directorio de usuarios: correo electrónico, hash PBKDF2 y rol de plataforma |
| `auth_sessions` | 0007 | Sesiones activas con hash criptográfico SHA-256 del token, expiración y control de revocación |
| `auth_tokens` | 0007 | Tokens temporales de un solo uso para restablecimiento de contraseña e invitaciones |
| `auth_rate_limits` | 0007 | Control de fuerza bruta en autenticación por correo e IP |
| `clients` | 0001, 0006, 0011 | Directorio de deudores con `tenant_id`, teléfono E.164, CURP, RFC y PIN de autenticación A2A |
| `debts` | 0001, 0006 | Adeudos por cliente, montos en centavos, fecha de vencimiento y estado |
| `cases` | 0001, 0006 | Casos de cobranza diarios con estado, score Sherman v2 y canal asignado |
| `contracts` | 0001, 0006 | Contratos de cobranza con CLABE autorizada de 18 dígitos, razón social y registro REDECO |
| `messages` | 0001, 0006 | Mensajes enviados y recibidos por todos los canales con estados de entrega |
| `promises` | 0001, 0006 | Promesas de pago comprometidas (por IA, operador, Voice AI, portal o A2A) con montos y fechas |
| `events` | 0001, 0006 | Bitácora de eventos y telemetría de auditoría unificada del sistema |
| `legal_audit` | 0002, 0006 | **Ledger append-only** de cumplimiento legal con verificación de las 12 reglas CONDUSEF |
| `ledger_checkpoint` | 0003, 0006 | Encabezado de la cadena de hashes del ledger contable y legal por fecha de corte |
| `alegra_sync` | 0003, 0006 | Registro de sincronización con Alegra: idempotency keys, estado y journal IDs |
| `legal_accounting_map` | 0003 | Catálogo maestro de cuentas contables Alegra por regla legal (12 reglas sembradas) |
| `tenant_accounting_map`| 0004, 0006 | Configuración particular de cuentas contables Alegra parametrizada por despacho |
| `alegra_journal_lines` | 0003, 0006 | Trazabilidad detallada de asientos (`legal_audit.id` → journal id en Alegra) |
| `contract_cfdi` | 0003, 0006 | UUIDs de CFDI timbrados vinculados al contrato mercantil |
| `intakes` | 0001, 0006 | Registro de archivos CSV ingeridos con totales de filas y metadatos |
| `a2a_agreements` | 0011 | Convenios pactados programáticamente entre agentes de IA bajo el protocolo A2A |
| `nom151_certificates` | 0012, 0013 | Constancias NOM-151 emitidas: folios, hashes deterministas SHA-256, sellos, proveedor PSC y nivel de cumplimiento |
| `worm_audit_log` | 0013 | **Bitácora WORM inmutable encadenada** (`prev_hash` -> `entry_hash`) para retención de 10 años (Art. 49 CCom; ver §1) |
| `tenant_psc_settings` | 0013 | Credenciales de Conector ATEB PSC por despacho (Modo A oficial vs Modo B presuntivo) |
| `hermes_forensic_jobs` | 0014 | Dictámenes periciales y trabajos forenses de Hermes (Skip-Trace, SAT 69-B, Síntesis Judicial) |
| `comm_consents` | 0018 | Consentimientos expresos de comunicación comercial/institucional (opt-in) por marca, contacto, canal y categoría con fecha y fuente |
| `comm_suppressions` | 0018 | Lista negra de bajas y supresión de envíos por marca o tenant (opt-out automático y manual) |
| `comm_templates` | 0018 | Plantillas Meta HSM y avisos aprobados con variables estrictas e interpolación de marca comercial |
| `comm_repep_versions` | 0018 | Versiones de la lista oficial REPEP (PROFECO) con fecha de corte y control atómico de estado (`loading`, `active`, `superseded`) |
| `comm_repep_numbers` | 0018 | Teléfonos inscritos en REPEP almacenados como hashes SHA-256 en formato E.164 para cotejo privado en edge |
| `comm_envios` | 0018 | Bitácora unitaria de envíos y exclusiones del Motor de Comunicación con estatus (`sent`, `excluded`, `deferred`), motivo y provider_id |
| `comm_campaigns` | 0019 | Campañas masivas de comunicación orquestadas por `CampaignRunnerDO` con control de progreso, cursor y estatus |
| `usage_events` | 0019 | Bitácora de consumo de recursos (mensajes y minutos de voz) con costo unitario para cobro contra la bolsa de créditos de la cámara |

---

## 5. Bitácora cronológica de sprints

### Sprints 0 al 2 — Fundaciones del Sistema y Módulo Contable
* **Sprint 0 — Base**: Worker Hono + D1/KV/Queue/DO, canales WhatsApp/SMS/Email, Workers AI (Llama 3.3), motor legal fail-closed (12 reglas), scoring Sherman v2, dashboard de 1 botón y cron a las 6 AM CDMX.
* **Sprint 1 — Grok Bot (Agéntico)**: Autonomía agéntica, clasificación en tiempo real (`/bot/classify`), calibración continua (`/scoring/calibrate`) y reporte diario.
* **Sprint 2 — Módulo Contable (Alegra MCP)**: Asientos contables automáticos vinculados al ledger legal, transporte MCP HTTP/SSE y cron a las 23:59 CDMX con almacenamiento en Cloudflare R2.

### Sprint 3 y 4 — Aislamiento Multi-Tenant y Rate Limiter Distribuido
* **Sprint 3**: Fusionado con Sprint 4 en la arquitectura final de aislamiento distribuido.
* **Sprint 4 — Tenant Isolation y Rate Limiter**: Aislamiento estricto multi-tenant con `tenant_id` en todas las tablas de negocio, índices compuestos y rate limiter atómico distribuido en Durable Objects (`RateLimiterDO`).

### Sprint 5 — Identidad Nativa en D1
* Eliminación de dependencias externas de autenticación SaaS; PBKDF2-SHA256 en Worker, sesiones hasheadas en D1, cookie segura `ark_session` y RBAC en 3 niveles (`owner`, `admin`, `member`).

### Sprint 6 — Operación Humana, Copilot y Conciliación de Pagos
* **Workspace del Operador (`OperatorDrawer.tsx`)**: Diagnóstico Ejecutivo IA de casos escalados, Softphone con guion obligatorio CONDUSEF e interceptor legal humano en respuestas.
* **Copilot IA Flotante (`CopilotWidget.tsx`)**: Asistente conversacional con acceso al estado de D1 y generación de respuestas pre-blindadas.
* **Conciliación de Pagos en 3 Tiers (`src/services/pagos.ts`)**: Tier 1 Conekta (SPEI/OXXO), Tier 2 Cobre (SPEI corporativo) y Tier 3 extracto bancario CSV.
* **Consola Self-Serve del Despacho (`TenantSettingsModal.tsx`)**: Edición en UI de Razón Social, REDECO, ventana NOM-184 y copiado de webhooks.

### Sprint 7 — Telnyx v2, Seguridad Ed25519 y Reportes
* **WhatsApp vía Telnyx v2**: Migración a la API v2 de Telnyx con verificación de firma criptográfica Ed25519 (`telnyx-signature-ed25519`) contra ataques de replay y suplantación.
* **Gobierno RBAC e Invitaciones de Equipo**: Enrutado independiente de canales por despacho (`tenant_channels`) e invitaciones por correo con enlaces de activación de 7 días.
* **Reporte Ejecutivo Diario**: Consolidado diario de cartera, métricas de cobranza, CONDUSEF y contabilidad vía Resend.

### Sprint 8 — Excelencia Operativa, Diagnóstico de Canales y Mascota 3D
* **Buscador omnicanal en vivo, ordenamiento y paginación real** en la tabla de casos.
* **Diagnóstico interactivo de canales**: Botón "Probar canal" con handshake en vivo y medición de latencia en milisegundos.
* **Semáforo NOM-184 de 3 etapas y Gauge Sherman v2**: Bloqueo preventivo de softphone y envíos al alcanzar 3 contactos en 24h.
* **Mascota 3D Spline Interactiva ("Ark")**: Esculpida en Spline, cargada de forma lazy-loaded con animación idle y dictado de voz nativo Web Speech API.

### Sprint 9 — Protocolo A2A (Agent-to-Agent Collections)
* **Handshake con Secreto Financiero**: Protección de adeudos bajo Reglas 4.1 y 4.2 CONDUSEF con autenticación por PIN/RFC y enmascaramiento de identidad.
* **Motor Algorítmico de Quitas Anti-Jailbreak**: Negociación matemática determinista inmune a prompt injections.
* **Servidor MCP JSON-RPC 2.0 (`/api/v1/a2a/mcp`)**: Herramientas nativas (`arkangel_a2a_auth`, `arkangel_a2a_get_terms`, `arkangel_a2a_submit_offer`, `arkangel_a2a_get_agreement`) para interacción autónoma entre agentes de IA.

### Sprint 10 — Telefonía Telnyx Voice AI Assistants (Superación del Spike DIY)
* **Telefonía PSTN con AMD**: Marcación directa a números móviles y fijos de México (+52) con Answering Machine Detection premium y colgado automático ante buzón de voz.
* **Integración Nativa Telnyx Voice AI Assistants**: Transición formal del spike experimental artesanal (Spike D cerrado como NO-GO por latencia 3.9s p95) a Voice AI Assistants nativo de Telnyx (< 800 ms de cota y objetivo de diseño bajo SLA del proveedor; grabación estéreo opt-in).
* **Softphone Humano y Transferencia en Caliente (`call.bridge`)**: Transferencia de la llamada entre Voice AI y supervisores humanos sin desconectar la línea.

### Sprint 11 — Portal de Autoservicio del Deudor & 1-Click SPEI Checkout
* **Portal Público `/pay/:id`**: Acceso seguro sin credenciales, datos enmascarados, desglose transparente de saldo con quita condonada y CLABE SPEI con detección automática de banco.
* **Cartas Convenio y Finiquito**: Generación de documentos formales con sello criptográfico SHA-256 conforme al Art. 112 Bis LFPC.

### Sprint 12 — Constancia de Notificación Digital NOM-151-SCFI-2016
* **Motor Criptográfico NOM-151**: Huella determinista SHA-256 de mensajes de datos, cadena original estandarizada y estampillado de tiempo UTC/CDMX.
* **Cotejo Judicial Público**: Endpoints `/api/v1/nom151/:folio` y `/api/v1/nom151/:folio/document` para validación pericial de autenticidad e impresión de actas notariales.

### Sprint 13 — Conector ATEB Servicios PSC, Custodia WORM y Cuaderno Judicial/Fiscal
* **Conector Dual-Engine ATEB PSC**: Modo A (Cumplimiento Pleno Oficial acreditado por la Secretaría de Economía con RFC 3161 TSA y ASN.1 DER) y Modo B (Evidencia Interna Preparada para Migración con resguardo inmutable y failover automático).
* **Capa de Custodia WORM (Write Once, Read Many)**: Bitácora inmutable encadenada (`worm_audit_log`) para retención obligatoria de 10 años conforme al Art. 49 CCom (Modo B presuntivo; ver §8 para la ruta a Modo A oficial acreditado ante la Secretaría de Economía).
* **Cuaderno Procesal Judicial & Carpeta SAT**: Expediente integral para Juicios Ejecutivos Mercantiles y Orales Mercantiles (Art. 1298-A CCom), con cálculo de intereses moratorios al 6% anual (Art. 362 CCom) y materialidad probatoria ante el SAT (Arts. 29-A y 69-B CFF, y 27 Fracc. XV LISR). Distinción explícita por folio en interfaz y reporte impreso: Modo A Oficial ATEB PSC (verde) vs Modo B Presuntivo Arkangel (amarillo).
* **Sincronización en 1-Clic y KPIs de Voz en Dashboard**: Botón de aprovisionamiento de Asistente de Voz Telnyx en la UI y tarjetas KPI de Minutos de Voz, Llamadas AI y Promesas en Audio en la pantalla principal.

### Sprint 14 — Agente Autónomo Hermes en Cloudflare Sandboxes (`hermes-flare`)
* **Separación Radical de Planos de Cómputo**: Arquitectura de dos planos: Plano 1 (Edge V8 Isolates, transaccional, Telnyx Voice AI, SPEI checkout, latencia < 50 ms) y Plano 2 (Firecracker microVMs aisladas con `@cloudflare/sandbox`, Python 3.11, Nous Research Hermes Agent, trabajos forenses de 30s a 15 min).
* **Skip-Tracing Patrimonial y Dictamen de Embargabilidad**: Rastreo autónomo de activos, sociedades y domicilios fiscales en registros públicos (RPPC, boletines judiciales, SAT) con clasificación procesal (`Clase A: Solvente con bienes inscritos`, `Clase B: Flujo bancario`, `Clase C: Insolvente`).
* **Peritaje Forense SAT (Arts. 29-A, 69-B CFF y 27-XV LISR)**: Parseo y escrutinio masivo de CFDIs contra listas negras EFOS (definitivos y presuntos) y emisión automatizada de la Carpeta de Materialidad Fiscal que valida la deducción por incobrabilidad para ISR.
* **Redacción Procesal del Cuaderno Judicial Mercantil (Art. 1298-A CCom)**: Redacción estructurada de agravios y capítulos de hechos basada en constancias NOM-151 y audios transcritos, junto con cómputo automatizado de intereses moratorios al 6% anual legal (Art. 362 CCom).
* **Persistencia Episódica R2 & Bitácora WORM**: Durable Object `HermesSandboxDO` con snapshotting a Cloudflare R2 (`HERMES_MEMORY_BUCKET`), inmutabilidad WORM bajo actor `hermes_agent` y hash SHA-256 en `worm_audit_log`.
* **Integración UI en 1 Clic**: Botón `[Solicitar Peritaje Hermes SAT / Skip-Tracing]` y acciones rápidas en el modal del Cuaderno Judicial con telemetría de microVM en vivo.

---

### Sprint 15 — Gobernanza LFPDPPP de grabación de audio (Voice AI)
* **Política de grabación por tenant**: columnas `recording_enabled`, `recording_announcement`, `recording_retention_days`, `recording_consent_required`, `recording_privacy_notice_url` en `tenants` (migración 0016), fail-closed (deshabilitado por defecto).
* **Guard fail-closed**: `validateRecordingPolicy` + `startRecordingGoverned` en `src/channels/telnyxVoice.ts` bloquean `record_start` si la política está incompleta (sin aviso, retención 0, sin aviso de privacidad, consentimiento no otorgado).
* **Configuración efectiva**: `TenantConfig.recording` y helper `tenantListoParaGrabar` en `src/tenancy/config.ts`.
* **Self-serve**: campos de grabación integrados en `GET/PUT /api/v1/tenant/settings`.
* **Tests**: `tests/recordingGovernance.test.ts` (7 casos de política + 2 de guard).

### Sprints 16 al 18 — Motor de Comunicación General y Campañas Multi-Marca (Marketing / Avisos)
* **Aislamiento Estricto de Dominios (`src/comunicacion/`)**: Módulo de marketing y comunicación institucional desacoplado del Motor Legal de cobranza (`src/legal/`); verificado por `tests/comunicacionAislamiento.test.ts` que prohíbe imports cruzados entre dominios.
* **Jerarquía Cámara → Socio y Marca Comercial (Migración 0017)**: Columnas `parent_tenant_id`, `tenant_level` (`platform | organizacion | socio`), `marca_comercial`, `comm_max_por_semana` y `comm_optout_scope`. Resolución de canales heredados (`canalesEfectivos`) donde el socio usa los canales de la cámara o sus propios números.
* **Consentimiento y Supresión por Marca (Migración 0018)**: Tablas `comm_consents` (opt-in con fecha y origen por marca/canal/categoría), `comm_suppressions` (lista negra de baja), `comm_templates` (plantillas aprobadas) y `comm_envios` (bitácora detallada de auditoría).
* **Reglas Anti-Spam Fail-Closed**: Switch obligatorio sin default, quiet hours de 21:00 a 08:00 (`horarios.ts`), identificación obligatoria de marca comercial (LFPC Art. 17), exclusión automática de contactos con cobranza activa y plantillas curadas con variables estrictas (`plantillas.ts`).
* **Frequency Cap Aislado en Durable Objects (`FrequencyCapDO`)**: Control de impactos semanales en ventana deslizante de 7 días indexado por marca + teléfono (`fcap:${brandId}:${phone}`) con purga por alarmas, garantizando que campañas de diferentes marcas no colisionen.
* **Orquestador de Campañas (`CampaignRunnerDO`) y Bolsa de Consumo (Migración 0019)**: Despacho formal bajo contrato `CAMPAIGN_DISPATCH_V1` con pacing, soporte de pausa/reanudación y registro de eventos de consumo en `usage_events` (minutos y mensajes con costo unitario) para liquidación contra la bolsa de créditos de la cámara.
* **Opt-out Inbound Automático**: Detección inmediata de palabras clave ("BAJA", "STOP", "ALTO") en webhooks de WhatsApp/SMS para revocar el consentimiento al vuelo y suprimir futuros envíos.
* **API de Comunicación**: Endpoints `/api/v1/comunicacion/preview` (evaluación y cotización previa en pesos), `/api/v1/comunicacion/campaigns` (disparo formal y consulta de estado con argumentos de valor), `/pause`, `/repep/upload` y `/repep/status`.
* **Ingesta y Verificación Mensual REPEP PROFECO (Sprint 17)**: Hashing SHA-256 en edge de números telefónicos E.164 (`comm_repep_numbers`), vigencia fail-closed de 35 días (`comm_repep_versions`), carga atómica de versiones (`loading` → `active` → `superseded`) y bloqueo automático preventivo ante listas ausentes o caducadas.
* **Gobernador de Troncal Voice AI (`TrunkGovernorDO` — Sprint 18)**: Límite duro de 30 Dials Per Second (DPS) calculado con media móvil en ventana deslizante de 5 segundos, control de concurrencia saliente (2 canales base Level 1 / 10 canales Level 2), arbitraje fail-closed con paso preferencial inmediato de llamadas de cobranza sobre marketing, y manejo de saturación HTTP 429 (Telnyx 90103) con backoff exponencial mediante alarmas de Durable Objects (`setAlarm()`).
* **Arnés de Integración E2E**: `tests/campaignDispatchE2E.test.ts` validó con éxito una campaña de 10 contactos (5 enviados vía WhatsApp, 3 excluidos por falta de opt-in, 1 excluido por cobranza activa y 1 por opt-out previo), con generación de eventos de consumo para la bolsa de créditos.

---

## 6. Estado de verificación y calidad del código

| Verificación | Herramienta / Comando | Resultado actual |
| :--- | :--- | :--- |
| **Suite completa de pruebas** | `npm test` (34 archivos) | **34 suites / 422 tests aprobados (100% verde)**; incluye Motor de Comunicación, aislamiento estricto de dominios, suite REPEP SHA-256 edge, TrunkGovernorDO 30 DPS/concurrencia, arnés E2E de 10 contactos, peritajes forenses Hermes, arnés de voz y contratos procesales |
| **Latencia Voice AI (Telnyx)** | Telemetría en producción | **< 800 ms objetivo de diseño bajo SLA del proveedor; arnés telemétrico formal de p50/p95 en producción en curso (ver §8)** |
| **Linter de código** | `npm run lint` (`--max-warnings 0`) | **0 errores, 0 warnings** |
| **Compilación frontend** | `npm run build:frontend` (Vite) | **1645 módulos transformados, bundle limpio** |
| **Compilación del Worker** | `npm run build:worker` (Wrangler dry-run) | **Todos los bindings D1/KV/Queue/DO/R2/AI/Sandbox validados** |
| **Integración Continua** | `.github/workflows/ci.yml` en GitHub Actions | **Runs en `main` y pull requests en verde** |
| **Ambiente de Producción** | `curl -s https://arkangel.arksystems.site/api/v1/health` | **`{"ok": true, "service": "arkangel-cobranza", "env": "production"}`** |

---

## 7. Mapa de instructivos y documentación operativa (`docs/`)

La carpeta [`docs/instructivos/`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/INDEX.md) contiene los manuales de procedimientos y auditoría organizados por nivel de usuario:

1. **[`01-administrador-dueno.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/01-administrador-dueno.md)**: Configuración legal de despacho, sincronización de Telnyx Voice AI, gobierno de canales y monitoreo de KPIs ejecutivos.
2. **[`02-abogado-litigante-compliance.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/02-abogado-litigante-compliance.md)**: Cuaderno Procesal Judicial (Art. 1298-A CCom), liquidación de intereses (6% Art. 362 CCom), verificación de bitácora WORM a 10 años (Art. 49 CCom) y constancias NOM-151 con ATEB PSC.
3. **[`03-operador-gestor-cobranza.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/03-operador-gestor-cobranza.md)**: Operación de Softphone PSTN con guion CONDUSEF, Diagnóstico Ejecutivo IA, Semáforo NOM-184, Copilot y generación de enlaces 1-Click SPEI.
4. **[`04-contador-auditor-fiscal.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/04-contador-auditor-fiscal.md)**: Carpeta de Materialidad Fiscal SAT (Arts. 29-A y 69-B CFF), deducibilidad de cuentas incobrables (Art. 27 Fracc. XV LISR), conciliación bancaria y asientos contables en Alegra.
5. **[`05-portal-deudor-autoservicio.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/05-portal-deudor-autoservicio.md)**: Guía del titular deudor: acceso seguro sin password, cálculo de quitas, riel 1-Click SPEI y obtención de Carta Finiquito con sello SHA-256.
6. **[`06-auditoria-calidad-anexo-tecnico-comercial.md`](file:///c:/Users/PAV/Desktop/e-commerce/arkangel/docs/instructivos/06-auditoria-calidad-anexo-tecnico-comercial.md)**: Anexo técnico para debida diligencia de despachos de cobranza, bancos e instituciones financieras auditadas por CNBV/CONDUSEF.

---

## 8. Frontera activa, pendientes y hoja de ruta

### Resuelto y Superado (Sin deuda en estos componentes)
* **Motor de Comunicación y Marketing Multi-Marca (Sprints 16–18)**: Desacoplado 100% de cobranza (`src/comunicacion/`), contrato Zod `CAMPAIGN_DISPATCH_V1`, switch explícito y fail-closed, evaluación de plantillas Meta HSM, inyección obligatoria de marca comercial (LFPC Art. 17), quiet hours 21:00 a 08:00 hora local, y aislamiento estricto verificado por test AST estático (`tests/comunicacionAislamiento.test.ts`).
* **Ingesta y Verificación Mensual de REPEP PROFECO (Sprint 17)**: Hashing SHA-256 en edge de teléfonos en formato E.164 (`comm_repep_numbers`), vigencia fail-closed de 35 días (`comm_repep_versions`), carga atómica de versiones (`loading` → `active` → `superseded`) y bloqueo preventivo de campañas si la lista no está vigente o si el número está registrado.
* **Gobernador de Troncal y Pacing de Telefonía Saliente Voice AI (`TrunkGovernorDO` — Sprint 18)**: Control estricto de concurrencia saliente (2 canales base Level 1, 10 canales Level 2), cota dura de 30 Dials Per Second calculada como media móvil en ventana deslizante de 5 segundos, arbitraje fail-closed con paso preferencial inmediato de llamadas de cobranza sobre campañas comerciales, y manejo de saturación HTTP 429 de Telnyx (error 90103) mediante backoff exponencial gobernado por alarmas de Durable Objects (`setAlarm()`).
* **Jerarquía de Tenants y Facturación por Consumo**: Modelo Cámara (`tenant_level = 'organizacion'`) y Agremiado (`tenant_level = 'socio'`), herencia segura de credenciales de canal, registro de `usage_events` para tarificación de bolsa de créditos, y receptor webhook con opt-out automático ("BAJA"/"STOP").
* **Spike de Voz Artesanal (Workers AI / Cloudflare Realtime)**: Formalmente cerrado como antecedente superado; sustituido en producción por **Telnyx Voice AI Assistants**, marcación PSTN mexicana (+52), Answering Machine Detection (AMD) y latencia conversacional ultrabaja.
* **Desfase de Cron de Cobranza**: Alineado a las 12:00 UTC = 6:00 AM hora del centro de México (CDMX) en `wrangler.jsonc`.
* **Identidad y Autenticación**: 100% nativa con PBKDF2 en Cloudflare D1; cero dependencias de Clerk o SaaS de identidad.
* **Integración Continua**: Pipeline activo en `.github/workflows/ci.yml`.
* **Gobernanza LFPDPPP de grabación de audio (Sprint 15)**: política por tenant, guard fail-closed `startRecordingGoverned`, campos self-serve en `/api/v1/tenant/settings` y tests. La grabación sigue opt-in; se habilita solo con política completa.

### Frontera Activa (Prioridades siguientes y Pendientes)

1. **Validación en Vivo de Credenciales de Producción ATEB PSC (Modo A)**:
   * Los despachos operan actualmente en Modo B (evidencia interna y resguardo criptográfico WORM pleno).
   * **Advertencia operativa**: Mientras un despacho opere en Modo B, las constancias emitidas se presentan válidamente como evidencia informática complementaria (Arts. 1298-A CCom y 210-A CFPC), pero no como constancia NOM-151 oficial plena. El Cuaderno Procesal (§3, `/docket/printable`) incluye una leyenda y distintivo visual que separa los folios Modo A de los Modo B para evitar objeciones procesales en juicio.
   * Al tramitar el despacho sus credenciales ante ATEB Servicios PSC (proveedor acreditado por la Secretaría de Economía), cargar la llave de producción en `POST /api/v1/nom151/psc/settings` para conmutar a timbrado oficial TSA RFC 3161 y constancias ASN.1 DER sin cambios de código.

2. **Validación de Catálogo Real contra Alegra**:
   * El cliente Alegra MCP JSON-RPC 2.0 está implementado y probado en arnés unitario.
   * Pendiente ejecutar un ensayo end-to-end contra una instancia de pruebas de Alegra para verificar que los identificadores de cuentas del plan contable coincidan con el mapeo por despacho.
