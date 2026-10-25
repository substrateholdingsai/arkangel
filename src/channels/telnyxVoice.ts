// Telnyx Voice API (Call Control v2) & WebRTC
// Documentación: https://developers.telnyx.com/docs/voice/call-control
import { fetchJson } from '../lib/http';
import { logger } from '../lib/logger';
import { normalizePhone } from '../lib/phone';
import { findClientByContact, findOpenCase } from '../services/clientes';
import { logEvent } from '../services/eventos';
import { recordMessage } from '../services/mensajes';
import { recordPromise } from '../services/promesas';
import { updateCase } from '../services/casos';
import { resolveTenantContext } from '../tenancy/context';
import type { Env } from '../types/env';

export interface TelnyxCallConfig {
  apiKey?: string;
  fromNumber?: string;
  connectionId?: string;
}

export interface DialCallParams {
  to: string;
  from?: string;
  connectionId?: string;
  webhookUrl?: string;
  clientState?: string;
  amd?: boolean; // Answering Machine Detection
  streamUrl?: string; // WebSocket para streaming de audio bidireccional
  customHeaders?: Record<string, string>;
  assistantId?: string; // Telnyx Voice AI Assistant
  greeting?: string; // Locución inicial del AI Assistant
}

export interface DialCallResult {
  ok: boolean;
  callControlId?: string;
  callLegId?: string;
  callSessionId?: string;
  error?: string;
}

export interface CallActionResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface WebRTCCredentialsResult {
  ok: boolean;
  sipUsername?: string;
  sipPassword?: string;
  jwt?: string;
  error?: string;
}

/**
 * Resuelve las credenciales de Telnyx para voz desde el entorno o configuración.
 */
function resolveVoiceConfig(
  env: Env,
  override?: TelnyxCallConfig
): {
  apiKey: string;
  fromNumber: string;
  connectionId?: string;
} | null {
  const apiKey = override?.apiKey ?? env.TELNYX_API_KEY;
  const fromNumber = override?.fromNumber ?? env.TELNYX_FROM_NUMBER;
  const connectionId =
    override?.connectionId ??
    (env as unknown as { TELNYX_CONNECTION_ID?: string }).TELNYX_CONNECTION_ID;

  if (!apiKey || !fromNumber) {
    return null;
  }
  return { apiKey, fromNumber, connectionId };
}

/**
 * Inicia una llamada saliente (Outbound Call) usando Telnyx Call Control v2.
 * Puede ser utilizada tanto por un Agente de IA como para enrutar a un Operador Humano.
 */
export async function dialCall(
  env: Env,
  params: DialCallParams,
  override?: TelnyxCallConfig
): Promise<DialCallResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) {
    logger.error(
      'Telnyx Voice: Faltan credenciales requeridas (TELNYX_API_KEY o TELNYX_FROM_NUMBER)'
    );
    return { ok: false, error: 'Credenciales de Telnyx Voice no configuradas' };
  }

  const connectionId = params.connectionId ?? config.connectionId;
  const from = params.from ?? config.fromNumber;

  const bodyPayload: Record<string, unknown> = {
    to: params.to,
    from,
    connection_id: connectionId,
    answering_machine_detection: params.amd !== false ? 'premium' : 'disabled',
    answering_machine_detection_config: {
      total_analysis_time_millis: 3500,
      after_greeting_silence_millis: 800,
      between_words_silence_millis: 500,
      greeting_duration_millis: 3500,
      initial_silence_millis: 3500,
      maximum_number_of_words: 5,
      greeting_total_analysis_time_millis: 5000,
      greeting_silence_duration_millis: 1500,
    },
  };

  if (params.webhookUrl) {
    bodyPayload.webhook_url = params.webhookUrl;
  }
  if (params.clientState) {
    bodyPayload.client_state = params.clientState;
  }
  if (params.customHeaders) {
    bodyPayload.custom_headers = Object.entries(params.customHeaders).map(([name, value]) => ({
      name,
      value,
    }));
  }
  if (params.streamUrl) {
    bodyPayload.stream_url = params.streamUrl;
    bodyPayload.stream_track = 'both_tracks';
  }
  const assistantId = params.assistantId ?? env.TELNYX_ASSISTANT_ID;
  if (assistantId) {
    bodyPayload.assistant = {
      id: assistantId,
      ...(params.greeting ? { greeting: params.greeting } : {}),
    };
  }

  const url = 'https://api.telnyx.com/v2/calls';
  const response = await fetchJson<{
    data?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      is_alive?: boolean;
    };
    errors?: Array<{ detail?: string; title?: string }>;
  }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    const errorMsg =
      response.data?.errors?.[0]?.detail ??
      response.data?.errors?.[0]?.title ??
      response.error ??
      'Error desconocido al llamar';
    logger.error('Telnyx dialCall falló', { error: errorMsg, to: params.to });
    return { ok: false, error: errorMsg };
  }

  const callData = response.data?.data;
  return {
    ok: true,
    callControlId: callData?.call_control_id,
    callLegId: callData?.call_leg_id,
    callSessionId: callData?.call_session_id,
  };
}

