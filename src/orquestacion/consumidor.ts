import { redactMessage } from '../ai/agent';
import { adapters, resolveChannels } from '../channels';
import { configLegal } from '../legal/config';
import { evaluarMensaje } from '../legal/motor';
import { IdempotencyKey, reserveOnceConLegado } from '../lib/idempotencia';
import { logger } from '../lib/logger';
import { isWithinSendWindow } from '../lib/score';
import type { Env } from '../types/env';
import type { CobranzaQueueMessage, ContabilidadRetryMessage } from '../types/env';
import { getCase, readChannelState, updateCase, type ChannelState } from '../services/casos';
import { getClient } from '../services/clientes';
import { getContractByClient } from '../services/contratos';
import { listPendingDebts } from '../services/deudas';
import { countContactos24h, countSentForCase, recordMessage } from '../services/mensajes';
import { registrarViolaciones } from '../services/legalAudit';
import { hasOpenPromise } from '../services/promesas';
import { logEvent } from '../services/eventos';
import { reintentarEnvioAlegra } from '../contabilidad/sendToAlegra';
import { acquireClientLock, releaseClientLock } from '../durable/call-lock';
import { mergeChannelCredentials } from '../tenancy/channels';
import { resolveTenantContext } from '../tenancy/context';
import type { TenantContext } from '../tenancy/types';

export class DeferredError extends Error {
  constructor(
    message: string,
    public delaySeconds: number
  ) {
    super(message);
    this.name = 'DeferredError';
  }
}

/**
 * Throttle suave por proveedor: máximo N envíos por minuto y canal.
 *
 * El contador es POR TENANT: el límite de RPM pertenece a la cuenta del
 * cliente, no a la plataforma. Usa un Durable Object por tenant+canal para
 * evitar race conditions que tenía la implementación basada en KV.
 */
async function acquireRateSlot(ctx: TenantContext, channel: string): Promise<boolean> {
  const rpm = ctx.config.rateLimitRpm;
  const doId = ctx.env.RATE_LIMITER.idFromName(`${ctx.tenantId}:${channel}`);
  const stub = ctx.env.RATE_LIMITER.get(doId);

  const response = await stub.fetch(
    `https://rate-limiter/acquire?rpm=${rpm}`,
    { method: 'POST' }
  );

  if (!response.ok) {
    if (response.status === 429) {
      const data = await response.json<{ retryAfter: number }>();
      throw new DeferredError(`Throttle de ${channel}`, data.retryAfter);
    }
    return false;
  }

  return true;
}

function diasDeRetraso(dueDate: string): number {
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((Date.now() - due) / 86_400_000));
}

/**
 * Procesa un caso de cobranza: redacta con IA, envía por el canal disponible
 * y registra el resultado. Respeta opt-in, dedupe 24h, ventana legal y throttling.
 */
