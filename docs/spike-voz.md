# Spike de Voz — Informe de Viabilidad

> **Fecha**: 2026-10-21
> **Estado**: Experimento aislado — **no** es Sprint 6
> **Caducidad**: Decisión go/no-go antes de 2026-11-21
> **Objetivo**: Medir viabilidad de voz sin tocar el dominio de cobranza

---

## Alcance del Spike

| Incluido | Excluido |
|----------|----------|
| DO por llamada (`src/durable/call-session.ts`) | Tablas `calls`/`transcripts`/`recordings` en producción |
| WebRTC end-to-end (local/staging) | Integración con `agent.ts` / ledger legal / contabilidad |
| STT → LLM → TTS pipeline | Cambios al motor legal de mensajería |
| Métricas de latencia/costo/barge-in | Credenciales de voz en `tenant_channels` (evalúa si cabe) |
| Documentación de riesgos legales | Despliegue a producción |

---

## Decisiones Técnicas

### 1. WebRTC: Cloudflare Calls

**Elección**: Cloudflare Calls (quedarse en el stack)

**Justificación**:
- Ya usamos Cloudflare Workers/D1/KV/Queues/DO/R2/AI
- Cloudflare Calls usa la misma red, menor latencia, sin proveedor extra
- Telnyx Voice añadiría un proveedor más; Twilio Voice es costoso
- Calls está en beta pero encaja en la arquitectura "todo en Cloudflare"

**Riesgo**: Calls está en beta; API puede cambiar. Mitigación: aislar detrás de interfaz `VoiceAdapter`.

### 2. STT: Deepgram (Nova-2)

**Elección**: Deepgram Nova-2 (streaming)

**Justificación**:
- Latencia ~300ms p50 streaming
- Soporte español nativo
- Precio: $0.0043/min (streaming)
- WebSocket API nativa para streaming parcial

**Alternativas evaluadas**:
- AssemblyAI: ~$0.006/min, mayor latencia
- Whisper (self-hosted): requiere GPU, no encaja en Workers
- Workers AI: no tiene STT en la bitácora

### 3. TTS: Deepgram Aura (streaming)

**Elección**: Deepgram Aura (streaming)

**Justificación**:
- Mismo proveedor que STT (simplifica credenciales)
- Latencia primer chunk ~150ms
- Voces en español natural
- Precio: $0.015/min

---

## Arquitectura del Spike

```
┌─────────────┐     WebRTC      ┌──────────────────┐
│  Navegador  │◄───────────────►│ Cloudflare Calls │
│  (WebRTC)   │  (media + data) │     (SFU)        │
└─────────────┘                 └────────┬─────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
            │  STT (DG)     │     │   LLM (AI)    │     │  TTS (DG)     │
            │  streaming    │     │  Workers AI   │     │  streaming    │
            └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
                    │                     │                     │
                    └─────────────────────┼─────────────────────┘
                                          ▼
                              ┌─────────────────────┐
                              │ CallSession DO      │
                              │ (state, metrics)    │
                              └─────────────────────┘
```

### Componentes

| Componente | Ubicación | Responsabilidad |
|------------|-----------|-----------------|
| `VoiceAdapter` | `src/channels/voice.ts` | Interfaz común (igual que WhatsApp/SMS/Email) |
| `CallSessionDO` | `src/durable/call-session.ts` | Estado por llamada, métricas, barge-in |
| `STTClient` | `src/voice/stt.ts` | Deepgram WebSocket streaming |
| `TTSClient` | `src/voice/tts.ts` | Deepgram HTTP streaming |
| `VoiceOrchestrator` | `src/orquestacion/voice.ts` | Pipeline STT→LLM→TTS, barge-in |

---

## Métricas de Salida (Obligatorias)

