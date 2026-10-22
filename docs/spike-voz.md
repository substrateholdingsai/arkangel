# Spike D · Voz end-to-end (experimental)

> **Estado: ✅ EJECUTADO — 20 llamadas reales con p50/p95 medidos.** La cadena
> completa corrió de punta a punta (STT → LLM → TTS, con barge-in) contra
> **Workers AI** (Deepgram Nova-3 y Aura) sobre la cuenta de Cloudflare del
> proyecto, sin cuenta nueva de Deepgram.
>
> Fecha de la última revisión: **2026-10-22**. Tarifas consultadas el
> **2026-10-21** (enlaces al final de cada sección).

---

## 1. Resumen ejecutivo

| | |
| --- | --- |
| ¿Se construyó la cadena completa? | Sí: DO por llamada, signaling, STT, LLM, TTS, barge-in, métricas y cliente de navegador. |
| ¿Se ejecutó una llamada real? | **Sí** — 20 llamadas con el guion hablado de 3 turnos; **16 produjeron turnos medidos** (32 turnos) y 4 chocaron contra el tope diario de neuronas gratuitas de Workers AI. |
| ¿Hay p50/p95 sobre 20 llamadas? | **Sí** — ver la tabla de la §4. |
| ¿Hay tabla de costos con tarifas reales? | **Sí**, con la tarifa vigente de cada proveedor (consultada 2026-10-21). |
| Veredicto | **NO-GO por latencia**: el `round_trip_ms` p95 medido queda **por encima** del criterio de 1500 ms. El detalle y el ajuste propuesto están en la §6. |

---

## 2. Qué cambió respecto al plan original

| Decisión del plan | Estado | Nota |
| --- | --- | --- |
| WebRTC con **Cloudflare Calls** | **Renombrado, mismo proveedor** | "Cloudflare Calls" ya no existe como producto: su documentación redirige a **Cloudflare Realtime** (RealtimeKit / Realtime SFU). Se mantiene la decisión de proveedor — misma cuenta, misma Facturación, sin salir de Cloudflare. La ruta de navegador es el SDK `@cloudflare/realtimekit` (Web Components, sin React). |
| **Deepgram** en español | **Cambio de ruta, mismo proveedor de voz** | Se cambió de la API directa de Deepgram a **Workers AI** (`@cf/deepgram/nova-3` para STT y `@cf/deepgram/aura-2-es` para TTS). Misma casa (Deepgram), **sin cuenta nueva**: el modelo ya está en el catálogo de la cuenta de Cloudflare y habla por WebSocket. Decisión tomada **con el usuario**, no en silencio (antes estaba documentada como alternativa sin aplicar). |
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
   │        Workers AI · STT           Workers AI (Llama 3.3)      Workers AI · TTS
   │        @cf/deepgram/nova-3         redactMessage (sólo lectura) @cf/deepgram/aura-2-es
   │        (es, streaming)                        │                        │
   │                  │                        │                        │
   │                  └── parciales ──────────┴── barge-in: corta TTS ──┘
   │                                                        │
   │  ③ audio PCM 24 kHz ◄─────────────────────────────────┘