export async function processCase(
  ctx: TenantContext,
  msg: CobranzaQueueMessage
): Promise<void> {
  const collectionCase = await getCase(ctx, msg.caseId);
  if (!collectionCase) {
    logger.warn('Caso no encontrado', { caseId: msg.caseId });
    return;
  }

  if (['replied', 'promised', 'paid', 'human', 'failed'].includes(collectionCase.status)) {
    return;
  }

  const client = await getClient(ctx, collectionCase.client_id);
  if (!client) {
    logger.warn('Cliente no encontrado', { clientId: collectionCase.client_id });
    return;
  }

  if (client.do_not_disturb) {
    await updateCase(ctx, collectionCase.id, { status: 'human' });
    await logEvent(ctx, 'cobranza.dnd', { caseId: collectionCase.id, clientId: client.id });
    return;
  }

  if (await hasOpenPromise(ctx, client.id)) {
    await updateCase(ctx, collectionCase.id, { status: 'promised' });
    return;
  }

  const startHour = ctx.config.horaInicio;
  const endHour = ctx.config.horaFin;
  if (!isWithinSendWindow(new Date(), startHour, endHour, ctx.config.tz)) {
    throw new DeferredError('Fuera de la ventana legal de contacto', 1800);
  }

  const channels = resolveChannels(client, collectionCase.score_band);
  if (channels.length === 0) {
    await updateCase(ctx, collectionCase.id, { status: 'failed' });
    await logEvent(ctx, 'cobranza.sin_canal', {
      caseId: collectionCase.id,
      clientId: client.id,
      payload: { band: collectionCase.score_band },
    });
    return;
  }

  const locked = await acquireClientLock(ctx.env, client.id);
  if (!locked) {
    throw new DeferredError('Cliente ya tiene un envío en curso', 60);
  }

  try {
    const state: ChannelState = readChannelState(collectionCase.channel_state);
    const debts = await listPendingDebts(ctx, client.id);
    const dueDate = debts[0]?.due_date ?? collectionCase.case_date;
    const amountCents =
      debts.reduce((sum, debt) => sum + debt.amount_cents, 0) || collectionCase.amount_cents;

    const dedupeWindow = ctx.config.dedupeWindowHours * 3600;
    let sent = false;

    const legal = configLegal(ctx);
    const contrato = await getContractByClient(ctx, client.id);
    const contactos24h = await countContactos24h(ctx, client.id);
    const logsReales = await countSentForCase(ctx, collectionCase.id);
    const credenciales = mergeChannelCredentials(ctx.channels);

    for (const channel of channels) {
      const dedupeKey = IdempotencyKey.forTenantCase(ctx.tenantId, collectionCase.id, channel);
      const legacyKey = IdempotencyKey.forCase(collectionCase.id, channel);
      const reserved = await reserveOnceConLegado(ctx.env.KV, dedupeKey, legacyKey, dedupeWindow, {
        at: Date.now(),
      });
      if (!reserved) {
        state[channel] = 'duplicado';
        continue;
      }

      const destination = channel === 'email' ? client.email : client.phone;
      if (!destination) {
        await ctx.env.KV.delete(dedupeKey);
        continue;
      }

      await acquireRateSlot(ctx, channel);

      const drafted = await redactMessage(ctx.env, {
        channel,
        clientName: client.name,
        amountCents,
        dueDate,
        diasRetraso: diasDeRetraso(dueDate),
        band: collectionCase.score_band,
        nombreLegal: legal.nombreLegal,
        condusef: legal.condusef,
      });

      // ── Motor de cumplimiento: la ley como código ejecutable ──
      const veredicto = evaluarMensaje({
        ahora: new Date(),
        canal: channel,
        mensaje: drafted.body,
        asunto: drafted.subject,
        nombreLegal: legal.nombreLegal,
        condusef: legal.condusef,
        clienteId: client.id,
        clienteNombre: client.name,
        telefono: client.phone,
        email: client.email,
        montoCents: amountCents,
        contrato,
        contactos24h,
        logsReales,
        logsCrm: state.attempts ?? 0,
        dominiosPermitidos: legal.dominiosPermitidos,
        maxContactos24h: legal.maxContactos24h,
        ventanaContacto: { inicio: legal.horaInicio, fin: legal.horaFin },
        toleranciaCents: legal.montoToleranciaCents,
        zonaHoraria: ctx.config.tz,
        caseId: collectionCase.id,
        esRespuesta: false,
      });

      if (veredicto.violaciones.length > 0) {
        await registrarViolaciones(ctx, veredicto.violaciones, {
          caseId: collectionCase.id,
          clientId: client.id,
          canal: channel,
        });
      }

      if (!veredicto.permitido) {
        // Fail-closed: no se lauda el mensaje por otro canal, el caso va a humano.
        await ctx.env.KV.delete(dedupeKey);
        state[channel] = `bloqueado:${veredicto.bloqueadoPor}`;
        await updateCase(ctx, collectionCase.id, {
          status: 'human',
          channelState: state as unknown as Record<string, unknown>,
        });
        await logEvent(ctx, 'cobranza.bloqueado_legal', {
          caseId: collectionCase.id,
          clientId: client.id,
          payload: {
            regla: veredicto.bloqueadoPor,
            violaciones: veredicto.violaciones.map((v) => ({
              regla: v.reglaId,
              accion: v.accion,
              detalle: v.detalle,
              articulo: v.articulo,
            })),
          },
        });
        return;
      }

      const result = await adapters[channel].send(ctx.env, {
        to: destination,
        body: veredicto.mensaje,
        subject: drafted.subject,
        caseId: collectionCase.id,
        clientId: client.id,
        idempotencyKey: dedupeKey,
        credentials: credenciales,
        dryRun: ctx.config.dryRun,
        meta: { source: 'cobranza', ai: drafted.source },
      });

      await recordMessage(ctx, {
        caseId: collectionCase.id,
        clientId: client.id,
        channel,
        direction: 'outbound',
        providerId: result.providerId ?? null,
        body: veredicto.mensaje,
        status: result.ok ? 'sent' : 'failed',
        error: result.error ?? null,
        meta: {
          ai: drafted.source,
          band: collectionCase.score_band,
          legal: veredicto.violaciones.map((v) => `${v.reglaId}:${v.accion}`).join(','),
        },
      });

      if (result.ok) {
        state[channel] = 'sent';
        state.lastChannel = channel;
        state.attempts = (state.attempts ?? 0) + 1;
        sent = true;
        if (veredicto.requiereHumano) {
          await updateCase(ctx, collectionCase.id, {
            status: 'human',
            channelState: state as unknown as Record<string, unknown>,
          });
          await logEvent(ctx, 'cobranza.escalado_legal', {
            caseId: collectionCase.id,
            clientId: client.id,
            payload: { canal: channel },
          });
        }
        break;
      }

      state[channel] = 'failed';
      await ctx.env.KV.delete(dedupeKey);
      await logEvent(ctx, 'cobranza.envio_fallido', {
        caseId: collectionCase.id,
        clientId: client.id,
        payload: { channel, error: result.error },
      });
    }

    await updateCase(ctx, collectionCase.id, {
      status: sent ? 'sent' : 'failed',
      channelState: state as unknown as Record<string, unknown>,
    });

    if (sent) {
      await logEvent(ctx, 'cobranza.enviado', {
        caseId: collectionCase.id,
        clientId: client.id,
        payload: { state },
      });
    }
  } finally {
    await releaseClientLock(ctx.env, client.id);
  }
}