/**
 * Contesta una llamada entrante en curso.
 */
export async function answerCall(
  env: Env,
  callControlId: string,
  clientState?: string,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_state: clientState }),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Cuelga o termina una llamada.
 */
export async function hangupCall(
  env: Env,
  callControlId: string,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Transfiere una llamada activa (Call Transfer / Bridging).
 * Clave para el traspaso: AI -> Operador Humano o Supervisor.
 */
export async function transferCall(
  env: Env,
  callControlId: string,
  to: string,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to,
      from: config.fromNumber,
    }),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Reproduce texto hablado en la llamada mediante TTS de Telnyx (Text-to-Speech).
 * Ideal para avisos legales obligatorios (guion CONDUSEF) o respuestas rápidas de IA.
 */
export async function speakCall(
  env: Env,
  callControlId: string,
  payload: {
    payload: string; // El texto a hablar
    voice?: string; // e.g. 'female' | 'male'
    language?: string; // e.g. 'es-MX' | 'es-ES'
  },
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: payload.payload,
      voice: payload.voice ?? 'female',
      language: payload.language ?? 'es-MX',
    }),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Inicia la grabación de la llamada para auditoría legal (CONDUSEF / REDECO).
 */
export async function startRecording(
  env: Env,
  callControlId: string,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/record_start`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      format: 'mp3',
      channels: 'dual',
      play_beep: true,
    }),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Inicia el streaming de audio bidireccional vía WebSocket (Media Streaming).
 * Permite conectar la llamada en vivo al STT/TTS de IA o Copiloto.
 */
export async function startStreamingAudio(
  env: Env,
  callControlId: string,
  streamUrl: string,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      stream_url: streamUrl,
      stream_track: 'both_tracks',
      enable_dialogflow: false,
    }),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

/**
 * Genera credenciales o token para Telnyx WebRTC.
 * Permite a los operadores humanos emitir y recibir llamadas desde el navegador en el Softphone.
 */
export async function generateWebRTCCredentials(
  env: Env,
  sipUsername: string,
  override?: TelnyxCallConfig
): Promise<WebRTCCredentialsResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const url = 'https://api.telnyx.com/v2/telephony_credentials';
  const response = await fetchJson<{
    data?: {
      id?: string;
      sip_username?: string;
      token?: string;
    };
    errors?: Array<{ detail?: string }>;
  }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connection_id: config.connectionId,
      sip_username: sipUsername,
      name: `Arkangel Operator ${sipUsername}`,
    }),
  });

  if (!response.ok) {
    const errorMsg =
      response.data?.errors?.[0]?.detail ?? response.error ?? 'Error generando credencial WebRTC';
    return { ok: false, error: errorMsg };
  }

  return {
    ok: true,
    sipUsername: response.data?.data?.sip_username,
    jwt: response.data?.data?.token,
  };
}

export interface StartAIAssistantParams {
  assistantId?: string;
  greeting?: string;
  clientState?: string;
  voice?: string;
}

/**
 * Inicia un Telnyx Voice AI Assistant en una llamada activa de Call Control.
 * Permite que el asistente de IA tome el control de la conversación con ultra-baja latencia.
 */
export async function startAIAssistant(
  env: Env,
  callControlId: string,
  params?: StartAIAssistantParams,
  override?: TelnyxCallConfig
): Promise<CallActionResult> {
  const config = resolveVoiceConfig(env, override);
  if (!config) return { ok: false, error: 'Telnyx no configurado' };

  const assistantId = params?.assistantId ?? env.TELNYX_ASSISTANT_ID;
  const payload: Record<string, unknown> = {};

  if (assistantId) {
    payload.assistant = { id: assistantId };
  }
  if (params?.greeting) {
    payload.greeting = params.greeting;
  }
  if (params?.clientState) {
    payload.client_state = params.clientState;
  }
  if (params?.voice) {
    payload.voice = params.voice;
  }

  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_start`;
  const response = await fetchJson<{ errors?: Array<{ detail?: string }> }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    ok: response.ok,
    error: response.data?.errors?.[0]?.detail ?? response.error,
  };
}

