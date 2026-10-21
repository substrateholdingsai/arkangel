# Spike D · Voz end-to-end (experimental)

> **Estado: ⏳ EN PROGRESO — la implementación está completa y en CI, pero NO se
> pudo ejecutar ni una llamada real.** Faltan credenciales de Deepgram y de
> Cloudflare Realtime (ver "Credenciales"). Por eso **no hay p50/p95 reales**:
> las tablas de métricas están vacías a propósito y no se rellenan con números
> inventados.
>
> Fecha de la última revisión: **2026-10-21**. Tarifas consultadas el
> **2026-10-21** (enlaces al final de cada sección).

---

## 1. Resumen ejecutivo

| | |
| --- | --- |
| ¿Se construyó la cadena completa? | Sí: DO por llamada, signaling, STT, LLM, TTS, barge-in, métricas y cliente de navegador. |
| ¿Se ejecutó una llamada real? | **No** — faltan credenciales de los dos proveedores. |
| ¿Hay p50/p95 sobre 20 llamadas? | **No** — no hay datos. El arnés está escrito y es un comando. |
| ¿Hay tabla de costos con tarifas reales? | **Sí**, con la tarifa vigente de cada proveedor (consultada 2026-10-21). |
| Veredicto | **NO VERIFICADO** (ni GO ni NO-GO): sin medición no hay evidencia. Lo que sí sabemos es que el costo estimado está por debajo del umbral propuesto; el riesgo abierto es la latencia, no el dinero. |

---

## 2. Qué cambió respecto al plan original

| Decisión del plan | Estado | Nota |
| --- | --- | --- |
| WebRTC con **Cloudflare Calls** | **Renombrado, mismo proveedor** | "Cloudflare Calls" ya no existe como producto: su documentación redirige a **Cloudflare Realtime** (RealtimeKit / Realtime SFU). Se mantiene la decisión de proveedor — misma cuenta, misma Facturación, sin salir de Cloudflare. La ruta de navegador es el SDK `@cloudflare/realtimekit` (Web Components, sin React). |
| **Deepgram Nova-2 / Aura** en español | Se mantiene, **con las tarifas corregidas** | Nova-2 en streaming cuesta **$0.35/hora** ($0.00583/min), no $0.0043/min (esa es la tarifa *prerecordada* de Nova-3). Aura se factura **por 1,000 caracteres**, no por minuto. |
| **Workers AI (Llama 3.3)** vía `agent.ts`, sin modificarlo | Se mantiene | `redactMessage` en modo lectura: el bot redacta el aviso y lo dice en voz alta. `src/ai/agent.ts` no se tocó. |
| **Un Durable Object por llamada** | Se mantiene, con el patrón de `call-lock` | Clase con `fetch` (sin heredar de `DurableObject`) para que el estado sea testeable en vitest sin workerd. |
| **Sin tablas calls/transcripts/recordings en producción** | Se mantiene | Sólo `spike_calls` (migración `0010_spike_calls.sql`, experimental, con `tenant_id`). **No se guarda audio ni transcripción**: sólo números de latencia. |
| **Sin ledger ni contabilidad** | Se mantiene | El spike no toca `agent.ts` para decidir, no llama al motor legal ni al ledger. |
| Ruta de spike sin flag | Se mantiene, y se endurece | `SPIKE_VOZ_ENABLED` (off por defecto) **y credencial obligatoria** (token de administración o sesión). Apagado = 404, no 403. |
| Métricas con `traceId` | Se mantiene | Cada llamada lleva su `traceId` W3C; logs, eventos y métricas se correlacionan con él. |

---

## 3. Arquitectura implementada

```
navegador (spike/index.html, sin React)
   │
   │  ① POST /spike/call ─────────────────► Worker ──► Cloudflare Realtime
   │        (authToken + meetingId)            │            (reunión + participante)
   │                                           │
   │  ② WebSocket /spike/call/:id/audio ◄──────┤
   │        PCM 16 kHz ───────────────────────►│
   │                                           ▼
   │                                   ┌───────────────────────┐
   │                                   │  CallSessionDO        │  (uno por llamada)
   │                                   │  idle→ringing→        │
   │                                   │  active→ended         │
   │                                   │  métricas + traceId   │
   │                                   └───────┬───────────────┘
   │                                           │
   │                  ┌────────────────────────┼────────────────────────┐
   │                  ▼                        ▼                        ▼
   │            Deepgram STT          Workers AI (Llama 3.3)      Deepgram TTS
   │            (nova-2, es)         redactMessage (sólo lectura)  (aura-2, es-mx)
   │                  │                        │                        │
   │                  └── parciales ──────────┴── barge-in: corta TTS ──┘
   │                                                        │
   │  ③ audio PCM 24 kHz ◄─────────────────────────────────┘
```