```

> El arnés de Node (`scripts/spike-voz.ts`) no usa WebRTC: habla directo por el
> WebSocket de signaling y pide la llamada con `realtime: false`, así que no
> necesita reunión de Realtime. La ruta del navegador sí la usa.

### Archivos

| Archivo | Qué es |
| --- | --- |
| `src/durable/call-session.ts` | `CallSessionDO`: estado de la llamada, `traceId`, muestras de métricas, canal de signaling. |
| `src/orquestacion/voice.ts` | Pipeline STT → LLM → TTS, barge-in y emisión de métricas por turno. |
| `src/voice/stt.ts` | Cliente de transcripción en streaming de Deepgram Nova-3 sobre **Workers AI** (WebSocket). |
| `src/voice/tts.ts` | Cliente de síntesis en streaming de Aura sobre **Workers AI** (WebSocket, voz `estrella` de México). |
| `src/routes/spike.ts` | Rutas del spike, detrás de `SPIKE_VOZ_ENABLED` y de credencial. |
| `src/lib/medidas.ts` | Percentiles (nearest rank) y resumen p50/p95. |
| `spike/index.html` | Cliente mínimo: botón "Llamar", WebRTC nativo, captura de micrófono, reproducción y barge-in. |
| `spike/guion.wav` | Guion hablado de 3 turnos (mono 16 kHz) que usa el arnés. |
| `scripts/spike-voz.ts` | Arnés de las 20 llamadas; calcula p50/p95. |
| `migrations/0010_spike_calls.sql` | Tabla experimental `spike_calls` (con `tenant_id`, sin audio ni transcripciones). |
| `tests/spikeVoz.test.ts` | 24 tests: percentiles, DO (estado, métricas, barge-in, cierre), credenciales de voz y pipeline con dobles. |

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

Corrida del **2026-10-22** con el arnés (`npm run spike:voz`), 20 llamadas y
el guion hablado de 3 turnos. **16 llamadas produjeron turnos completos (32
turnos medidos)**; las 4 últimas chocaron contra el **límite diario gratuito de
Workers AI (10 000 neuronas/día)** — es un tope de la cuenta, no un defecto del
spike (ver "Lo que falta para poder emitir el veredicto").

| métrica | n | p50 (ms) | p95 (ms) | max (ms) |
| --- | ---: | ---: | ---: | ---: |
| `stt_partial_ms` | 32 | 1626 | 2158 | 2328 |
| `stt_final_ms` | 32 | 1680 | 2192 | 2335 |
| `llm_first_token_ms` | 32 | 1702 | 3733 | 6776 |
| `llm_total_ms` | 32 | 1702 | 3733 | 6776 |
| `tts_first_chunk_ms` | 32 | 799 | 1445 | 1593 |
| `round_trip_ms` | 32 | 2525 | **3914** | 6776 |
| `barge_in_latency_ms` | 32 | 0 | 0 | 1 |

> **`tts_first_chunk_ms` y la corrupción de la corrida**: la corrida original
> tenía 3 muestras corruptas en esa métrica (el `Date.now()` entero, ≈1,8
> billones) por un defecto de atribución del primer fragmento de audio; la tabla
> de arriba deja fuera esas 3. El defecto está corregido y hay un test de
> regresión que lo cubre (`tests/spikeVoz.test.ts`, "un fragmento de audio
> tardío no inventa la latencia de un turno").

**Cómo se lee:**

- El **round-trip p95 (3914 ms) duplica** el criterio de 1500 ms → **NO-GO**.
- El culpable **no es la voz**: el TTS abre en 799 ms (p50) y el STT cierra la
  frase en 1680 ms. El **LLM se lleva 1702 ms de mediana y 3733 ms de p95**,
  porque `redactMessage` llama a Workers AI **sin streaming**: el primer token
  observable llega junto con la respuesta completa. El round-trip es, casi
  entera, la espera del LLM (1702 + 799 ≈ 2525 = p50 medido).
- `barge_in_latency_ms` = 0 por construcción: el corte lo dispara el parcial del
  STT en el mismo tick. Lo que el usuario percibe es el `stt_partial_ms`
  (~1.6 s desde que empieza a hablar hasta que el bot se calla).

### Cómo correr las 20 llamadas

```bash
# 1) El Worker con el flag y las credenciales (local o staging).
#    Las credenciales van en .dev.vars (local) o como secretos (staging).
npx wrangler dev --port 8787

# 2) El arnés. Lee .dev.vars como respaldo, así que normalmente basta con:
npm run spike:voz