export interface CreateAssistantConfig {
  name?: string;
  model?: string;
  instructions?: string;
  voice?: string;
  razonSocial?: string;
  condusef?: string;
}

/**
 * Crea o aprovisiona el Asistente de Voz Legal de Arkangel en Telnyx.
 * Inyecta las directrices de la CONDUSEF, NOM-184 y política anti-amenazas.
 */
export async function createOrUpdateTelnyxAssistant(
  env: Env,
  config?: CreateAssistantConfig,
  override?: TelnyxCallConfig
): Promise<{ ok: boolean; assistantId?: string; error?: string }> {
  const voiceCfg = resolveVoiceConfig(env, override);
  if (!voiceCfg) return { ok: false, error: 'Telnyx no configurado' };

  const razon = config?.razonSocial ?? 'Despacho Autorizado de Cobranza';
  const condusef = config?.condusef ?? 'REDECO-CONDUSEF';

  const defaultPrompt = `Eres el Agente de Voz de Inteligencia Artificial de ${razon} (Registro CONDUSEF: ${condusef}).
Tu función es negociar el pago de deudas de forma empática, profesional, respetuosa y 100% legal.

REGLAS LEGALES INMUTABLES:
1. IDENTIFICACIÓN INMEDIATA: Debes identificarte al inicio indicando tu nombre, que representas a ${razon} y que llamas en seguimiento a su cuenta pendiente.
2. VERIFICACIÓN DE IDENTIDAD: Antes de dar montos detallados o datos sensibles, confirma que estás hablando con el titular de la cuenta.
3. CERO AMENAZAS: Tienes estrictamente prohibido usar lenguaje intimidatorio, hablar de embargo de bienes en la primera llamada, penas de prisión, o amenazar a familiares/referencias.
4. HORARIOS Y RESPETO: Respetas la NOM-184. Si el deudor te pide no ser contactado ("No molestar" / DND), acepta su decisión pacíficamente y despídete con cortesía.
5. NEGOCIACIÓN DE QUITAS Y PLAZOS: Puedes ofrecer planes de pago de hasta 3 quincenas o descuento de hasta 20% si paga en una sola exhibición.
6. ESCALAMIENTO HUMANO: Si el deudor se molesta, exige hablar con un supervisor o una persona, o la conversación sale de tu alcance, ofrece transferirlo inmediatamente a un ejecutivo humano disponible.`;

  const body = {
    name: config?.name ?? 'Arkangel Legal Collections Agent',
    model: config?.model ?? 'openai/gpt-4o-mini',
    instructions: config?.instructions ?? defaultPrompt,
    voice_settings: {
      voice: config?.voice ?? 'Telnyx.Polly.Mia',
      language: 'es-MX',
    },
  };

  const url = 'https://api.telnyx.com/v2/ai/assistants';
  const response = await fetchJson<{
    data?: { id?: string };
    errors?: Array<{ detail?: string }>;
  }>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${voiceCfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = response.data?.errors?.[0]?.detail ?? response.error ?? 'Error creando asistente';
    return { ok: false, error: err };
  }

  return {
    ok: true,
    assistantId: response.data?.data?.id,
  };
}

export interface TelnyxVoiceEvent {
  eventType: string;
  callControlId?: string;
  callLegId?: string;
  callSessionId?: string;
  clientState?: string;
  from?: string;
  to?: string;
  state?: string;
  hangupSource?: string;
  hangupCause?: string;
  amdResult?: 'human' | 'machine' | 'silence' | 'not_sure';
  recordingUrl?: string;
  durationSeconds?: number;
  customHeaders?: Record<string, string>;
  conversationId?: string;
  transcript?: string;
  summary?: string;
  insights?: Record<string, unknown>;
  raw: unknown;
}

/**
 * Determina si un payload de Telnyx corresponde a un evento de voz (Call Control).
 */
export function isTelnyxVoiceEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const data = (payload as { data?: { event_type?: string } }).data;
  const eventType = data?.event_type;
  return typeof eventType === 'string' && eventType.startsWith('call.');
}

/**
 * Parsea el payload de un webhook de Call Control de Telnyx.
 */