### Archivos

| Archivo | Qué es |
| --- | --- |
| `src/durable/call-session.ts` | `CallSessionDO`: estado de la llamada, `traceId`, muestras de métricas, canal de signaling. |
| `src/orquestacion/voice.ts` | Pipeline STT → LLM → TTS, barge-in y emisión de métricas por turno. |
| `src/voice/stt.ts` | Cliente de transcripción en streaming de Deepgram (WebSocket, `nova-2`, `es`). |
| `src/voice/tts.ts` | Cliente de síntesis en streaming de Deepgram (WebSocket, `aura-2`, voz `estrella-es` de México). |
| `src/routes/spike.ts` | Rutas del spike, detrás de `SPIKE_VOZ_ENABLED` y de credencial. |
| `src/lib/medidas.ts` | Percentiles (nearest rank) y resumen p50/p95. |
| `spike/index.html` | Cliente mínimo: botón "Llamar", WebRTC nativo, captura de micrófono, reproducción y barge-in. |
| `scripts/spike-voz.ts` | Arnés de las 20 llamadas con guion fijo de 3 turnos; calcula p50/p95. |
| `migrations/0010_spike_calls.sql` | Tabla experimental `spike_calls` (con `tenant_id`, sin audio ni transcripciones). |
| `tests/spikeVoz.test.ts` | 18 tests: percentiles, DO (estado, métricas, barge-in, cierre) y pipeline con dobles. |

### Qué NO hace el spike

- No guarda audio, ni transcripciones, niDerivados del audio.
- No llama a contactos reales: el deudor es un registro de prueba.
- No toca el ledger legal, la contabilidad ni `agent.ts`.
- No manda nada por WhatsApp/SMS/email.

---

## 4. Métricas (definiciones exactas)

| Métrica | Definición | Nota |
| --- | --- | --- |
| `stt_partial_ms` | Desde el inicio del turno de audio del usuario hasta el **primer parcial** del STT. | "Empezó a entender". |
| `stt_final_ms` | Desde el inicio del turno hasta la **transcripción final**. | "Cerró la frase". |
| `llm_first_token_ms` | Desde el envío al LLM hasta el primer token observable. | ⚠️ Con `redactMessage` la llamada a Workers AI **no es streaming**: el primer token observable llega con la respuesta completa, así que hoy `llm_first_token_ms == llm_total_ms`. Deuda: variante streaming del agente (Sprint 6). |
| `llm_total_ms` | Desde el envío al LLM hasta la respuesta completa. | |
| `tts_first_chunk_ms` | Desde el inicio de la locución hasta el **primer fragmento de audio**. | |
| `round_trip_ms` | Desde el **final de la transcripción** del usuario hasta el **primer audio** de la respuesta. | Es la métrica de cabecera: lo que el usuario siente. |
| `barge_in_latency_ms` | Desde el primer indicio de voz del usuario (primer parcial del STT **mientras el bot habla**) hasta que el TTS queda cortado. | La latencia acústica (voz→corte) la mide el navegador con su VAD y se reporta aparte. |

### Resultado de las 20 llamadas

| métrica | n | p50 (ms) | p95 (ms) |
| --- | ---: | ---: | ---: |
| `stt_partial_ms` | 0 | — | — |
| `stt_final_ms` | 0 | — | — |
| `llm_first_token_ms` | 0 | — | — |
| `llm_total_ms` | 0 | — | — |
| `tts_first_chunk_ms` | 0 | — | — |
| `round_trip_ms` | 0 | — | — |
| `barge_in_latency_ms` | 0 | — | — |

> **Vacía a propósito.** El arnés (`scripts/spike-voz.ts`) llena esta tabla en
> cuanto haya credenciales y un WAV con el guion hablado. No se estima nada a
> ojo: una métrica inventada es peor que una métrica ausente.

### Cómo correr las 20 llamadas

```bash
# 1) El Worker con el flag y las credenciales (local o staging).
#    SPIKE_VOZ_ENABLED=true DEEPGRAM_API_KEY=… CF_REALTIME_API_TOKEN=… npx wrangler dev

# 2) El guion hablado: WAV mono 16 kHz con 3 turnos (pausas entre turnos).
#    Se puede generar con cualquier TTS; que sea voz real, no un tono.

# 3) El arnés.
SPIKE_BASE_URL=http://localhost:8787 \
SPIKE_ADMIN_TOKEN=… \
SPIKE_AUDIO_PATH=./spike/guion.wav \
npx tsx scripts/spike-voz.ts
```

