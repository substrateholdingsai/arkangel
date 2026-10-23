# ARKANGEL — Cobranza asistida por IA

Worker de Cloudflare que hace cobranza por **WhatsApp y SMS (Telnyx)** y
**email (Resend)**, redactado y respondido por **Workers AI**, con un dashboard de una sola
pantalla: *1 botón • 0 tablas*.

> **Modo Neandertal**: el operador solo arrastra el CSV de las 6:00 AM y aprieta el botón verde.

- **Worker**: `arkangel-cobranza` → https://arkangel-cobranza.substrateholdingsai.workers.dev
- **D1**: `arkangel-cobranza-db` · **KV**: dedupe/throttle · **Queue**: `arkangel-cobranza-queue` (+ DLQ)
- **Cron**: `0 6 * * *` (America/Mexico_City)

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Cloudflare Workers (Hono 4, TypeScript, `nodejs_compat`) |
| Datos | D1 (SQLite) + KV (idempotencia/throttle) + Queues + Durable Objects |
| IA | Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) con fallback heurístico |
| Canales | Telnyx (WhatsApp Business API & SMS) · Resend (Email) |
| Frontend | React 18 + Tailwind 3.4 (Vite) servido como static assets del Worker |
| Design System | `design-system/` — tokens + preset Tailwind + componentes (ver `design-system/README.md`) |

## Design system

El sistema de diseño vive **como código** en `design-system/` y aplica a este proyecto y a
los futuros:

```
design-system/
├── tokens.css           # variables: color, tipografía, radio, sombra, patrones
├── tailwind.preset.js   # preset Tailwind v3 (colores ark.*, fuentes, sombras)
├── components.tsx       # PageShell, TopNav, KpiCard, DataTable, DarkPanel, Dropzone…
└── README.md            # cómo reusarlo en otro proyecto
```

- **Paleta**: Slate (estructura) + Emerald 600 (acción/éxito) + acentos semánticos
- **Tipografía**: Inter 300–700; monoespaciada sólo para montos, IDs y logs
- **Assets de marca**: `scripts/forge_arkangel_watermark.py` genera el PNG/SVG de la marca de
  agua (`npm run assets:watermark`, se ejecuta en `prebuild`/`predeploy`)

```bash
npm run assets:watermark         # genera si falta o está viejo
npm run assets:watermark:force   # regenera siempre
```

## Comandos

```bash
npm install
npm run dev              # build del frontend + wrangler dev
npm run build            # vite build + wrangler deploy --dry-run
npm run deploy           # vite build + wrangler deploy
npm test                 # vitest
npm run typecheck        # tsc (worker + frontend)
npm run lint             # eslint --max-warnings 0
npm run db:migrate       # aplica migraciones D1 en remoto
```

### CI

Cada `push` a `main` y cada PR contra `main` corren `.github/workflows/ci.yml`:
`npm ci` + `npm run verify` (format, lint, typecheck, test, build). El workflow
es el mismo gate que se corre en local: si `npm run verify` falla en local,
falla en Actions.

## Variables

Secrets (vía `wrangler secret put`, valores locales en `.dev.vars` — **gitignored**):

```bash
npx wrangler secret put ADMIN_TOKEN          # break-glass: token de plataforma (x-admin-token)
npx wrangler secret put INTAKE_TOKEN         # token del CRM para entregar el CSV
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TELNYX_API_KEY
npx wrangler secret put TELNYX_MESSAGING_PROFILE_ID
npx wrangler secret put TELNYX_FROM_NUMBER
npx wrangler secret put TELNYX_WHATSAPP_FROM          # opcional si difiere de TELNYX_FROM_NUMBER
npx wrangler secret put TELNYX_WEBHOOK_PUBLIC_KEY     # clave Ed25519 de Telnyx para validar webhooks
```

Vars editables en `wrangler.jsonc`:

| Var | Default | Qué hace |
|---|---|---|
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Modelo de Workers AI |
| `SEND_WINDOW_START` / `SEND_WINDOW_END` | `9` / `20` | Ventana legal de contacto (hora CDMX) |
| `DEDUPE_WINDOW_HOURS` | `24` | No repetir canal por caso en 24 h |
| `RATE_LIMIT_RPM` | `42` | Envíos por minuto y canal |
| `SCORE_AMOUNT_CEILING_CENTS` | `200000` | Monto ($2,000 MXN) donde R2 satura |
| `CRON_AUTO_FIRE` | `false` | `true` = el cron de las 6 AM dispara solo |
| `DRY_RUN` | `false` | `true` = no envía nada, solo registra |
| `ALEGRA_IVA_PCT` | `16` | Tasa de IVA del resumen contable |
| `ALEGRA_CUENTA_CONTINGENCIA` | `5101-004` | Cuenta de respaldo cuando la cuenta mapeada no existe en Alegra |
| `ALEGRA_CUENTA_CONTINGENCIA_CREDITO` | `1102-003` | Contrapartida de la cuenta de respaldo |

Secrets del módulo contable (vía `wrangler secret put`):

```bash
npx wrangler secret put ALEGRA_MCP_URL            # endpoint HTTP del MCP de Alegra
npx wrangler secret put ALEGRA_MCP_TOKEN          # bearer del MCP (si aplica)
npx wrangler secret put ALEGRA_IDEMPOTENCY_SALT   # salt de la idempotency key
```

Bucket de R2 (crear una vez):

```bash
npx wrangler r2 bucket create arkangel-contabilidad
```

### Identidad (nativa, sin proveedor externo)

La identidad del panel es **100% nativa**: la contraseña se verifica con PBKDF2
dentro del Worker y la sesión es un token aleatorio que D1 guarda **hasheado**.
No hay claves de API, ni cuenta que pagar, ni red de por medio.

