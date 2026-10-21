# Runbook — Arkangel

## Contrato MCP de Alegra (CONGELADO)

**El contrato MCP está congelado por test**. Cualquier cambio en el servidor MCP de Alegra requiere actualizar **en el mismo PR**:

1. **Mock** en `tests/alegraMcp.test.ts` → suite *"Contrato MCP de Alegra (congelado por test)"*
2. **Documentación** en `docs/alegra-mcp-contract.md`
3. **Test** que valida el nuevo contrato

### Qué está validado (mock)
- ✅ `alegra.list_accounts` — nombres, args vacíos, respuesta normalizada
- ✅ `alegra.create_journal_entry` — nombres, args (referencia + partidas debe/haber), respuesta JSON en text
- ✅ `alegra.list_journal_entries` — **solo nombre del tool** (args y respuesta pendientes)
- ✅ Mapeo errores JSON-RPC → reintentable/no reintentable

### Qué está pendiente (servidor real)
- ❌ `alegra.list_accounts` — validar contra servidor real Alegra
- ❌ `alegra.create_journal_entry` — validar contra servidor real Alegra
- ❌ `alegra.list_journal_entries` — definir y validar args/respuesta completa

### Flujo de cambio de contrato
```bash
# 1. Cambiar servidor MCP
# 2. Ejecutar tests → FALLAN (contrato roto)
# 3. Actualizar mock en tests/alegraMcp.test.ts
# 4. Actualizar docs/alegra-mcp-contract.md
# 5. Ejecutar tests → PASS
# 6. Commit + PR con los 3 cambios juntos
```

**No hacer merge si el test de contrato falla.**

---

## CI / Verificación

El pipeline CI (`.github/workflows/ci.yml`) ejecuta `npm run verify` en cada push y PR a `main`:

```yaml
- name: Run verify (format, lint, typecheck, test, build)
  run: npm run verify
```

**Verificación local antes de push:**
```bash
npm run verify
# Debe quedar verde: format, lint, typecheck, test (212+), build
```

---

## Migraciones D1

```bash
# Local
npm run db:migrate:local

# Remota (producción)
npm run db:migrate
```

**Regla**: Nunca editar migraciones ya aplicadas en remoto (0001–0009). Nuevos cambios → migración nueva (0010+).

---

## Tenant por defecto (t_arkangel)

- `config_mode`: `db` (fuente de verdad = fila en D1)
- Identidad legal: `razon_social` + `condusef_registro` cargados
- Ventana horaria: 08:00–22:00 America/Mexico_City
- Allowlist dominios: `paga.arkangel.mx`

**Cambio a `config_mode='db'` solo tras verificar fila completa** (script `seed-tenant-config.ts`).

---

## Fail-closed legal

| Situación | Comportamiento |
|-----------|----------------|
| Tenant `db` sin `razon_social` | `TenantSinIdentidadLegalError` — bloquea envío, log accionable |
| Tenant `platform_env` sin identidad | Permitido (compatibilidad heredada) |
| Mensaje sin identidad legal (regla 1.1) | `SANITIZE` agrega pie legal; si persiste tras saneo → `BLOCK` |

---

## Verificación de cambio de contraseña (curl)

| Paso | Comando curl | Esperado |
|------|--------------|----------|
| 1. Login | `curl -X POST https://<worker>/api/auth/login -H "Content-Type: application/json" -d '{"email":"<user>","password":"<old>"}' -c cookies.txt` | 200 + `Set-Cookie: ark_session=...` |
| 2. Cambio de contraseña | `curl -X POST https://<worker>/api/auth/change-password -H "Content-Type: application/json" -b cookies.txt -d '{"current_password":"<old>","new_password":"<new>"}'` | 200 + `Set-Cookie: ark_session=; Max-Age=0` |
| 3. Cookie vieja no sirve | `curl -X GET https://<worker>/api/auth/session -b cookies.txt` | 401 (cookie limpiada) |
| 4. Login con nueva | `curl -X POST https://<worker>/api/auth/login -H "Content-Type: application/json" -d '{"email":"<user>","password":"<new>"}' -c cookies2.txt` | 200 + nueva `ark_session` |

**Tests automatizados**: 3 tests en `tests/authNative.test.ts` (`changePassword` suite) — todos verdes.

---

## Voz (Spike) — Fuera de alcance hasta decisión

Ver `docs/spike-voz.md` para veredicto go/no-go. No hay tablas `calls`/`transcripts` en producción.

---

## Contactos / Escalación

- **On-call**: Revisar logs en Cloudflare Workers (Observability)
- **Legal**: Cualquier `BLOCK` por motor legal → revisar `legal_audit` en D1
- **Contabilidad**: Fallos Alegra → reintento automático (3x) → `alegra_sync` status `pending_retry` → alerta humano