Imprime la tabla de p50/p95 y deja un renglón por llamada con su `traceId`.

---

## 5. Costo por minuto

### Tarifas (consultadas el 2026-10-21)

| Concepto | Tarifa | Fuente |
| --- | --- | --- |
| Cloudflare RealtimeKit · participante **sólo audio** | **$0.0005 / min** | [RealtimeKit pricing](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/) |
| Cloudflare RealtimeKit · participante audio + video | $0.002 / min | idem |
| Cloudflare RealtimeKit · **export/grabación** (RTMP/HLS) | $0.010 / min (audio solo $0.003) | idem |
| Cloudflare RealtimeKit · export de RTP crudo a R2 | $0.0005 / min | idem |
| Deepgram STT **streaming** · Nova-2 (el del spike) | $0.35 / hora = $0.00583 / min | [Deepgram pricing](https://deepgram.com/pricing) |
| Deepgram STT **streaming** · Nova-3 monolingual (alternativa) | $0.29 / hora = $0.00483 / min | idem |
| Deepgram STT **streaming** · Flux English (alternativa) | $0.39 / hora = $0.0065 / min | idem |
| Deepgram TTS · **Aura-2** (el del spike) | **$0.030 / 1,000 caracteres** | idem |
| Deepgram TTS · Aura-1 (alternativa más barata) | $0.015 / 1,000 caracteres | idem |
| Workers AI · `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | $0.293 / M tokens de entrada · $2.253 / M de salida | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Workers AI · cuota diaria gratuita | 10,000 neuronas/día | idem |

### Modelo (1 minuto de conversación)

Supuestos: el usuario habla la mitad del minuto (30 s) y el bot la otra mitad;
el español hablado son ~150 palabras/min ≈ 900 caracteres/min; una respuesta
del bot ≈ 120 tokens de salida y el prompt ≈ 400 tokens de entrada.

| Concepto | Consumo | USD / minuto |
| --- | --- | ---: |
| RealtimeKit · participante sólo audio | 1 participante | $0.00050 |
| Deepgram STT Nova-2 (streaming) | 0.5 min de audio | $0.00292 |
| Deepgram TTS Aura-2 | ~450 caracteres | $0.01350 |
| Workers AI Llama 3.3 | ~400 in + ~120 out tokens | $0.00039 |
| **Total del spike tal como está** | | **$0.0173 / min** |
| Total con Nova-3 + Aura-1 (más barato) | | $0.0101 / min |
| Total con participante de audio + video | | $0.0188 / min |
| Total **con grabación** (export $0.010/min) | | $0.0273 / min |

### Umbral propuesto

**$0.03 / minuto de conversación** (~$0.57 MXN/min a ~19 MXN/USD, tipo de
cambio a verificar antes de decidir).

Justificación: una llamada de cobranza de 5 minutos costaría **$0.087 USD
(~1.7 MXN)**, muy por debajo de una llamada humana (~10 MXN/min) y por debajo
del valor de recuperar un solo pago mínimo. Con margen: el total medido
($0.0173/min) queda **42 % por debajo** del umbral, y con las alternativas
baratas (Nova-3 + Aura-1) baja a 66 % por debajo. El costo **no** es el
riesgo de esta técnica; la latencia sí.

---

## 6. Veredicto

**NO VERIFICADO.** No se puede emitir GO ni NO-GO sin evidencia: no se
ejecutó ninguna llamada real, así que los tres criterios del veredicto
(round-trip p95 < 1500 ms, barge-in funcionando, costo < umbral) **no están
evaluados**.

Lo que sí se puede afirmar con los números de arriba:

1. **Costo: probablemente GO.** $0.0173/min estimado contra un umbral de
   $0.03/min. incluso con grabación (que no vamos a usar) sigue debajo.
2. **Latencia: desconocido.** Es el criterio que puede tumbar el spike. La
   cadena tiene tres saltos de red (STT, LLM, TTS) y el criterio es
   `round_trip_ms p95 < 1500 ms`. Con las latencias típicas de streaming
   (STT ~200-400 ms, LLM ~300-800 ms, TTS ~150-400 ms) **estaría justo por
   debajo del límite**, sin holgura: por eso el criterio es p95 y no media.
3. **Barge-in: implementado, sin medir.** El corte lo decide el STT (un
   parcial mientras el bot habla). Con `nova-2` el primer parcial llega en
   ~200-400 ms de voz: la interrupción se oirá con ese retraso.

**Veredicto provisional si las 20 llamadas salen bien: GO condicionado a**
(1) que el `round_trip_ms` p95 quede < 1500 ms, (2) que el barge-in se
perciba (corte < 500 ms tras la interrupción) y (3) que la llamada se
mantenga por debajo de $0.03/min, que es lo que dice el modelo de costos de
arriba. **Si el p95 se pasa de 1500 ms: NO-GO**, y el ajuste barato sería
bajar el LLM a un modelo más chico (`@cf/meta/llama-3.2-3b-instruct`,
$0.051/M in, $0.335/M out) — pero eso exige revisar los prompts de cobranza
de `agent.ts`, que hoy están calibrados para el modelo grande.

### Qué falta para poder emitir el veredicto (bloqueo exacto)

| # | Falta | Dónde |
| --- | --- | --- |
| 1 | `DEEPGRAM_API_KEY` (cuenta con crédito; Deepgram da $200 de crédito sin tarjeta) | secreto del Worker |
| 2 | `CF_REALTIME_API_TOKEN` con permiso **Realtime / Realtime Admin** + `CF_REALTIME_APP_ID` + `CF_REALTIME_ACCOUNT_ID` + `CF_REALTIME_PRESET_NAME` (preset "audio only") | secreto del Worker |
| 3 | `SPIKE_VOZ_ENABLED=true` en el entorno donde se corra | var |
| 4 | Un WAV con el **guion hablado** de 3 turnos (voz real, 16 kHz mono) | `spike/guion.wav` |
| 5 | Un navegador con micrófono para el WebRTC (el arnés de Node no media: la llamada es del navegador) | equipo de quien corre el spike |

**Alternativa propuesta si Deepgram no llegara:** Workers AI ya expone los
modelos de Deepgram (`@cf/deepgram/nova-3` para STT y
`@cf/deepgram/aura-2-es` para TTS) con el mismo binding `AI` que ya usa el
proyecto — sin cuenta nueva. Coste: STT $0.0092/min-audio (WebSocket) y TTS
$0.030/1k caracteres (igual que directo), o sea ~$0.013/min de STT frente a
$0.0029 con la API directa. **No se cambió de proveedor en silencio**: es la
misma casa (Deepgram) y está documentado aquí como alternativa, no aplicada.

---

## 7. Credenciales por tenant (para Sprint 6, **no aplicado**)

Hoy las credenciales de voz serían **de la plataforma** (una sola cuenta de
Deepgram y una sola app de Realtime), igual que hoy funciona WhatsApp con una
cuenta de la plataforma. Cuando cada tenant traiga su propia cuenta, la
migración futura sería la **0011**:

```sql
-- Propuesta (NO aplicada): tabla propia para voz.
-- Motivo: `tenant_channels.channel` tiene CHECK (channel IN
-- ('whatsapp','sms','email')). Meter 'voice' ahí obliga a alterar un CHECK
-- que hoy comparten tres canales y que el motor legal lee.
CREATE TABLE tenant_voice_channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('realtime', 'telnyx', 'twilio')),
  provider_account_id TEXT,
  credentials TEXT,
  voice TEXT,                       -- voz de Aura (es-mx)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tenant_voice_channels_tenant ON tenant_voice_channels(tenant_id, provider);
