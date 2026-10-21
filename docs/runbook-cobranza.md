# Runbook — Cobranza Arkangel

## Acceso al panel

El panel se abre con **correo y contraseña**: no se pega ningún token. La sesión
viaja en una cookie `ark_session` (`HttpOnly`, 30 días) y persiste al recargar.

- Si el panel no deja entrar, el alta del usuario se hace con el script de
  ownership (o con el propio formulario de registro del panel):

  ```bash
  npm run seed:owner:remote -- --email duenio@arkangel.mx --password "una-clave-larga" --tenant t_arkangel --role owner
  ```

- Si el login entra pero el panel no carga, la sesión existe pero el usuario no
  tiene ningún despacho: hace falta una fila en `tenant_memberships` (rol
  dentro del despacho) o `users.platform_role = 'super_admin'` (administrador
  de plataforma).
- Si el login responde 429, se agotaron los intentos: el cubo de rate limit
  caduca a los 15 minutos (login) o a la hora (registro).
- `ADMIN_TOKEN` sigue existiendo como **break-glass** para línea de comandos
  (`x-admin-token`). El panel ya no lo pide.

## Rutina diaria

| Hora | Actor | Acción |
|---|---|---|
| 6:00 AM | CRM (Clara) | `POST /api/v1/ingest/csv` con el CSV del día (header `x-intake-token`) |
| 6:05 AM | Agente humano | Abre el dashboard, revisa el chip **CSV RECIBIDO** y aprieta **DISPARAR COBRANZA DE HOY** |
| 8:00 AM | Sistema | Empieza la ventana legal de contacto |
| 22:00 PM | Sistema | Se cierra la ventana; lo que quede se difiere |
| Durante el día | IA | Responde inbound, registra promesas, escala a humano lo que no puede resolver |

Si `CRON_AUTO_FIRE=true`, el cron de las 6 AM dispara solo y el botón verde queda como
re-disparo manual.

## Verificación rápida

Estas llamadas usan el `ADMIN_TOKEN` de break-glass (el panel usa la cookie de
sesión):

```bash
BASE=https://arkangel-cobranza.substrateholdingsai.workers.dev

# liveness
curl -s $BASE/api/v1/health

# métricas del día (ADMIN_TOKEN)
curl -s -H "x-admin-token: $ADMIN_TOKEN" $BASE/api/v1/metrics/today

# cumplimiento legal del día
curl -s -H "x-admin-token: $ADMIN_TOKEN" $BASE/api/v1/legal/hoy

# casos del día
curl -s -H "x-admin-token: $ADMIN_TOKEN" $BASE/api/v1/cases/today

# disparo manual
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" $BASE/api/v1/disparar
```

Sin credencial estas rutas responden 401 `unauthorized`; con una credencial sin
scope, 403 `forbidden` (el body trae el scope pedido).

## SQL útiles

```bash
DB=arkangel-cobranza-db

# estado de los casos de hoy
npx wrangler d1 execute $DB --remote --command "SELECT name, status, score_band, amount_cents FROM cases WHERE case_date = date('now')"

# mensajes enviados hoy por canal
npx wrangler d1 execute $DB --remote --command "SELECT channel, COUNT(*) FROM messages WHERE direction='outbound' AND created_at LIKE date('now')||'%' GROUP BY channel"

# promesas abiertas (clientes a contactar)
npx wrangler d1 execute $DB --remote --command "SELECT client_id, amount_cents, promised_date FROM promises WHERE status='open'"

# clientes que pidió no molestar
npx wrangler d1 execute $DB --remote --command "SELECT id, name, phone FROM clients WHERE do_not_disturb = 1"

# auditoría
npx wrangler d1 execute $DB --remote --command "SELECT type, created_at, payload FROM events ORDER BY created_at DESC LIMIT 50"

# bitácora legal: qué se bloqueó y por qué
npx wrangler d1 execute $DB --remote --command "SELECT regla_id, accion, detalle, articulo, created_at FROM legal_audit ORDER BY created_at DESC LIMIT 50"

# resumen del día
npx wrangler d1 execute $DB --remote --command "SELECT accion, COUNT(*) FROM legal_audit WHERE created_at LIKE date('now')||'%' GROUP BY accion"

# catálogo de despachos
npx wrangler d1 execute $DB --remote --command "SELECT id, slug, nombre, status FROM tenants"

# roles concedidos por D1
npx wrangler d1 execute $DB --remote --command "SELECT user_id, tenant_id, role FROM tenant_memberships"

# administradores de plataforma
npx wrangler d1 execute $DB --remote --command "SELECT id, email FROM users WHERE platform_role = 'super_admin'"

# usuarios dados de alta
npx wrangler d1 execute $DB --remote --command "SELECT id, email, full_name, email_verified_at, created_at FROM users"

# sesiones activas (el token va hasheado: no se puede suplantar a nadie con esto)
npx wrangler d1 execute $DB --remote --command "SELECT user_id, expires_at, revoked_at, created_at FROM auth_sessions"
```