| Pieza | Dónde vive | Qué hace |
|---|---|---|
| `users` | D1 | Correo, hash de la contraseña, `platform_role` (`user` / `super_admin`) y `email_verified_at` |
| `tenant_memberships` | D1 | Los despachos a los que pertenece el usuario y su rol (`owner` / `admin` / `member`) |
| `auth_sessions` | D1 | Sesiones activas: `token_hash` (SHA-256), `expires_at`, `revoked_at` |
| `auth_tokens` | D1 | Tokens de un solo uso para restablecer contraseña |
| `auth_rate_limits` | D1 | Ventana de intentos por correo e IP (login y registro) |
| Cookie `ark_session` | navegador | El token **en claro**, `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+ `Secure` en HTTPS) |

El panel **no** pide el `ADMIN_TOKEN`: entra con correo y contraseña. Ese token
sigue existiendo como break-glass, igual que `INTAKE_TOKEN` (CRM) y
`GROK_BOT_TOKEN` (agente).

## Puesta en marcha (identidad nativa)

El panel entra con **correo y contraseña**: no se pega ningún token. Los pasos, en orden:

1. **Aplicar las migraciones** (crean el esquema de autenticación y dan de baja
   lo que dejó Clerk en D1).

   ```bash
   npx wrangler d1 migrations apply arkangel-cobranza-db --remote
   ```

2. **Dar de alta al primer usuario.** El script pide el correo, la contraseña y
   el despacho, calcula el hash PBKDF2 e inserta el usuario (con el correo ya
   verificado) y su membresía.

   ```bash
   npm run seed:owner:remote -- --email duenio@arkangel.mx --password "una-clave-larga" --tenant t_arkangel --role owner
   ```

   Sin argumentos abre un prompt interactivo. El despacho tiene que existir en
   el catálogo (`SELECT id, slug FROM tenants;`).

3. **Entrar.** Abre el panel, teclea el correo y la contraseña. La sesión
   persiste al recargar y puedes cambiar de despacho desde el selector de la
   barra superior sin cerrar sesión.

Roles: la membresía `owner` da todo el alcance del despacho (incluida la
configuración legal); `admin` opera casos y dispara cobranza; `member` queda en
sólo lectura. La traducción está en `ROLE_POR_MEMBRESIA`
(`src/auth/native.ts`): es el único punto donde se decide qué puede hacer un
humano.

## API

Auth = sesión nativa (cookie `ark_session`) o token de máquina. Cada ruta exige
**su** scope: sin credencial → 401, con credencial pero sin scope → 403.

| Método | Ruta | Scope | Descripción |
|---|---|---|---|
| `POST` | `/api/auth/register` | público | Crea usuario + su primer despacho y abre sesión |
| `POST` | `/api/auth/login` | público | Verifica la contraseña y emite la cookie de sesión |
| `POST` | `/api/auth/logout` | sesión | Revoca la sesión y borra la cookie |
| `GET` | `/api/auth/session` | público | Devuelve el usuario y sus despachos si la cookie es válida |
| `POST` | `/api/auth/request-password-reset` | público | Envía el enlace de restablecimiento por correo |
| `POST` | `/api/auth/reset-password` | público | Consume el enlace y fija la nueva contraseña |
| `GET` | `/api/v1/health` | público | Liveness del worker |
| `POST` | `/api/v1/ingest/csv` | `ingest:write` | Ingesta del CSV (multipart, `text/csv` o JSON `{csv}`) |
| `GET` | `/api/v1/cases/today` | `cases:read` | Casos del día + vista previa (estado, canal, intención, próxima acción) |
| `GET` | `/api/v1/metrics/today` | `metrics:read` | Métricas del día (enviadas/respuestas/promesas) |
| `POST` | `/api/v1/disparar` | `cases:dispatch` | Encola todos los casos listos (el botón verde) |
| `GET` | `/api/v1/cases/:id` | `cases:read` | Detalle de un caso |
| `GET` | `/api/v1/clients/:id` | `clients:read` | Cliente + deudas pendientes |
| `GET` | `/api/v1/clients/:id/conversation` | `messages:read` | Historial de mensajes |
| `GET` | `/api/v1/legal/catalogo` | `legal:read` | Catálogo legal (12 reglas con ley, artículo y castigo) |
| `GET` | `/api/v1/legal/hoy` | `legal:read` | Resumen de cumplimiento del día + auditoría reciente |
| `GET` | `/api/v1/contabilidad/resumen` | `accounting:read` | Corte contable del día (JSON de R2, sin abrir Alegra) |
| `GET/POST` | `/webhooks/whatsapp` | firma de Meta | Verificación y mensajes/estados entrantes |
| `POST` | `/webhooks/telnyx` | firma Ed25519 | SMS entrantes y estados |
| `POST` | `/webhooks/resend` | — | Email entrante |

La cabecera `X-Tenant-Id` / `X-Tenant-Slug` **selecciona** el despacho en el que
se opera, pero sólo entre los que el usuario es miembro: pedir uno ajeno es
403 `tenant_forbidden`, no un cambio de alcance.


## Flujo del día

1. **6:00 AM** — el CRM (Clara) entrega el CSV a `POST /api/v1/ingest/csv`.
   El parser detecta columnas por heurística (nombre/tel/monto/vencimiento), reensambla
   separadores de miles sin comillas (`$8,450`), deduplica por teléfono normalizado y crea
   `clients` + `debts` + `cases` idempotentemente por `(cliente, fecha)`.
2. **Botón verde** — `POST /api/v1/disparar` encola los casos `ready` en la Queue.
3. **Consumidor** — por cada caso: verifica opt-in, promesa abierta, DND, ventana legal,
   dedupe 24 h y throttle; redacta con Workers AI; envía por el canal disponible
   (WhatsApp → SMS → email según banda de riesgo) y registra el mensaje.
4. **Entrada** — el webhook clasifica la respuesta (`paga`, `promete`, `rechaza`,
   `pide_factura`, `pide_info`, `molesto`), registra la promesa de pago, actualiza el caso y
   responde por el mismo canal. Si el cliente se molesta → `do_not_disturb` y caso a humano.

## Scoring "Sherman v2"

```
score = 0.7 · D1 + 0.3 · R2
D1 = min(días de retraso / 60, 1)
R2 = min(monto pendiente / $2,000, 1)
```

| Banda | Score | Prioridad de canal | Tono |
|---|---|---|---|
| `alto` | ≥ 0.66 | WhatsApp → SMS → email | firme pero no amenazante |
| `medio` | ≥ 0.33 | WhatsApp → email → SMS | directo |
| `bajo` | < 0.33 | email → WhatsApp → SMS | suave |

## Guardas de cobranza (ley como código)

Cada mensaje —de salida y de respuesta automática— pasa por el motor de cumplimiento
(`src/legal/`) antes de llegar al proveedor. Las 12 conductas del catálogo legal son
evaluadores ejecutables con `ley`, `articulo` y `castigo` associated:

| Regla | Conducta | Acción |
|---|---|---|
| 1.1 | Identidad corporativa (razón social + CONDUSEF) | SANITIZE → **BLOCK** si no hay razón social configurada |
| 1.2 | Representación sin poder legal | SANITIZE (elimina la frase) |
| 2.1 | Amenaza fuera de proceso | SANITIZE (elimina la frase) |
| 2.3 | Hostigamiento continuo (>3 impactos/24 h) | BLOCK |
| 2.4 | Horario prohibido (fuera de 08:00–22:00 CDMX) | BLOCK |
| 3.1 | Smishing / link apócrifo | SANITIZE (elimina URLs no autorizadas) |
| 3.2 | QR de pago no trazable (CLABE fuera de contrato) | BLOCK |
| 4.2 | Interés sobre interés no pactado | BLOCK |
| 4.4 | Extorsión por contactos | SANITIZE (elimina la frase) |
| 5.2 | Simulación de orden judicial | BLOCK |
| 8.1 | Monto contrato ≠ monto CRM | BLOCK |
| 8.7 | Falsedad de registros (CRM ≠ logs reales) | BLOCK |

- **Fail-closed**: si una conducta persiste tras la reparación, el mensaje no sale y el caso
  pasa a humano. No se lava un mensaje inválido por otro canal.
- **Ventana legal**: 08:00–22:00 hora CDMX (NOM-184-SCFI-2012, numeral 5.1.2).
- **Presupuesto de contactos**: máximo 3 impactos por deudor en 24 h (conteo real en D1).
- **Email** solo con opt-in explícito (`email_opt_in = 1`); WhatsApp/SMS con opt-in
  desconocido (`NULL`) sí se permiten en el primer contacto.
- Promesa de pago abierta → no se vuelve a molestar al cliente.
- `do_not_disturb` → no se contacta más y el caso pasa a humano.
- **Auditoría**: cada violación queda en `legal_audit` con su base legal (evidencia para
  CONDUSEF/PROFECO). Panel "Motor de cumplimiento" en el dashboard.

### Variables de cumplimiento

```bash
LEGAL_RAZON_SOCIAL=""                 # razón social registrada ante CONDUSEF (VACÍA = fail-closed)
LEGAL_CONDUSEF_REGISTRO=""            # registro CONDUSEF
ALLOWED_PAYMENT_DOMAINS=""            # allowlist de dominios de pago (VACÍA = sin links)
MAX_CONTACTS_PER_DAY=3
LEGAL_MONTO_TOLERANCIA_CENTS=0
LEGAL_HORARIO_EN_RESPUESTAS=false
```

**Estado actual en producción (fail-closed deliberado)**:

| Var | Valor | Consecuencia |
|---|---|---|
| `LEGAL_RAZON_SOCIAL` | `""` | el motor **bloquea todos los mensajes** (regla 1.1). El dashboard lo marca en rojo: `BLOQUEADO · FALTA RAZÓN SOCIAL` |
| `ALLOWED_PAYMENT_DOMAINS` | `""` | ningún link puede aparecer en un mensaje; sólo se referencia el medio de pago del contrato (regla 3.1) |

Para activar la cobranza hay que definir la razón social (y opcionalmente el registro
CONDUSEF). Basta con editar las vars y redesplegar:

```bash
# editar vars en wrangler.jsonc → LEGAL_RAZON_SOCIAL: "Arkelangel, S.A. de C.V."
npm run deploy
```

## Módulo Contable — Integración Alegra

El motor de cumplimiento no se queda en el log: **cada violación de compliance se
convierte en un asiento contable y se manda a Alegra vía MCP**, sin que el contador
tenga que tocar nada.

```
05:59 UTC = 23:59 CDMX (cron) → legal_audit + contracts + messages → payload (Zod)
                                                              │
                            ┌─────────────────────────────────┴─────────────────────┐
                            │                                                       │
                     R2: contabilidad/{fecha}.json                     MCP: alegra.create_journal_entry
                     (auditoría + fuente del reintento)               (1 asiento por violación)