/** Consumidor de la cola de cobranza. */
export async function consumeBatch(
  batch: MessageBatch<CobranzaQueueMessage | ContabilidadRetryMessage>,
  env: Env
): Promise<void> {
  const contextos = new Map<string, TenantContext>();

  const contextoPara = async (tenantId?: string): Promise<TenantContext> => {
    const clave = tenantId ?? 'default';
    let ctx = contextos.get(clave);
    if (!ctx) {
      ctx = await resolveTenantContext(env, { tenantId });
      contextos.set(clave, ctx);
    }
    return ctx;
  };

  for (const message of batch.messages) {
    const body = message.body;

    // ── Módulo contable: reintento de Alegra ──
    if (body && body.type === 'contabilidad.reintento') {
      try {
        const ctx = await contextoPara(body.tenantId);
        const resultado = await reintentarEnvioAlegra(ctx, body.fechaCorte, body.attempt);
        if (resultado.ok) {
          message.ack();
          continue;
        }
        if (resultado.reintentoProgramado) {
          message.ack();
          continue;
        }
        throw new Error(resultado.motivo ?? 'falló el reintento contable');
      } catch (error) {
        logger.error('Falló el reintento contable contra Alegra', {
          fechaCorte: body.fechaCorte,
          attempt: body.attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
      continue;
    }

    try {
      const ctx = await contextoPara(body.tenantId);
      await processCase(ctx, body as CobranzaQueueMessage);
      message.ack();
    } catch (error) {
      if (error instanceof DeferredError) {
        logger.info('Mensaje diferido', { reason: error.message, delay: error.delaySeconds });
        message.retry({ delaySeconds: error.delaySeconds });
        continue;
      }
      logger.error('Fallo procesando caso', {
        caseId: (body as CobranzaQueueMessage)?.caseId,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}
