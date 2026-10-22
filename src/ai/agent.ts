import type { ChannelName } from '../channels/types';
import { logger } from '../lib/logger';
import { formatDateMX, formatMXN } from '../lib/money';
import type { ScoreBand } from '../lib/score';
import type { Env } from '../types/env';
import { heuristicClassify, sanitizeClassification, type Classification } from './classify';
import {
  buildClassifyPrompt,
  buildRedactPrompt,
  buildReplyPrompt,
  SYSTEM_CLASSIFY,
  SYSTEM_REDACT,
  SYSTEM_REDACT_EMAIL,
  SYSTEM_REDACT_VOZ,
  SYSTEM_REPLY,
} from './prompts';

export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Extrae texto de la respuesta de Workers AI (el shape cambió entre modelos). */
export function extractText(result: unknown): string | null {
  if (typeof result === 'string') return result.trim() || null;
  if (!result || typeof result !== 'object') return null;

  const value = result as Record<string, unknown>;

  if (typeof value.response === 'string') return value.response.trim() || null;
  if (value.result && typeof value.result === 'object') {
    const nested = extractText(value.result);
    if (nested) return nested;
  }
  if (Array.isArray(value.choices)) {
    const first = value.choices[0] as { message?: { content?: string }; text?: string } | undefined;
    if (first?.message?.content) return first.message.content.trim();
    if (first?.text) return first.text.trim();
  }
  return null;
}