```

El cron dispara a las **23:59 CDMX** (`59 5 * * *` UTC). El corte es el **día hábil
de CDMX anterior**, una jornada ya cerrada de punta a punta: nunca se parte la
ventana de contacto 08:00–22:00 y nunca hay carrera con el último minuto del día.
El payload declara su ventana en `ventana.{inicio,fin}_{utc,cdmx}`.

### Qué produce

| Concepto | Origen | Nota |
|---|---|---|
| `ingresos_reconocidos` | mensajes con recepción real + `contracts.monto_pactado_cents` | una vez por cliente |
| `ingresos_no_reconocidos_por_bloqueo` | casos con violación `BLOCK` | el ingreso no ocurrió |
| `provision_cartera_ilegal` | casos con cualquier violación mapeada | exposición cubierta por los asientos |
| `iva_trasladado` | `ALEGRA_IVA_PCT` sobre el ingreso reconocido | 16 % por defecto |
| `iva_acreditable_estimado` | `ALEGRA_IVA_PCT` sobre los asientos de tipo `gasto` | **estimado**: hoy no hay CFDI de proveedores |
| `asientos[]` | una fila por violación de `legal_audit` | `provisión` \| `gasto` \| `contingencia` |

Cada asiento trae `regla_id`, `ley`, `articulo`, `castigo`, `referencia_ledger`
(hash de la cadena append-only) y `legal_audit_id`: el asiento siempre se puede
rastrear hasta el registro de auditoría original.

### Reglas de reconocimiento de ingreso

> **Sólo se reconocen ingresos de mensajes en estado `delivered`, `read` o
> `promise_made`. `sent` no cuenta: el proveedor aceptó el envío, no hay prueba
> de que el deudor lo viera.**

La regla vive en `ESTADOS_INGRESO_RECONOCIDO` (`src/contabilidad/buildPayload.ts`)
y se publica en `metadata.regla_ingreso_reconocido` dentro del payload, para que
el contador vea con qué criterio se calculó el corte. `promise_made` está
reservado: hoy las promesas viven en la tabla `promises`, no en
`messages.status`.

El IVA acreditable se publica como **`iva_acreditable_estimado`** y el payload
incluye `metadata.fuente_iva_acreditable = "estimado_por_gastos_arkangel"`: es un
cálculo provisional sobre los gastos registrados, no un dato fiscal definitivo.
Cuando exista el módulo de CFDI de proveedores se sustituye por el real.

### CFDI: con CFDI o "provisión sin CFDI"

- **Con CFDI timbrado**: el asiento se referencia con el UUID del CFDI
  (`contract_cfdi.cfdi_uuid`) y queda ligado al ingreso real cobrado.
- **Sin CFDI** (lo normal cuando el bloqueo de compliance impidió la emisión):
  el asiento se crea como *Provisión sin CFDI* (`cfdi_relacionado: null`), que
  Alegra acepta.

### Cuentas contables: configuranse, no se hardcodean

`legal_accounting_map` mapea cada `regla_id` del catálogo legal a sus cuentas:

| `regla_id` | Debe | Haber | Tipo |
|---|---|---|---|
| 1.1, 1.2, 2.1, 2.3, 4.2 | `5101-001` | `1102-003` | `provision` |
| 2.4 | `6101-001` | `1102-003` | `gasto` |
| 3.1, 3.2, 4.4, 5.2, 8.1, 8.7 | `5101-002` / `5101-003` | `1102-003` | `contingencia` |

Antes de mandar, el Worker consulta `alegra.list_accounts` por MCP (con cache de
24 h en KV: una llamada al día, no una por asiento): **si la cuenta no existe en
Alegra**, el asiento usa la cuenta de *Provisión por Contingencia Legal*
(`ALEGRA_CUENTA_CONTINGENCIA`) y queda un evento accionable en `events`:

```json
{
  "type": "alegra_account_fallback",
  "regla_id": "2.1",
  "cuenta_esperada": "5101-001",
  "cuenta_usada": "5101-004",
  "motivo": "cuenta_no_existe_en_alegra",
  "accion_requerida": "Verificar catálogo de cuentas en Alegra"
}
```

Si una regla del catálogo no tiene mapeo contable, no genera asiento y deja el
warning `contabilidad.regla_sin_mapa`.

### Idempotencia y fail-closed

| Mecanismo | Qué evita |
|---|---|
| `alegra_sync.idempotency_key` (único) | Asentar dos veces el mismo corte (`SHA256(salt + fecha + registros + hash)`) |
| `alegra_journal_lines` | Duplicar un asiento a medio camino de un reintento |
| `ledger_checkpoint` | Mandar a Alegra con el ledger alterado |
| `ledger_integrity.verificado` | Cualquier envío cuando la cadena de hashes no cuadra |

- **Fail-closed**: si el ledger no verifica, el payload se guarda en R2 para
  revisión pero **no se envía** y se alerta con `events` tipo `ledger_broken`.
- **Reintentos**: si Alegra falla o expira, el reintento se reencola con backoff
  exponencial (2 h, 4 h, 8 h) y máximo 3 intentos; después la fila queda en
  `failed` y el humano ve el evento `alegra_sync`. Los errores JSON-RPC de tipo
  inválido (`-32600`) no se reintentan: son del payload, no de la red.

### Flujo de reconciliación (dos fases)

El envío es deliberadamente **de dos fases**, para que una caída de D1 no pueda
dejar un asiento duplicado en Alegra:

```
1. INSERT alegra_sync (status = 'pending', idempotency_key)
2. alegra.create_journal_entry  →  journal_id
3. INSERT alegra_journal_lines  (una fila por asiento)   ← ANTES del UPDATE
4. UPDATE alegra_sync (status = 'sent', alegra_journal_id)
```

Si el paso 4 falla, la fila queda en `pending`/`failed` **pero las líneas ya
están escritas**. En la siguiente corrida, `src/cron/reconciliacion.ts`:

- lista los cortes `pending`/`failed`;
- si no hay líneas → no se creó nada → reenvía el corte desde R2;
- si hay líneas → pregunta a Alegra (`alegra.list_journal_entries` filtrado por
  `idempotency_key`):
  - **todo existe** → marca el corte `reconciled`, sin duplicar nada;
  - **falta alguno** → re-crea sólo ese asiento (los demás se omiten porque su
    línea ya existe);
  - **no se puede confirmar** (el MCP no responde o la lista viene vacía) →
    **no** re-asienta: deja el corte pendiente y avisa con
    `alegra_reconciliacion_sin_confirmacion`.

La reconciliación corre al inicio de cada cron contable, antes del corte nuevo.

### Trazabilidad (auditor)

```
legal_audit.id ──► asiento.referencia_ledger + legal_audit_id
                └► alegra_journal_lines.alegra_journal_id  (asiento en Alegra)
                └► alegra_sync.alegra_journal_id           (corte del día)
