# Skill: Arkangel — Operación Diaria

Skill de cobranza inteligente y cumplimiento legal regulatorio (NOM-184 / CONDUSEF / PROFECO) para Grok Bot y agentes autónomos.

## Contenido de la carpeta

- **`SKILL.md`**: Instrucciones ejecutivas del sistema, reglas de priorización, flujo Human-in-the-Loop y directivas de seguridad fail-closed.
- **`tools.json`**: Especificación JSON Schema de las 8 herramientas (*Function Calling* / *MCP Tools*) que expone la API de Arkangel.

## Variables de Entorno y Headers requeridos

El bot debe inyectar las siguientes cabeceras en todas las peticiones a la API de Arkangel:

```http
Authorization: Bearer <TOKEN_DE_SERVICIO>
X-Tenant-Id: <ID_DEL_DESPACHO>
Content-Type: application/json
```

*(Opcionalmente, se admite la cabecera `x-grok-bot-token: <TOKEN>` configurada en las variables de entorno de Cloudflare Workers).*

## Cómo invocarlo

Desde la interfaz conversacional del bot:
- `/arkangel-operacion-diaria`
- *"Revisa la cartera de hoy"*
- *"Corre la operación diaria"*
- *"Prioriza y prepara la cobranza del día"*