/** Saca un objeto JSON del texto del modelo (tolera ```json y texto extra). */
export function extractJson(text: string): unknown | null {
  const withoutFence = text.replace(/```(?:json)?/gi, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function runAI(
  env: Env,
  system: string,
  user: string,
  model?: string
): Promise<string | null> {
  const modelName = model || env.AI_MODEL || DEFAULT_AI_MODEL;
  try {
    const result = await env.AI.run(modelName, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return extractText(result);
  } catch (error) {
    logger.error('Workers AI falló', {
      model: modelName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function* runAIStream(
  env: Env,
  system: string,
  user: string,
  model?: string
): AsyncGenerator<string, void, unknown> {
  const modelName = model || env.AI_MODEL || DEFAULT_AI_MODEL;
  try {
    const stream = (await env.AI.run(modelName, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
    })) as ReadableStream<Uint8Array>;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const text = extractText(parsed);
            if (text) yield text;
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }
    // Handle any remaining buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim();
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          const text = extractText(parsed);
          if (text) yield text;
        } catch {
          // Ignore
        }
      }
    }
  } catch (error) {
    logger.error('Workers AI streaming falló', {
      model: modelName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface RedactParams {
  channel: ChannelName;
  clientName: string;
  amountCents: number;
  dueDate: string;
  diasRetraso: number;
  band: ScoreBand;
  customMessage?: string;
  /**
   * Identidad legal del tenant que emite. La recibe el caller (que sí conoce el
   * contexto) para que este módulo no dependa del tenant: sin razón social, el
   * mensaje sale sin firma y el motor legal lo bloquea después (regla 1.1).
   */
  nombreLegal?: string;
  condusef?: string;
}

export interface RedactResult {
  subject?: string;
  body: string;
  source: 'ai' | 'template';
}

function templateMessage(params: RedactParams): RedactResult {
  const amount = formatMXN(params.amountCents);
  const fecha = formatDateMX(`${params.dueDate}T12:00:00Z`);
  const nombre = params.clientName.split(' ')[0] || params.clientName;

  if (params.customMessage) {
    return { body: params.customMessage, source: 'template' };
  }

  if (params.channel === 'email') {
    return {
      subject: `Recordatorio de pago — ${amount}`,
      body: `Hola ${params.clientName},

Te escribimos para recordarte que tienes un saldo pendiente de ${amount}, con fecha de vencimiento ${fecha}.

Puedes liquidarlo desde tu portal de cliente o responder a este correo si necesitas otro medio de pago o una factura.

Gracias por tu preferencia.
Equipo de cobranza`,
      source: 'template',
    };
  }

  if (params.channel === 'sms') {
    return {
      body: `Hola ${nombre}, tu saldo de ${amount} venció el ${fecha}. Responde para pagar o recibir ayuda.`,
      source: 'template',
    };
  }

  return {
    body: `Hola ${nombre}, te recordamos tu saldo pendiente de ${amount} con vencimiento ${fecha}. ¿Necesitas ayuda para pagar? Responde a este mensaje.`,
    source: 'template',
  };
}

function clampLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

function cleanMessage(text: string): string {
  return text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(mensaje|asunto|subject|body)\s*:\s*/i, '')
    .trim();
}

export async function redactMessage(env: Env, params: RedactParams): Promise<RedactResult> {
  const amountText = formatMXN(params.amountCents);
  const dueDateText = formatDateMX(`${params.dueDate}T12:00:00Z`);
  const fallback = templateMessage(params);

  const text = await runAI(
    env,
    params.channel === 'email' ? SYSTEM_REDACT_EMAIL : SYSTEM_REDACT,
    buildRedactPrompt({
      clientName: params.clientName,
      amountCents: params.amountCents,
      amountText,
      dueDate: params.dueDate,
      dueDateText,
      diasRetraso: params.diasRetraso,
      band: params.band,
      channel: params.channel,
      customMessage: params.customMessage,
      nombreLegal: params.nombreLegal || undefined,
      condusef: params.condusef || undefined,
    })
  );

  if (!text) return fallback;

  const body = cleanMessage(text);
  if (!body) return fallback;

  if (params.channel === 'sms') {
    return { body: clampLength(body, 160), source: 'ai' };
  }
  if (params.channel === 'whatsapp') {
    return { body: clampLength(body, 600), source: 'ai' };
  }
  return { subject: fallback.subject, body, source: 'ai' };
}

export async function* redactMessageStream(
  env: Env,
  params: RedactParams,
  model?: string
): AsyncGenerator<string, void, unknown> {
  const amountText = formatMXN(params.amountCents);
  const dueDateText = formatDateMX(`${params.dueDate}T12:00:00Z`);

  const systemPrompt = params.channel === 'email' ? SYSTEM_REDACT_EMAIL : SYSTEM_REDACT;
  const userPrompt = buildRedactPrompt({
    clientName: params.clientName,
    amountCents: params.amountCents,
    amountText,
    dueDate: params.dueDate,
    dueDateText,
    diasRetraso: params.diasRetraso,
    band: params.band,
    channel: params.channel,
    customMessage: params.customMessage,
    nombreLegal: params.nombreLegal || undefined,
    condusef: params.condusef || undefined,
  });

  let buffer = '';
  for await (const chunk of runAIStream(env, systemPrompt, userPrompt, model)) {
    buffer += chunk;
    const cleaned = cleanMessage(buffer);
    if (cleaned.length > buffer.length - chunk.length) {
      yield cleaned.slice(buffer.length - chunk.length);
    }
  }
}

/** Modelo por defecto para la fase de voz (más rápido que el 70B). */
export const DEFAULT_VOZ_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export type RedactVozParams = Omit<RedactParams, 'channel'>;

export async function* redactMessageVozStream(
  env: Env,
  params: RedactVozParams,
  model?: string
): AsyncGenerator<string, void, unknown> {
  const amountText = formatMXN(params.amountCents);
  const dueDateText = formatDateMX(`${params.dueDate}T12:00:00Z`);

  const userPrompt = buildRedactPrompt({
    clientName: params.clientName,
    amountCents: params.amountCents,
    amountText,
    dueDate: params.dueDate,
    dueDateText,
    diasRetraso: params.diasRetraso,
    band: params.band,
    channel: 'voice',
    customMessage: params.customMessage,
    nombreLegal: params.nombreLegal || undefined,
    condusef: params.condusef || undefined,
  });

  const modelName = model || env.SPIKE_VOZ_MODEL || DEFAULT_VOZ_MODEL;
  let buffer = '';
  for await (const chunk of runAIStream(env, SYSTEM_REDACT_VOZ, userPrompt, modelName)) {
    buffer += chunk;
    const cleaned = cleanMessage(buffer);
    if (cleaned.length > buffer.length - chunk.length) {
      yield cleaned.slice(buffer.length - chunk.length);
    }
  }
}

export interface ClassifyParams {
  clientName: string;
  amountCents: number;
  dueDate: string;
  channel: ChannelName;
  inbound: string;
}

export interface ClassifyResult extends Classification {
  source: 'ai' | 'heuristic';
}

export async function classifyInbound(env: Env, params: ClassifyParams): Promise<ClassifyResult> {
  const fallback = heuristicClassify(params.inbound);

  const text = await runAI(
    env,
    SYSTEM_CLASSIFY,
    buildClassifyPrompt({
      clientName: params.clientName,
      amountText: formatMXN(params.amountCents),
      dueDate: formatDateMX(`${params.dueDate}T12:00:00Z`),
      channel: params.channel,
      inbound: params.inbound,
    })
  );

  if (!text) return { ...fallback, source: 'heuristic' };

  const parsed = sanitizeClassification(extractJson(text));
  if (!parsed) return { ...fallback, source: 'heuristic' };

  // Si la IA está poco segura, se mezcla con la heurística.
  if (parsed.confidence < 0.5 && fallback.confidence > parsed.confidence) {
    return { ...fallback, source: 'heuristic' };
  }

  return { ...parsed, source: 'ai' };
}

export interface ReplyParams {
  clientName: string;
  amountCents: number;
  dueDate: string;
  channel: ChannelName;
  intent: string;
  inbound: string;
}

const REPLY_FALLBACKS: Record<string, string> = {
  paga: 'Gracias por avisar. Estamos revisando tu pago y lo aplicamos a tu saldo en cuanto se refleje.',
  promete: 'Gracias por tu confirmación. Te acompañamos en la fecha indicada para cualquier duda.',
  rechaza: 'Entendemos. Escríbenos por este medio para revisar tu caso y buscar la mejor opción.',
  pide_factura: 'Con gusto. Te enviamos la factura por este mismo canal en un momento.',
  pide_info:
    'Tu saldo pendiente es el monto indicado. Si necesitas el detalle, con gusto te lo enviamos.',
  molesto:
    'Disculpa la molestia. No te volveremos a escribir por este canal. Si lo requieres, quedamos a tus órdenes.',
  no_responde: 'Te escribimos para recordarte tu saldo pendiente. Responde cuando puedas.',
  otro: 'Gracias por tu mensaje. Tu caso quedó registrado y te confirmaremos a la brevedad.',
};

export async function draftReply(env: Env, params: ReplyParams): Promise<string> {
  const fallback = REPLY_FALLBACKS[params.intent] ?? REPLY_FALLBACKS.otro!;

  const text = await runAI(
    env,
    SYSTEM_REPLY,
    buildReplyPrompt({
      clientName: params.clientName,
      amountText: formatMXN(params.amountCents),
      dueDate: formatDateMX(`${params.dueDate}T12:00:00Z`),
      channel: params.channel,
      intent: params.intent,
      inbound: params.inbound,
    })
  );

  if (!text) return fallback;
  const body = cleanMessage(text);
  if (!body) return fallback;
  return params.channel === 'sms' ? clampLength(body, 160) : body;
}
