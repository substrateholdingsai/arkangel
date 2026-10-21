import { classifyInbound, draftReply } from '../ai/agent';
import { adapters } from '../channels';
import type { InboundMessage } from '../channels/types';
import { configLegal, assertTenantListoParaOperar } from '../legal/config';
import { evaluarMensaje } from '../legal/motor';
import { IdempotencyKey, reserveOnceConLegado } from '../lib/idempotencia';
import { logger } from '../lib/logger';
import { normalizePhone } from '../lib/phone';
import type { Env } from '../types/env';
import { findClientByContact, findOpenCase, markDoNotDisturb } from '../services/clientes';
import { getContractByClient } from '../services/contratos';
import { listPendingDebts, markDebtStatus } from '../services/deudas';
import { updateCase } from '../services/casos';
import {
  actualizarMetaMensaje,
  countContactos24h,
  countSentForCase,
  recordMessage,
} from '../services/mensajes';
import { registrarViolaciones } from '../services/legalAudit';
import { recordPromise } from '../services/promesas';
import { logEvent } from '../services/eventos';
import { mergeChannelCredentials } from '../tenancy/channels';
import { resolveTenantContext } from '../tenancy/context';
import type { TenantContext } from '../tenancy/types';

export interface InboundResult {
  handled: boolean;
  reason?: string;
  intent?: string;
  replied?: boolean;
}

/**
 * Procesa un mensaje entrante: registra, clasifica con IA, actualiza el caso
 * y responde por el mismo canal cuando la confianza es suficiente.
 */
export async function handleInbound(env: Env, inbound: InboundMessage): Promise<InboundResult> {
  const ctx = await resolveTenantContext(env, { tenantId: inbound.tenantId });
  const dedupeKey = IdempotencyKey.forTenantInbound(
    ctx.tenantId,
    inbound.channel,
    inbound.providerId
  );
  const legacyKey = IdempotencyKey.forInbound(inbound.channel, inbound.providerId);
  const isNew = await reserveOnceConLegado(env.KV, dedupeKey, legacyKey, 7 * 24 * 3600, {
    at: Date.now(),
  });
  if (!isNew) return { handled: false, reason: 'duplicado' };

  const phone = normalizePhone(inbound.from);
  const client = await findClientByContact(ctx, {
    phone,
    email: inbound.channel === 'email' ? inbound.from : null,
  });

  if (!client) {
    await logEvent(ctx, 'inbound.cliente_desconocido', {
      payload: { channel: inbound.channel, from: inbound.from },
    });
    return { handled: false, reason: 'cliente desconocido' };
  }

  const openCase = await findOpenCase(ctx, client.id);
  const caseId = openCase?.id ?? `cas_${client.id}`;

  const inboundRow = await recordMessage(ctx, {
    caseId,
    clientId: client.id,
    channel: inbound.channel,
    direction: 'inbound',
    providerId: inbound.providerId,
    body: inbound.body,
    status: 'received',
    meta: { contactName: inbound.contactName },
  });

  const debts = await listPendingDebts(ctx, client.id);
  const amountCents = debts.reduce((sum, debt) => sum + debt.amount_cents, 0);
  const dueDate =
    debts[0]?.due_date ?? openCase?.case_date ?? new Date().toISOString().slice(0, 10);

  const classification = await classifyInbound(env, {
    clientName: client.name,
    amountCents,
    dueDate,
    channel: inbound.channel,
    inbound: inbound.body,
  });

  await logEvent(ctx, 'inbound.clasificado', {
    caseId,
    clientId: client.id,
    payload: {
      intent: classification.intent,
      confidence: classification.confidence,
      source: classification.source,
    },
  });

  await actualizarMetaMensaje(ctx, inboundRow.id, {
    contactName: inbound.contactName,
    intent: classification.intent,
    confidence: classification.confidence,
    intent_source: classification.source,
  });

  let replied = false;

  switch (classification.intent) {
    case 'paga': {
      for (const debt of debts) await markDebtStatus(ctx, debt.id, 'paid');
      await recordPromise(ctx, {
        tenantId: ctx.tenantId,
        caseId,
        clientId: client.id,
        amountCents,
        promisedDate: new Date().toISOString().slice(0, 10),
        confidence: classification.confidence,
        source: classification.source,
      });
      await updateCase(ctx, caseId, { status: 'paid' });
      replied = await reply(
        env,
        ctx,
        inbound,
        client.id,
        caseId,
        client.name,
        amountCents,
        dueDate,
        classification.intent
      );
      break;
    }

    case 'promete': {
      const promised = classification.montoPrometidoCents ?? amountCents;
      await recordPromise(ctx, {
        tenantId: ctx.tenantId,
        caseId,
        clientId: client.id,
        amountCents: promised,
        promisedDate: classification.fechaPrometida,
        confidence: classification.confidence,
        source: classification.source,
      });
      for (const debt of debts) await markDebtStatus(ctx, debt.id, 'promised');
      await updateCase(ctx, caseId, { status: 'promised' });
      replied = await reply(
        env,
        ctx,
        inbound,
        client.id,
        caseId,
        client.name,
        amountCents,
        dueDate,
        classification.intent
      );
      break;
    }

    case 'molesto': {
      await markDoNotDisturb(ctx, client.id, true);
      await updateCase(ctx, caseId, { status: 'human' });
      replied = await reply(
        env,
        ctx,
        inbound,
        client.id,
        caseId,
        client.name,
        amountCents,
        dueDate,
        classification.intent
      );
      break;
    }

    case 'rechaza':
    case 'pide_factura':
    case 'pide_info': {
      await updateCase(ctx, caseId, { status: 'human' });
      replied = await reply(
        env,
        ctx,
        inbound,
        client.id,
        caseId,
        client.name,
        amountCents,
        dueDate,
        classification.intent
      );
      break;
    }

    default: {
      if (classification.confidence >= 0.6) {
        replied = await reply(
          env,
          ctx,
          inbound,
          client.id,
          caseId,
          client.name,
          amountCents,
          dueDate,
          classification.intent
        );
      } else {
        await updateCase(ctx, caseId, { status: 'human' });
      }
    }
  }

  return { handled: true, intent: classification.intent, replied };
}