## Troubleshooting

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Dashboard dice "PENDIENTE" | el CSV no llegó o falló el intake | ver `events` con `type='intake.csv'` y `type='cron.csv_ausente'` |
| El login responde 401 | correo o contraseña incorrectos | probar con el `break-glass` (`ADMIN_TOKEN`) y revisar la fila en `users` |
| Login entra pero el panel no carga (401 `sin_membresia`) | el usuario no tiene ningún despacho | insertar la fila en `tenant_memberships` (`user_id`, `tenant_id`, `role`) |
| 403 `tenant_forbidden` | la cabecera `X-Tenant-Id` pide un despacho del que el usuario no es miembro | elegir otro despacho en el selector del panel; o dar de alta la membresía |
| 401 `unauthorized` al recargar | la sesión caducó o se revocó (30 días) | volver a iniciar sesión |
| 429 al intentar entrar | se agotaron los intentos de login | esperar 15 minutos; si se repite, revisar el cubo en `auth_rate_limits` |
| 403 `forbidden` | la credencial no tiene el scope que exige la ruta | revisar el rol de la membresía; en emergencias, `ADMIN_TOKEN` (break-glass) |
| 403 `tenant_mismatch` | la cabecera `X-Tenant-Id` no corresponde al principal | quitar la cabecera: el tenant sale de la membresía |
| "Token inválido o ausente" (en `curl`) | `ADMIN_TOKEN` distinto al secret | `npx wrangler secret list` y reescribir el secret |
| Casos en `failed` | ningún canal utilizable (opt-in o datos) | revisar `channel_state` y `clients.opt_in` |
| Casos en `human` con `channel_state` = `bloqueado:<regla>` | el motor legal bloqueó el mensaje | ver `legal_audit` y corregir (config, contrato o prompt) |
| Todo bloqueado con regla 1.1 | falta `LEGAL_RAZON_SOCIAL` | configurar la razón social registrada ante CONDUSEF |
| Casos en `ready` que no se disparan | fuera de la ventana legal (08–22 CDMX) | se difieren solos; para pruebas, `SEND_WINDOW_START=0` |
| Mensajes con `error` de Resend | falta `RESEND_API_KEY` | `npx wrangler secret put RESEND_API_KEY` |
| WhatsApp devuelve error de plantilla | falta `WHATSAPP_TEMPLATE_NAME` o la plantilla no está aprobada | aprobar la plantilla o mandar texto libre (solo dentro de 24 h de conversación) |
| Cola con mensajes acumulados | consumidor caído | `npx wrangler tail arkangel-cobranza` y revisar la DLQ |

## Contratos (para que las reglas 8.1, 3.2 y 4.2 sean exigibles)

Sin contrato registrado, esas tres reglas no pueden comparar y quedan inactivas. Alta manual:

```bash
npx wrangler d1 execute arkangel-cobranza-db --remote --command \
  "INSERT INTO contracts (id, client_id, monto_pactado_cents, clabe, nombre_legal, condusef)
   VALUES ('con_<cli_id>', '<cli_id>', 845000, '012180012345678901', 'Arkelangel, S.A. de C.V.', '123456')"
```

- `monto_pactado_cents`: monto firmado (regla 8.1 y 4.2).
- `clabe`: cuenta interbancaria del contrato (regla 3.2). Cualquier otra CLABE en un mensaje
  se bloquea.
- `nombre_legal` / `condusef`: identidad del contrato.

## Reinicio seguro

```bash
# 1. detener el disparo (deja de encolar)
#    -> las vars se cambian y se redeployan
npx wrangler deploy

# 2. limpiar la cola
npx wrangler queues delete-consumer arkangel-cobranza-queue   # si aplica
# o purgar los mensajes fallidos revisando la DLQ
npx wrangler queues list arkangel-cobranza-dlq
```

## Modo simulación (DRY_RUN)

Para probar sin enviar nada a clientes reales:

```bash
# en wrangler.jsonc -> vars.DRY_RUN = "true"
npx wrangler deploy
# ... prueba ...
# devolver a "false" y redesplegar
```

Con `DRY_RUN=true` los envíos se registran en `messages` con `provider_id = dry_run_*` y
nada sale a Meta, Telnyx ni Resend.