export function parseTelnyxVoiceEvent(payload: unknown): TelnyxVoiceEvent | null {
  if (!isTelnyxVoiceEvent(payload)) return null;

  const data = (
    payload as {
      data?: {
        event_type?: string;
        payload?: {
          call_control_id?: string;
          call_leg_id?: string;
          call_session_id?: string;
          client_state?: string;
          from?: string;
          to?: string;
          state?: string;
          hangup_source?: string;
          hangup_cause?: string;
          result?: string;
          recording_urls?: { mp3?: string; wav?: string };
          duration_millis?: number;
          start_time?: string;
          end_time?: string;
          custom_headers?: Array<{ name: string; value: string }>;
          conversation_id?: string;
          transcript?: string;
          summary?: string;
          insights?: Record<string, unknown>;
        };
      };
    }
  ).data;

  const eventType = data?.event_type ?? '';
  const p = data?.payload ?? {};

  const headersMap: Record<string, string> = {};
  if (Array.isArray(p.custom_headers)) {
    for (const h of p.custom_headers) {
      if (h.name && h.value) headersMap[h.name] = h.value;
    }
  }

  let durationSeconds: number | undefined;
  if (typeof p.duration_millis === 'number') {
    durationSeconds = Math.round(p.duration_millis / 1000);
  } else if (p.start_time && p.end_time) {
    const diff = new Date(p.end_time).getTime() - new Date(p.start_time).getTime();
    if (!isNaN(diff) && diff >= 0) durationSeconds = Math.round(diff / 1000);
  }

  const amdResult =
    p.result === 'human' ||
    p.result === 'machine' ||
    p.result === 'silence' ||
    p.result === 'not_sure'
      ? p.result
      : undefined;

  return {
    eventType,
    callControlId: p.call_control_id,
    callLegId: p.call_leg_id,
    callSessionId: p.call_session_id,
    clientState: p.client_state,
    from: p.from,
    to: p.to,
    state: p.state,
    hangupSource: p.hangup_source,
    hangupCause: p.hangup_cause,
    amdResult,
    recordingUrl: p.recording_urls?.mp3 ?? p.recording_urls?.wav,
    durationSeconds,
    customHeaders: headersMap,
    conversationId: p.conversation_id,
    transcript: p.transcript,
    summary: p.summary,
    insights: p.insights,
    raw: payload,
  };
}

/**
 * Procesa un evento de webhook de Telnyx Voice (Call Control v2)
 * Manejando inicio, contestación, AMD (buzón vs humano), grabaciones legales y cuelgue.
 */