async function reply(
  env: Env,
  ctx: TenantContext,
  inbound: InboundMessage,
  clientId: string,
  caseId: string,
  clientName: string,
  amountCents: number,
  dueDate: string,
  intent: string
): Promise<boolean> {
  try {
    // Fail-closed: tenant en modo db sin identidad legal no puede operar
    assertTenantListoParaOperar(ctx);

    const body = await draftReply(env, {
      clientName,
      amountCents,
      dueDate,
      channel: inbound.channel,
      intent,
      inbound: inbound.body,
    });

    const destination =
      inbound.channel === 'email' ? inbound.from : (inbound.to ?? normalizePhone(inbound.from));
    if (!destination) return false;

    // ── Motor de cumplimiento también sobre la respuesta automática ──
    const legal = configLegal(ctx);
    const contrato = await getContractByClient(ctx, clientId);
    const contactos24h = await countContactos24h(ctx, clientId);
    const logsReales = await countSentForCase(ctx, caseId);

    const veredicto = evaluarMensaje({
      ahora: new Date(),
      canal: inbound.channel,
      mensaje: body,
      nombreLegal: legal.nombreLegal,
      condusef: legal.condusef,
      clienteId: clientId,
      clienteNombre: clientName,
      telefono: inbound.from,
      email: inbound.channel === 'email' ? inbound.from : null,
      montoCents: amountCents,
      contrato,
      contactos24h,
      logsReales,
      logsCrm: logsReales,
      dominiosPermitidos: legal.dominiosPermitidos,
      maxContactos24h: legal.maxContactos24h,
      ventanaContacto: { inicio: legal.horaInicio, fin: legal.horaFin },
      toleranciaCents: legal.montoToleranciaCents,
      zonaHoraria: ctx.config.tz,
      caseId,
      esRespuesta: true,
      respuestaExenta: !legal.horarioEnRespuestas,
    });

    if (veredicto.violaciones.length > 0) {
      await registrarViolaciones(ctx, veredicto.violaciones, {
        caseId,
        clientId,
        canal: inbound.channel,
      });
    }

    if (!veredicto.permitido) {
      logger.warn('Respuesta automática bloqueada por el motor legal', {
        regla: veredicto.bloqueadoPor,
        caseId,
      });
      await logEvent(ctx, 'respuesta.bloqueada_legal', {
        caseId,
        clientId,
        payload: { regla: veredicto.bloqueadoPor },
      });
      return false;
    }

    const result = await adapters[inbound.channel].send(env, {
      to: destination,
      body: veredicto.mensaje,
      subject: 'Re: tu mensaje',
      caseId,
      clientId,
      credentials: mergeChannelCredentials(ctx.channels),
      dryRun: ctx.config.dryRun,
      meta: { reply: true },
    });

    await recordMessage(ctx, {
      caseId,
      clientId,
      channel: inbound.channel,
      direction: 'outbound',
      providerId: result.providerId ?? null,
      body: veredicto.mensaje,
      status: result.ok ? 'sent' : 'failed',
      error: result.error ?? null,
      meta: {
        auto_reply: true,
        intent,
        legal: veredicto.violaciones.map((v) => `${v.reglaId}:${v.accion}`).join(','),
      },
    });

    logger.info('Respuesta enviada', { channel: inbound.channel, intent, ok: result.ok });
    return result.ok;
  } catch (error) {
    logger.error('Falló la respuesta automática', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