```

### Pendientes de operación (antes de producción)

```bash
# 1. Salt de la idempotency key: evita colisiones y claves predecibles
npx wrangler secret put ALEGRA_IDEMPOTENCY_SALT

# 2. Endpoint y credencial del MCP de Alegra
npx wrangler secret put ALEGRA_MCP_URL
npx wrangler secret put ALEGRA_MCP_TOKEN

# 3. Bucket de R2 (los payloads del corte)
npx wrangler r2 bucket create arkangel-contabilidad

# 4. (opcional) Namespace KV dedicado al cache de cuentas
npx wrangler kv namespace create alegra_accounts_cache

# 5. Migración (incluye PRAGMA foreign_keys = ON — D1 no los activa solo)
npm run db:migrate
```

`PRAGMA foreign_keys = ON` debe ir **al inicio de cada migración** que use FKs:
D1 no los activa por defecto y, sin el PRAGMA, `contract_cfdi.contract_id` y
`alegra_journal_lines.alegra_sync_id` serían FKs decorativas.

### Endpoint

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://arkangel-cobranza.substrateholdingsai.workers.dev/api/v1/contabilidad/resumen?fecha=2026-10-19"
```

El `ADMIN_TOKEN` es el camino break-glass por línea de comandos: el panel ya no lo
pide, entra con la sesión nativa (correo y contraseña).

Devuelve el mismo JSON que el cron dejó en R2 (`idempotency_key`, `ventana`,
`resumen`, `desglose_bloqueos`, `asientos`, `ledger_integrity`, `metadata`). Sin
`fecha` devuelve el **último corte publicado** (el cron publica con un día de
rezago: el corte de "hoy" todavía no existe).

## Documentación

- `docs/arquitectura.md` — flujo, modelo de datos, IA, canales, idempotencia.
- `docs/runbook-cobranza.md` — operación diaria, troubleshooting y SQL útiles.