export async function processTelnyxVoiceEvent(
  env: Env,
  event: TelnyxVoiceEvent
): Promise<{ ok: boolean; actionTaken?: string }> {
  let caseId = event.customHeaders?.['X-Case-ID'] || event.customHeaders?.['x-case-id'];
  let tenantId = event.customHeaders?.['X-Tenant-ID'] || event.customHeaders?.['x-tenant-id'];

  if (!caseId && event.clientState) {
    try {
      const parsedState = JSON.parse(event.clientState) as { caseId?: string; tenantId?: string };
      if (parsedState.caseId) caseId = parsedState.caseId;
      if (parsedState.tenantId) tenantId = parsedState.tenantId;
    } catch {
      if (event.clientState.startsWith('cas_')) {
        caseId = event.clientState;
      }
    }
  }

  let ctx: import('../tenancy/types').TenantContext;
  try {
    ctx = await resolveTenantContext(env, tenantId ? { tenantId } : {});
  } catch {
    ctx = await resolveTenantContext(env, {});
  }

  let clientId: string | undefined;
  if (!caseId && (event.to || event.from)) {
    const rawPhone = event.to ?? event.from ?? '';
    const phone = normalizePhone(rawPhone);
    const client = await findClientByContact(ctx, { phone, email: null });
    if (client) {
      clientId = client.id;
      const openCase = await findOpenCase(ctx, client.id);
      if (openCase) caseId = openCase.id;
    }
  }

  logger.info('Telnyx Voice Webhook recibido', {
    eventType: event.eventType,
    callControlId: event.callControlId,
    caseId,
    tenantId: ctx.tenantId,
  });

  switch (event.eventType) {
    case 'call.answered': {
      await logEvent(ctx, 'telnyx.call_answered', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          from: event.from,
          to: event.to,
        },
      });

      if (
        event.callControlId &&
        (event.customHeaders?.['X-Mode'] === 'ai_assistant' ||
          event.clientState?.includes('ai_assistant'))
      ) {
        await startAIAssistant(env, event.callControlId, {
          assistantId: env.TELNYX_ASSISTANT_ID,
          clientState: event.clientState,
        });
      }

      return { ok: true, actionTaken: 'answered_logged' };
    }

    case 'call.conversation.created': {
      await logEvent(ctx, 'telnyx.conversation_created', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          conversationId: event.conversationId,
        },
      });
      return { ok: true, actionTaken: 'conversation_created' };
    }

    case 'call.conversation.ended': {
      const summaryText = event.summary || event.transcript || '';
      if (summaryText && caseId) {
        await recordMessage(ctx, {
          caseId,
          clientId: clientId ?? `cli_${caseId}`,
          channel: 'sms',
          direction: 'outbound',
          providerId: event.callControlId ?? `conv_${Date.now()}`,
          body: `[Conversación Telnyx Voice AI · ${event.durationSeconds ?? 0}s] ${summaryText}`,
          status: 'delivered',
          meta: {
            conversationId: event.conversationId,
            durationSeconds: event.durationSeconds,
            insights: event.insights,
            voice_ai: true,
          },
        });

        const lowerSummary = summaryText.toLowerCase();
        if (
          lowerSummary.includes('promete') ||
          lowerSummary.includes('acuerda pagar') ||
          lowerSummary.includes('pagará') ||
          lowerSummary.includes('compromiso')
        ) {
          await recordPromise(ctx, {
            tenantId: ctx.tenantId,
            caseId,
            clientId: clientId ?? `cli_${caseId}`,
            amountCents: 0,
            promisedDate: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
            confidence: 0.9,
            source: 'voice_ai',
          });
          await updateCase(ctx, caseId, { status: 'promised' });
        }
      }

      await logEvent(ctx, 'telnyx.conversation_ended', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          conversationId: event.conversationId,
          durationSeconds: event.durationSeconds,
          hasSummary: Boolean(summaryText),
        },
      });
      return { ok: true, actionTaken: 'conversation_ended' };
    }

    case 'call.conversation_insights': {
      await logEvent(ctx, 'telnyx.conversation_insights', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          conversationId: event.conversationId,
          insights: event.insights,
        },
      });
      return { ok: true, actionTaken: 'insights_logged' };
    }

    case 'call.machine.detection.ended': {
      await logEvent(ctx, 'telnyx.call_amd', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          result: event.amdResult,
        },
      });

      if (event.amdResult === 'machine' && event.callControlId) {
        await hangupCall(env, event.callControlId);
        if (caseId) {
          await recordMessage(ctx, {
            caseId,
            clientId: clientId ?? `cli_${caseId}`,
            channel: 'sms',
            direction: 'outbound',
            providerId: event.callControlId,
            body: '[Llamada Telnyx] Contestador automático detectado (AMD) · Llamada finalizada.',
            status: 'delivered',
            meta: { amdResult: 'machine', callControlId: event.callControlId },
          });
        }
        return { ok: true, actionTaken: 'machine_hangup' };
      }
      return { ok: true, actionTaken: 'amd_logged' };
    }

    case 'call.recording.saved': {
      if (event.recordingUrl && caseId) {
        await recordMessage(ctx, {
          caseId,
          clientId: clientId ?? `cli_${caseId}`,
          channel: 'sms',
          direction: 'outbound',
          providerId: event.callControlId ?? `rec_${Date.now()}`,
          body: `[Grabación Legal CONDUSEF] Audio disponible (${event.durationSeconds ?? 0}s): ${event.recordingUrl}`,
          status: 'delivered',
          meta: {
            recordingUrl: event.recordingUrl,
            durationSeconds: event.durationSeconds,
            callControlId: event.callControlId,
          },
        });
      }
      await logEvent(ctx, 'telnyx.recording_saved', {
        caseId,
        clientId,
        payload: {
          recordingUrl: event.recordingUrl,
          durationSeconds: event.durationSeconds,
        },
      });
      return { ok: true, actionTaken: 'recording_saved' };
    }

    case 'call.hangup': {
      const dur = event.durationSeconds ?? 0;
      await logEvent(ctx, 'telnyx.call_hangup', {
        caseId,
        clientId,
        payload: {
          callControlId: event.callControlId,
          durationSeconds: dur,
          hangupSource: event.hangupSource,
          hangupCause: event.hangupCause,
        },
      });
      return { ok: true, actionTaken: 'hangup_logged' };
    }

    default: {
      return { ok: true, actionTaken: 'unhandled_event' };
    }
  }
}