```

Puntos que la migración 0011 tiene que resolver:
1. **El CHECK de `tenant_channels`**: o se extiende a `'voice'` (y se revisa
   todo lo que lee `channel`), o se usa la tabla aparte (propuesta aquí).
2. **La identidad de la llamada**: el número de salida, el nombre de la
   campaña y el texto del aviso de llamada grabada, por tenant.
3. **La voz**: elegir la voz de Aura por tenant (mexicana,Colsombiana…) y por
   deudor, sin que el LLM pueda inventarla (va en el prompt, no en el texto).
4. **El `tenant_id` va en la llamada**: la tabla `spike_calls` ya lo lleva y
   `spike/` exige un tenant existente (404 si no).

---

## 8. Riesgos legales nuevos (enlazados a Bloque A)

Bloque A = aviso de grabación, retención, ventana horaria e identidad. Lo que
cambia al añadir voz:

| # | Riesgo | Cómo queda en el spike | Qué hay que decidir en Sprint 6 |
| --- | --- | --- | --- |
| 1 | **La voz es un canal de salida nuevo** y el motor legal no lo conoce: hoy valida `'whatsapp' \| 'sms' \| 'email'`. Una llamada de voz debe pasar por la **ventana horaria** (`SEND_WINDOW_START/END`, `LEGAL_HORARIO_EN_RESPUESTAS`) igual que un mensaje. | El spike no llama a nadie real, así que no hay exposición. | Que la llamada reuse el mismo candado de ventana horaria que el resto de los canales. |
| 2 | **Transparencia: el prompt de `agent.ts` dice "No menciones que eres una IA"** (regla 13 de `SYSTEM_REDACT`). En **voz** eso choca de frente con la obligación de informar que la llamada es automatizada: por teléfono el oyente no puede saber que no es una persona. | El spike lee el texto de `redactMessage` tal cual. | **Un prompt de voz propio** (Sprint 6) que sí se identifique como llamada automatizada, y una frase de apertura obligatoria. Es el punto legal más delicado del spike. |
| 3 | **Grabación**: RealtimeKit tiene "export" (grabación/RTMP) a $0.010/min. El spike **no** lo activa. Si alguien lo activara sin más, quedaría una grabación del deudor sin aviso → violates Bloque A. | No hay export configurado en la creación de la reunión. | El aviso de grabación (Bloque A) debe ser **condición** para poder activar el export; el export no se enciende por defecto y su costo entra en el modelo. |
| 4 | **Retención**: el audio y la transcripción no se guardan; sólo números de latencia. El retention del audio es responsabilidad de los proveedores (Deepgram no guarda audio en su API en streaming; RealtimeKit sólo guarda lo que se exporte). | Sin audio, sin transcripción, sin `recordings`. | Política escrita de "no se graba" + cómo se verifica. |
| 5 | **Transferencia de datos fuera de México**: la voz del deudor viaja a Deepgram (EE. UU.) y a Cloudflare. Es tratamiento de datos personales por terceros. | El spike lo hace con datos de prueba, no de deudores reales. | Aviso de privacidad que nombre a los proveedores y base de la transferencia. |
| 6 | **Datos biométricos**: la voz es un dato biométrico bajo la LFPDPPP. Como no se almacena audio, no se procesa ningún dato biométrico que active esa categoría; si en el futuro se guarda la voz (para mejor ASR o para QA), eso cambia de categoría. | No se guarda audio. | Si Sprint 6 guarda audio de QA: consentimiento expreso y retención corta. |
| 7 | **Identidad**: la locución ya incluye la firma (`— {razón social} · Reg. CONDUSEF {registro}`) porque `redactMessage` la pone. Al hablar en voz alta esa firma se oye: hay que confirmar que es suficiente. | La firma se lee en voz alta. | Validar el texto de la llamada con asesoría legal antes de producción. |

---

## 9. Qué falta para Sprint 6 (si el veredicto fuera go / go condicionado)

1. **Migración 0011** con credenciales de voz por tenant (`tenant_voice_channels`).
2. **Modelo de dominio**: `calls`, `transcripts` y `recordings` (hoy no existen;
   el spike sólo tiene `spike_calls`, experimental).
3. **Prompt de voz** propio (con la identificación de llamada automatizada) y
   `agent.ts` con streaming para que `llm_first_token_ms` signifique algo.
4. **Canal de voz en el motor legal**: ventana horaria, tono, y las mismas
   reglas de contenido que los demás canales.
5. **Cliente real** en `frontend/` (el spike usa `spike/index.html`, fuera del
   panel, a propósito).
6. **Proveedor de salida telefónica**: hoy el spike usa sólo WebRTC
   (navegador ↔ Cloudflare). Para llamar a un teléfono fijo o móvil hace falta
   SIP: Cloudflare Calls/Realtime con trunk SIP, o Telnyx Voice / Twilio. Es
   la decisión de proveedor que Sprint 6 debe cerrar (y es la que justifica
   haber usado "Cloudflare Calls" en el plan original).
7. **Métricas en observabilidad**: hoy las métricas viven en el DO y en
   `spike_calls`; en producción irían a la plataforma de métricas.

---

## 10. Deuda residual

- `llm_first_token_ms` no es independiente de `llm_total_ms` mientras el
  agente no tenga modo streaming.
- El `traceId` viaja del HTTP al DO y a los logs, pero **no** a Deepgram ni a
  Realtime (no admiten cabeceras de traza en la WSS de audio): la correlación
  con el proveedor se hace por `callId` + marca de tiempo.
- El `CallSessionDO` guarda su estado en `ctx.storage`, pero la ruta `/spike`
  **no escribe** en `spike_calls`: la tabla está creada (migración 0010) y el
  arnés lee las métricas del DO. Escribir la fila por llamada es un TODO de
  la Tarea 2 pendiente de una llamada real.
- El cliente del spike usa `ScriptProcessorNode` (obsoleto) para capturar el
  micrófono: funciona, pero para producción hay que pasar a `AudioWorklet`.