#    Se puede forzar todo por entorno:
SPIKE_BASE_URL=http://localhost:8787 \
SPIKE_ADMIN_TOKEN=… \
SPIKE_AUDIO_PATH=./spike/guion.wav \
SPIKE_LLAMADAS=20 \
npm run spike:voz
```

Imprime la tabla de p50/p95 y deja un renglón por llamada con su `traceId`.

> **El guion hablado** (`spike/guion.wav`) es un WAV mono 16 kHz con 3 turnos y
> pausas entre ellos. Se generó con la voz `Microsoft Sabina Desktop` (es-MX)
> de Windows. Que sea voz real, no un tono: un tono no lo transcribe nadie.
>
> **Al cambiar `.dev.vars` hay que reiniciar `wrangler dev`**: no recarga los
> secretos de forma fiable y los fallos se ven como `401` del proveedor, muy
> lejos de la causa.
>
> **El token de `CF_AI_API_TOKEN` caduca.** Con un token de OAuth de
> `wrangler` (`wrangler auth token`) el valor rota solo y el que está en
> `.dev.vars` se queda viejo: el síntoma es otro `401` del proveedor. Para
> producción, usar un **API Token con permiso `Workers AI: Read/Edit`**, que no
> caduca; para una corrida local, refrescar con `wrangler auth token`.

## 4.1 Secrets necesarios (local vs staging)

**Nunca valores, solo nombres.**

| Secreto / variable | Uso | Dónde | Notas |
| --- | --- | --- | --- |
| `SPIKE_VOZ_ENABLED` | Flag para habilitar rutas `/spike/*` (404 si no está en `true`) | `wrangler.jsonc`/vars, `.dev.vars` local | Requiere credencial obligatoria (token de admin/sesión). Apagado por defecto. |
| `CF_AI_API_TOKEN` | Token de API de Cloudflare con permiso **Workers AI: Read/Edit** (STT y TTS por WebSocket) | Secret (Worker) / `.dev.vars` local | Es lo que habilita `@cf/deepgram/nova-3` y `@cf/deepgram/aura-2-es`. Sustituye a `DEEPGRAM_API_KEY`, que ya no se usa. |
| `CF_AI_ACCOUNT_ID` | Cuenta de Cloudflare donde viven los modelos de Workers AI | Secret/var | |
| `SPIKE_STT_MODEL` | Modelo de transcripción | var | Por defecto `@cf/deepgram/nova-3`. |
| `SPIKE_TTS_MODEL` | Modelo de síntesis | var | Por defecto `@cf/deepgram/aura-2-es`. |
| `SPIKE_TTS_VOICE` | Hablante de Aura | var | Por defecto `estrella` (español de México). **Ojo:** `aura-1` + `asteria` da una voz **en inglés**. |
| `CF_REALTIME_API_TOKEN` | API de Cloudflare Realtime/RealtimeKit | Secret | Requiere permiso **Realtime / Realtime Admin**. Sólo lo usa la ruta del navegador (WebRTC). |
| `CF_REALTIME_APP_ID` | App ID de RealtimeKit | Secret/var | Por cuenta/app. |
| `CF_REALTIME_ACCOUNT_ID` | Account ID | Secret/var | |
| `CF_REALTIME_PRESET_NAME` | Preset (p.ej. "audio only") | Secret/var | El spike usa preset audio-only. |
| `SPIKE_ADMIN_TOKEN` | Auth para arnés/script | Secret/var (solo para spike) | Si no está, el arnés usa `ADMIN_TOKEN` de `.dev.vars`. Va en la cabecera `x-admin-token`. |

**Carga:**
- **Local**: `.dev.vars` (no commiteado). El arnés también lee `.dev.vars` como
  respaldo, así que `npm run spike:voz` funciona sin exportar nada.
- **Staging/producción**: `wrangler secret put <NOMBRE>` para secretos; vars en `wrangler.jsonc`/entorno. Nunca commitear valores.

**Decisión tomada (con el usuario):** la ruta de voz es **Workers AI** con los
modelos de Deepgram (`@cf/deepgram/nova-3` para STT y `@cf/deepgram/aura-2-es`
para TTS) sobre el WebSocket de `api.cloudflare.com/client/v4/accounts/{id}/ai/run/{modelo}`.
Es la **misma casa (Deepgram)** y no exige cuenta ni clave nueva: el modelo ya
estaba en el catálogo de la cuenta de Cloudflare del proyecto. **Costo:** STT por
WebSocket ~$0.0092/min-audio (frente a $0.00583/min de la API directa) y TTS
Aura-2 $0.030/1k caracteres (igual). El cambio se hizo **con confirmación
explícita**, no en silencio.

---

## 5. Costo por minuto

### Tarifas (consultadas el 2026-10-21)

| Concepto | Tarifa | Fuente |
| --- | --- | --- |
| **Cloudflare Realtime / RealtimeKit** · participante **sólo audio** | **$0.0005 / min** | [RealtimeKit pricing](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/) |
| Cloudflare Realtime / RealtimeKit · participante audio + video | $0.002 / min | idem |
| Cloudflare Realtime / RealtimeKit · **export/grabación** (RTMP/HLS) | $0.010 / min (audio solo $0.003) | idem |
| Cloudflare Realtime / RealtimeKit · export de RTP crudo a R2 | $0.0005 / min | idem |
| Workers AI · **`@cf/deepgram/nova-3` por WebSocket** (el del spike) | **$0.0092 / min de audio** | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Deepgram STT **streaming** · Nova-2 (ruta directa, ya no usada) | $0.35 / hora = $0.00583 / min | [Deepgram pricing](https://deepgram.com/pricing) |
| Deepgram TTS · **Aura-2** (el del spike, vía Workers AI) | **$0.030 / 1,000 caracteres** | idem |
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
| Workers AI STT Nova-3 (WebSocket) | 0.5 min de audio | $0.00460 |
| Workers AI TTS Aura-2 | ~450 caracteres | $0.01350 |
| Workers AI Llama 3.3 | ~400 in + ~120 out tokens | $0.00039 |
| **Total del spike tal como está** | | **$0.0190 / min** |
| Total con STT por API directa de Deepgram | 0.5 min de audio | $0.0133 / min |
| Total con participante de audio + video | | $0.0205 / min |
| Total **con grabación** (export $0.010/min) | | $0.0290 / min |

### Umbral propuesto

**$0.03 / minuto de conversación** (~$0.57 MXN/min a ~19 MXN/USD, tipo de
cambio a verificar antes de decidir).

Justificación: una llamada de cobranza de 5 minutos costaría **$0.095 USD
(~1.8 MXN)**, muy por debajo de una llamada humana (~10 MXN/min) y por debajo
del valor de recuperar un solo pago mínimo. Con margen: el total medido
($0.0190/min) queda **37 % por debajo** del umbral. El costo **no** es el
riesgo de esta técnica; la latencia sí.

---

## 6. Veredicto

**NO-GO por latencia (aún no por costo).** La cadena funciona de punta a
punta, pero el criterio de `round_trip_ms` p95 < 1500 ms **no se cumple**: se
midió **3914 ms**.

Los tres criterios del veredicto:

| Criterio | Medido | Veredicto |
| --- | --- | --- |
| `round_trip_ms` p95 < 1500 ms | **3914 ms** | ❌ **NO-GO** |
| Barge-in funcionando (corte < 500 ms tras la interrupción) | ✅ corto de inmediato al llegar el parcial; pero el STT tarda **~1.6 s** en devolver el primer parcial | ⚠️ El corte es instantáneo, pero la detección del STT es lenta |
| Costo < $0.03 / min | **$0.0190 / min** estimado | ✅ **GO** |

### Por qué falla la latencia (y por qué es un problema de una pieza, no de tres)

El desglose del round-trip es casi entero el LLM:

```
round_trip (p50 2525)  ≈  llm_total (p50 1702)  +  tts_first_chunk (p50 799)
```

`llm_first_token_ms` **es igual** a `llm_total_ms` en las 32 muestras: eso
confirma que la llamada a Workers AI **no es streaming** y que el primer token
observable llega con la respuesta completa. Con streaming, el round-trip
bajaría del orden del `tts_first_chunk` (~800 ms) más el tiempo al primer token
del LLM (cientos de milisegundos), es decir, del orden de 1–1.5 s: dentro del
criterio.

**El ajuste propuesto, en orden de impacto:**

1. **Streaming en el LLM** (`agent.ts` con la variante streaming de Workers AI):
   es lo que mueve la aguja. Es la deuda que ya estaba anotada en el spike.
2. **Modelo de LLM más chico** (`@cf/meta/llama-3.2-3b-instruct`, $0.051/M in,
   $0.335/M out) si el streaming no alcanza. Exige revisar los prompts de
   cobranza de `agent.ts`, que hoy están calibrados para el modelo grande.
3. **STT más rápido**: 1.6 s hasta el primer parcial es alto. Parte es la voz
   sintética del guion (Microsoft Sabina Desktop), que es lenta y Robótica; con
   voz real el número baja. El STT devuelve el primer parcial en cuanto tiene
   suficiente audio.

### Lo que sí se puede afirmar con los números de arriba

1. **Costo: GO.** $0.0190/min estimado contra un umbral de $0.03/min (37 %
   debajo). Con grabación (que no vamos a usar) sigue debajo.
2. **Cadena: GO.** La llamada real corre de punta a punta: STT en streaming con
   parciales, LLM, TTS en streaming y barge-in. El problema no es que no
   funcione.
3. **Latencia: NO-GO.** 3914 ms de p95 contra 1500 ms. Con el ajuste (1) el
   orden de magnitud es el correcto, así que **la recomendación es re-medir con
   streaming en el LLM antes de decidir el descarte**.

### Lo que falta para poder emitir el veredicto final (bloqueo exacto)

| # | Falta | Dónde | Nota |
| --- | --- | --- | --- |
| 1 | **Streaming en el LLM** (`agent.ts`) | `src/ai/agent.ts` | Es lo que decide el veredicto de latencia. Sin esto, el p95 se queda en ~3.9 s. |
| 2 | Cuota de Workers AI (o plan de pago) | cuenta de Cloudflare | La corrida se paró en 16/20 llamadas: **10 000 neuronas/día** reached. Con plan de pago no hay tope. |
| 3 | Repetir la corrida con el guion hablado | `npm run spike:voz` | 20 llamadas limpias, sin el truncamiento por cuota. |
| 4 | Un navegador con micrófono para el WebRTC | equipo de quien corre el spike | El arnés de Node no media; la ruta del navegador (la que usaría un deudor) sigue sin probarse en voz alta. |

**Lo que ya no bloquea:** credenciales de voz (`CF_AI_API_TOKEN` +
`CF_AI_ACCOUNT_ID`, sin cuenta nueva de Deepgram), el guion hablado
(`spike/guion.wav`), el comando (`npm run spike:voz`) y las credenciales de
Realtime para la ruta del navegador.

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

## 8.1 Bloqueantes legales de voz

El riesgo más delicado del spike no está en el repo: el prompt de `agent.ts` dice _"No menciones que eres una IA"_. En mensajería asíncrona es discutible; en voz alta, con una llamada automatizada, choca con **transparencia** y con la **regulación de cobranza**.

| Bloqueante | Estado en el spike | Enlace a Bloque A (fail-closed) | Acción requerida en Sprint 6 |
| --- | --- | --- | --- |
| **Identificación de bot en el prompt de voz** | Pendiente. Hoy se usa el texto de `redactMessage` tal cual (incluye la instrucción de no identificar como IA). No se modificó `agent.ts`. | `src/legal/config.ts` (`assertTenantListoParaOperar()`), `src/legal/reglas.ts` (regla 1.1 / identidad). El motor legal exige razón social + CONDUSEF antes de operar; la identidad también aplica a voz. | Crear un **prompt de voz propio** (separado de `agent.ts`) que **sí identifique explícitamente** que es una llamada automatizada, con frase de apertura obligatoria. **No** reusar la instrucción "No menciones que eres una IA". |
| **Aviso de grabación** | No activado. `RealtimeKit` tiene export/RTMP a $0.010/min; el spike no lo configura. | Bloque A (aviso de grabación) — debe ser condición para activar grabación. `assertTenantListoParaOperar()` es el guard fail-closed general; el aviso de grabación debe validarse antes de habilitar `export`. | Si se habilita grabación/QA, mostrar/leer aviso de grabación **antes** de iniciar la grabación. Export **apagado por defecto**, costo incluido en modelo. |
| **Ventana horaria aplicada a voz** | Pendiente de canal. El motor legal hoy valida `'whatsapp' \| 'sms' \| 'email'`. | `src/legal/config.ts` (`configLegal()` → `horaInicio`/`horaFin`, `horarioEnRespuestas`) y `src/legal/reglas.ts` regla **2.4** (horario prohibido, BLOCK). | Extender regla 2.4 / validación de ventana horaria al **canal voz**. Reusar `configLegal(ctx)` por tenant (config por tenant, Fase 6 / Bloque A). Fallar en **BLOCK** fuera de ventana, igual que otros canales. |
| **Retención de audio** | Sin retención en el spike. No se guarda audio ni transcripción; solo latencias en `spike_calls`. | Bloque A (retención). El diseño "sin audio" es deliberado para reducir exposición. | Política escrita de retención. Si no hay grabación: documentar "sin audio almacenado". Si hay grabación: retención corta, propósito limitado, borrado verificable. Responsabilidad con proveedores (Deepgram streaming no guarda audio; RealtimeKit solo guarda lo exportado). |
| **Transferencia de voz a EE. UU.** | Ocurre con datos de prueba. Voz viaja a **Deepgram (EE. UU.)** y **Cloudflare**. | Bloque A (transferencia). Requiere base legal y aviso de privacidad. | En aviso de privacidad nombrar proveedores, base de transferencia, minimización. Evaluar con asesoría; considerar alternativas si hay restricciones. |
| **Voz como dato biométrico si se guarda** | No se guarda. Si se almacena audio/huella vocal → categoría biométrica bajo **LFPDPPP**. | Bloque A (tratamiento de datos sensibles). | Si Sprint 6 guarda audio de QA: **consentimiento expreso**, retención corta, justificación, registro de tratamiento. Preferir **no guardar audio** mientras no sea estrictamente necesario. |

---

## 9. Qué falta para Sprint 6 (si el veredicto fuera go / go condicionado)

0. **Streaming en el LLM** (`agent.ts`): es lo que decide el veredicto de
   latencia que ya medimos (p95 3914 ms). Sin streaming, el round-trip no baja
   del orden del tiempo completo del LLM.
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
8. **Cuota de Workers AI**: la corrida se truncó en 16/20 llamadas por el tope
   gratuito (10 000 neuronas/día). Con plan de pago, la corrida completa y la
   de producción no chocan con ese techo.

---

## 10. Deuda residual

- `llm_first_token_ms` no es independiente de `llm_total_ms` mientras el
  agente no tenga modo streaming.
- El `traceId` viaja del HTTP al DO y a los logs, pero **no** a Workers AI ni a
  Realtime (no admiten cabeceras de traza en la WSS de audio): la correlación
  con el proveedor se hace por `callId` + marca de tiempo.
- El `CallSessionDO` guarda su estado en `ctx.storage`, pero la ruta `/spike`
  **no escribe** en `spike_calls`: la tabla está creada (migración 0010) y el
  arnés lee las métricas del DO. Escribir la fila por llamada es un TODO de la
  Tarea 2 pendiente de una llamada real.
- El cliente del spike usa `ScriptProcessorNode` (obsoleto) para capturar el
  micrófono: funciona, pero para producción hay que pasar a `AudioWorklet`.

### Notas de implementación (lo que costó la primera llamada real)

Cinco cosas que **no** se ven en el código y que hicieron que la primera
llamada real fallara. Se dejan escritas porque las dos últimas son cambios de
plataforma que van a volver a morder:

1. **`fetch` no acepta `wss:`.** El handshake de Workers AI se hace con
   `fetch(url, { headers: { Upgrade: 'websocket' } })` sobre una URL **`https:`**
   (la ruta es la misma). Con `wss://` el `fetch` falla y el error se ve como
   "no aceptó el WebSocket".
2. **El socket del STT tiene que abrirse dentro de la petición que lo abre.**
   Si se abre "en volando" (después de que la ruta ya respondió), el runtime
   lo cierra al terminar el contexto: se ve como el socket abre y se cae
   ~100 ms después. Por eso `PipelineVoz.abrir()` es asíncrono y el DO espera
   a que el STT quede establecido antes de devolver el 101.
3. **Las tramas binarias llegan como `Blob`, no como `ArrayBuffer`** (desde la
   fecha de compatibilidad `2026-03-17`; el proyecto usa `2026-10-20`). Con
   un `as ArrayBuffer` a ciegas, **cada trama se pierde en silencio**: el
   audio llegaba vacío y el STT cerraba la conexión. Hay que poner
   `binaryType = 'arraybuffer'` **antes** de `accept()`, en los tres sockets
   (el del navegador, el del STT y el del TTS).
4. **El lado del servidor del `WebSocketPair` necesita `accept()`.** Sin él, el
   DO no recibe tramas ni puede mandar eventos.
5. **`wrangler dev` no recarga `.dev.vars` de forma fiable.** Un token
   caducado se ve como `401` del proveedor, muy lejos de la causa. Reiniciar
   `wrangler dev` al cambiar los secretos.

Además, el pipeline tenía un defecto de concurrencia que **inflaba** las
latencias: las métricas del turno vivían en la instancia, así que si el
usuario hablaba otra vez antes de que el bot terminara, el `fin_turno` del
turno anterior borraba las marcas del nuevo y el round-trip salía con un
valor absurdo (el `Date.now()` entero, en lugar de milisegundos). Ahora cada
turno lleva sus propias métricas y los turnos se procesan de uno en uno.