| Métrica | Target | Resultado del Spike |
|---------|--------|---------------------|
| **STT parcial p50** | < 500ms | _pendiente_ |
| **STT parcial p95** | < 1000ms | _pendiente_ |
| **LLM respuesta p50** | < 1000ms | _pendiente_ |
| **LLM respuesta p95** | < 2000ms | _pendiente_ |
| **TTS primer chunk p50** | < 300ms | _pendiente_ |
| **TTS primer chunk p95** | < 600ms | _pendiente_ |
| **Round-trip total p50** | < 2000ms | _pendiente_ |
| **Round-trip total p95** | < 3500ms | _pendiente_ |
| **Barge-in viable** | Sí/No | _pendiente_ |
| **Costo/minuto** | < $0.05 | _pendiente_ |
| **Credenciales por tenant** | Cabe en `tenant_channels` | _pendiente_ |

---

## Resultados del Spike (a rellenar tras experimento)

### Latencia

| Fase | p50 | p95 | Muestras |
|------|-----|-----|----------|
| STT parcial | _ms | _ms | _n |
| LLM | _ms | _ms | _n |
| TTS primer chunk | _ms | _ms | _n |
| **Round-trip total** | _ms | _ms | _n |

### Barge-in

| Escenario | Funciona | Latencia interrupción | Notas |
|-----------|----------|----------------------|-------|
| Usuario habla mientras AI responde | Sí/No | _ms | |
| AI detecta y para TTS | Sí/No | _ms | |

### Costo por minuto

| Componente | Costo/min | Total/min |
|------------|-----------|-----------|
| Cloudflare Calls | $0.008 | |
| Deepgram STT (Nova-2 streaming) | $0.0043 | |
| Deepgram TTS (Aura streaming) | $0.015 | |
| Workers AI (LLM) | ~$0.001 | |
| **Total** | | **$0.0283** |

### Credenciales por tenant

- ¿Cabe en `tenant_channels.credentials`?
  - STT: `api_key` + `model` → Sí (JSON pequeño)
  - TTS: `api_key` + `voice_id` → Sí
  - Cloudflare Calls: `app_id` + `app_secret` → Sí
- **Conclusión**: Sí, cabe sin cambios de esquema.

---

## Riesgos Legales Detectados

| Riesgo | Vinculación a Bloque A | Mitigación |
|--------|------------------------|------------|
| **Aviso de grabación** | Ventana horaria + identidad legal | Reproducir aviso al inicio de la llamada (TTS) antes de cualquier interacción |
| **Retención de audio** | `legal_monto_tolerancia_cents` no aplica | Definir política: audio 30 días, transcripciones 1 año, luego borrado |
| **Ventana horaria** | `send_window_start`/`send_window_end` por tenant | `CallSessionDO` valida ventana antes de aceptar/saliente |
| **Identidad legal en voz** | `razon_social` + `condusef` por tenant | TTS reproduce identidad al inicio: "Habla [razón social], Reg. CONDUSEF [N]" |

**Conclusión**: Los riesgos legales son **manejables** con los controles del Bloque A (config por tenant, fail-closed, ventana horaria). El spike debe validar que el aviso de grabación y la identidad se reproducen correctamente.

---

## Veredicto

> **Veredicto**: _GO / NO-GO / GO CONDICIONADO_

### Justificación

_[Rellenar tras experimento]_

### Próximos pasos si GO

1. Sprint 6: Tablas `calls`/`transcripts`/`recordings` con `tenant_id`
2. Integración con `agent.ts` (prompts de voz distintos a chat)
3. Motor legal de voz (reglas de barge-in, aviso grabación)
4. Credenciales de voz en `tenant_channels` + UI en panel
5. Métricas de producción (latencia, costo, barge-in rate)

### Próximos pasos si NO-GO

1. Documentar limitaciones técnicas/económicas
2. Re-evaluar en 6 meses (modelos STT/TTS mejoran rápido)
3. Considerar híbrido: voz solo para confirmaciones simples (sí/no)

---

## Referencias

- Bloque A: `docs/map.md` (Fase 6 config por tenant)
- `src/durable/call-lock.ts` (patrón DO existente)
- `src/channels/types.ts` (interfaz `ChannelAdapter`)
- Deepgram docs: https://developers.deepgram.com/
- Cloudflare Calls docs: https://developers.cloudflare.com/calls/