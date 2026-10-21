# Contrato MCP de Alegra (CONGELADO)

> **Este contrato está congelado por test**. Cualquier cambio en el servidor MCP de Alegra requiere:
> 1. Actualizar el mock en `tests/alegraMcp.test.ts` (suite "Contrato MCP de Alegra (congelado por test)")
> 2. Actualizar este documento
> 3. Actualizar el test en el mismo PR

---

## Tools expuestos por el servidor MCP

| Tool | Descripción | Validado contra mock | Validado contra servidor real |
|------|-------------|---------------------|------------------------------|
| `alegra.list_accounts` | Lista el catálogo de cuentas contables | ✅ | ❌ Pendiente |
| `alegra.create_journal_entry` | Crea un asiento contable (journal entry) | ✅ | ❌ Pendiente |
| `alegra.list_journal_entries` | Lista asientos contables existentes | ✅ (solo nombre) | ❌ Pendiente |

---

## `alegra.list_accounts`

### Argumentos
```json
{}
```
(Sin argumentos)

### Respuesta exitosa
```json
{
  "content": [
    {
      "type": "text",
      "text": "[{\"codigo\":\"5101-001\",\"nombre\":\"Gastos de cobranza\"},{\"codigo\":\"1102-003\",\"nombre\":\"Provisión por cartera ilegal\"}]"
    }
  ]
}
```

### Formato de cada cuenta
- `codigo` (string): Código de la cuenta en el plan de cuentas de Alegra
- `nombre` (string): Nombre descriptivo de la cuenta

> **Nota**: El servidor puede devolver `code`/`name` en lugar de `codigo`/`nombre`; el cliente normaliza ambos formatos.

### Errores mapeados
| Código JSON-RPC | Significado | Reintentable | Acción |
|-----------------|-------------|--------------|--------|
| `-32600` | Invalid Request | ❌ No | Fallo inmediato, alertar humano |
| `-32602` | Invalid params | ❌ No | Fallo inmediato, alertar humano |
| `-32603` | Internal error | ✅ Sí | Reintentar con backoff exponencial |
| `-32000` | Server error | ✅ Sí | Reintentar con backoff exponencial |

---

## `alegra.create_journal_entry`

### Argumentos
```json
{
  "referencia": "legal_audit:leg_123 | ledger:0xabc123...",
  "partidas": [
    { "cuenta": "5101-001", "debe": 800, "haber": 0 },
    { "cuenta": "1102-003", "debe": 0, "haber": 800 }
  ]
}
```

### Reglas de validación (fail-closed en el test)
1. `referencia` es string obligatorio, debe contener `legal_audit:` y `ledger:`
2. `partidas` es array con **mínimo 2 elementos** (partida doble)
3. Cada partida tiene **exactamente** 3 claves: `cuenta` (string), `debe` (number), `haber` (number)
4. En cada partida, **uno y solo uno** de `debe`/`haber` es > 0 (el otro es 0)
5. La suma de `debe` == suma de `haber` (balance contable)

### Respuesta exitosa
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"id\":\"jest_42\"}"
    }
  ]
}
```

### Formato de respuesta
- El `content[0].text` es un **string JSON** que contiene `{ "id": "..." }`
- El `id` es el identificador del journal entry creado en Alegra

### Errores mapeados
| Código JSON-RPC | Significado | Reintentable | Acción |
|-----------------|-------------|--------------|--------|
| `-32600` | Invalid Request | ❌ No | Fallo inmediato, alertar humano |
| `-32602` | Invalid params (ej. cuenta inexistente) | ❌ No | Fallo inmediato, alertar humano |
| `-32603` | Internal error | ✅ Sí | Reintentar con backoff exponencial |
| `-32000` | Server error | ✅ Sí | Reintentar con backoff exponencial |

---

## `alegra.list_journal_entries`

### Argumentos
```json
{
  "fecha_desde": "2026-10-01",
  "fecha_hasta": "2026-10-31"
}
```

### Respuesta exitosa
```json
{
  "content": [
    {
      "type": "text",
      "text": "[{\"id\":\"jest_42\",\"fecha\":\"2026-10-19\",\"referencia\":\"legal_audit:leg_1 | ledger:0xabc\",\"partidas\":[{\"cuenta\":\"5101-001\",\"debe\":800,\"haber\":0},{\"cuenta\":\"1102-003\",\"debe\":0,\"haber\":800}]}]"
    }
  ]
}
```

> **Estado**: Solo el nombre del tool está validado en el test. La forma de argumentos y respuesta está **pendiente de validación contra servidor real**.

---

## Protocolo de inicialización MCP

El cliente `AlegraMcpClient` sigue el protocolo MCP estándar:

1. **POST** a la URL del servidor con `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
2. El servidor responde con `mcp-session-id` en headers y capabilities
3. El cliente cachea la sesión en KV (`mcp:session`) por 24h
4. Requests subsecuentes usan `tools/call` con la sesión cacheada

### Headers esperados
| Header | Valor | Descripción |
|--------|-------|-------------|
| `mcp-session-id` | `ses_...` | Identificador de sesión MCP (obligatorio tras initialize) |
| `content-type` | `application/json` | Para requests/responses JSON-RPC |
| `content-type` | `text/event-stream` | Para responses SSE (soportado por el cliente) |

---

## Errores y reintentos

### Códigos no reintentables (fail-fast)
- `-32600` Invalid Request
- `-32602` Invalid params

Estos indican un **error de contrato** (cliente o servidor mal configurado). No se reintentan; se lanza error inmediatamente para alertar a humano.

### Códigos reintentables (backoff exponencial)
- `-32603` Internal error
- `-32000` Server error
- Timeouts de red
- 5xx HTTP

Configuración de reintentos en `AlegraMcpClient`:
- `retries: 3` (por defecto)
- Backoff: 1s, 2s, 4s (exponencial con jitter)
- Timeout por request: 30s

---

## Validación del contrato en CI

El test `tests/alegraMcp.test.ts` suite **"Contrato MCP de Alegra (congelado por test)"** valida:

1. ✅ Nombres de tool exactos
2. ✅ Forma de argumentos de `create_journal_entry` (partidas debe/haber)
3. ✅ Formato de respuesta de `create_journal_entry` (JSON dentro de text)
4. ✅ Formato de respuesta de `list_accounts` (normalización code->codigo, name->nombre)
5. ✅ Mapeo de errores JSON-RPC a errores no reintentables

**Si este test falla**: El contrato MCP ha cambiado. No hacer merge hasta actualizar mock + doc + test en el mismo PR.

---

## Próximos pasos para validar contra servidor real

| Tool | Estado | Acción requerida |
|------|--------|------------------|
| `alegra.list_accounts` | ✅ Mock validado | Probar contra servidor real de Alegra |
| `alegra.create_journal_entry` | ✅ Mock validado | Probar contra servidor real de Alegra |
| `alegra.list_journal_entries` | ⚠️ Solo nombre | Definir argumentos/respuesta + validar contra real |

---

## Referencias

- Test de contrato: `tests/alegraMcp.test.ts` (líneas ~283-450)
- Cliente: `src/contabilidad/alegraClient.ts`
- Runbook: `RUNBOOK.md` (sección "Contrato MCP Alegra")