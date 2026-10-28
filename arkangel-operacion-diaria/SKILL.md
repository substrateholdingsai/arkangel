---
name: arkangel-operacion-diaria
description: Ejecuta la operación diaria de cobranza en Arkangel. Usar cuando el usuario pida revisar la cartera del día, priorizar casos, disparar campañas, gestionar promesas vencidas, o realizar la rutina matutina/vespertina de cobranza. Incluye priorización Sherman + solvencia Hermes, respeto estricto a NOM-184 y motor legal fail-closed.
---

# Arkangel — Operación Diaria

## 1. Cuándo usar este skill

Usa este skill cuando el usuario pida cualquiera de estas acciones:
- "Revisa la cartera de hoy"
- "Haz la operación diaria"
- "Prioriza y dispara la cobranza"
- "Gestiona las promesas vencidas"
- "Prepara el trabajo del día"
- "Corre la rutina matutina / vespertina"

No uses este skill para:
- Peritajes forenses profundos aislados (usa el skill de Hermes)
- Emisión masiva de sellos NOM-151
- Negociación individual compleja A2A
- Modificación de configuración del tenant o llaves bancarias

## 2. Inputs, Autenticación y Contexto Requeridos

Antes de ejecutar cualquier acción verifica:

1. **Autenticación en Arkangel**:
   - Cabeceras requeridas en cada petición HTTP:
     - `Authorization: Bearer <TOKEN>` o cabecera de servicio `x-grok-bot-token: <TOKEN>`
     - `X-Tenant-Id: <ID_DEL_DESPACHO>` (obligatorio para aislamiento multitenant)
2. **Permisos mínimos del token**:
   - `agent:read` o `cases:read`
   - `cases:dispatch`
   - `messages:send`
   - `metrics:read`
3. **Hora y Ventana NOM-184**:
   - Ventana legal de contacto: **08:00 a 22:00 (Lunes a Viernes)** hora local del deudor.
   - Límite estricto: **Máximo 3 intentos de contacto exitosos o fallidos por deudor en un período móvil de 24 horas**.

Si falta el `X-Tenant-Id` o el token de acceso, detente y solicítalo de inmediato al usuario antes de continuar.

## 3. Secuencia de Trabajo

Sigue este orden exacto:

### Paso 1 — Diagnóstico rápido del día
1. Llama a `get_daily_overview` (o `GET /api/v1/agent/state?date={date}` / `GET /api/v1/metrics/today`).
2. Llama a `list_cases_today` (o `GET /api/v1/cases/today`). Si hay más de 200 casos (`count > 200`), filtra específicamente por los de mayor urgencia (`status=promise_broken` y `status=ready`).
3. Consolida:
   - Total de casos activos en cartera
   - Casos con promesa vencida (`promise_broken`)
   - Casos en cola listos para contacto (`ready`)
   - Casos bloqueados temporalmente por alcanzar el límite de 3 contactos en 24h
   - Casos de alto valor que superan el umbral autónomo (`agent_auto_threshold_cents`)

### Paso 2 — Matriz de Priorización
Ordena los casos bajo la siguiente jerarquía estricta:
1. **Promesas rotas / vencidas**: Máxima urgencia de recuperación.
2. **Solvencia Clase A**: Casos con dictamen favorable reciente de Hermes.
3. **Score Sherman v2 más alto**: Casos con mayor propensión de pago y menor mora relativa.
4. **Casos sin contacto hoy**: Deudores que no han sido tocados en las últimas 24 horas.
5. **Resto de cartera**: Casos en seguimiento regular.

*Exclusión preventiva*: Marca y excluye de cualquier intento de contacto a deudores con `status = 'dnd'`, litigio activo, o que ya tengan 3 contactos registrados en las últimas 24h.

### Paso 3 — Propuesta de Acción y Plan (HITL)
Antes de detonar cualquier acción de salida, presenta al usuario el reporte estructurado:

```text
Resumen de Operación Diaria — [Fecha] — [Nombre del Despacho]
• Casos activos hoy: XX (Monto total: $XX,XXX MXN)
• Promesas vencidas críticas: XX
• Casos elegibles listos para contacto: XX
• Casos bloqueados por límite NOM-184 (24h): XX
• Casos que superan umbral (requieren supervisor): XX

Propuesta de Ejecución:
1. Llamar vía Voice AI Telnyx a los [X] casos de mayor prioridad (Promesas rotas / Clase A).
2. Disparar lote de mensajería preventiva a los [Y] casos en cola dentro de horario legal.
3. Escalar [Z] casos a operadores humanos por objeción legal o monto alto.
4. Solicitar peritaje Hermes en [N] casos de alto valor sin patrimonio localizado.

¿Apruebas la ejecución de este plan o deseas ajustar los parámetros?
```

### Paso 4 — Ejecución (Únicamente tras aprobación expresa)
Una vez que el usuario confirme:
- **Campaña Masiva**: Ejecuta `request_batch_dispatch` (`POST /api/v1/disparar`) para procesar la cola validada.
- **Llamadas Voice AI**: Ejecuta `trigger_voice_call` (`POST /api/v1/cases/:id/call`) para los casos prioritarios aprobados (máximo 5 llamadas continuas).
  - *Circuit Breaker*: Si 2 llamadas consecutivas fallan por error de red o límite de concurrencia, detén las llamadas y alerta al usuario.
- **Bitácora**: Registra notas internas con `add_internal_note` en aquellos casos que hayan sido escalados a humanos o que presenten incidencias.

### Paso 5 — Cierre y Reporte Final
Genera el informe de cierre de turno reportando:
- Acciones efectivamente completadas vs. pendientes.
- Lista de casos transferidos a supervisores humanos con su motivo.
- Métricas de cumplimiento: confirmación de 0 violaciones a NOM-184 y 0 mensajes fuera de ventana.

## 4. Validación de Calidad y Cumplimiento

Antes de dar por concluida la interacción verifica:
- [ ] No se contactó a ningún deudor fuera de la ventana 08:00–22:00 en su zona horaria.
- [ ] Ningún cliente superó el límite de 3 contactos en una ventana móvil de 24 horas.
- [ ] Ningún mensaje saliente infringió las 12 reglas del motor legal (cero amenazas, cero engaños judiciales, respeto a montos reales).
- [ ] No se ejecutó ninguna acción de salida sin confirmación expresa del usuario.

## 5. Acciones que Requieren Aprobación Humana Obligatoria

**NUNCA** ejecutes de manera autónoma sin autorización explícita:
- Disparo masivo de mensajes (`/disparar`).
- Detonación de llamadas Voice AI (`/call`).
- Cualquier mensaje libre directo al deudor (`/reply`).
- Solicitud de quitas, descuentos o convenios de pago fuera de política.
- Cambios de estado masivos a `dnd` (Do Not Disturb) o `escalated`.

**SÍ** puedes ejecutar sin pedir permiso:
- Consultar métricas, cartera y expedientes.
- Evaluar scores y pre-priorizar casos.
- Registrar notas de auditoría interna.
- Generar diagnósticos y propuestas de trabajo.
