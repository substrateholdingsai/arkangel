import { Hono } from 'hono';
import { askCopilot, type CopilotHistoryItem } from '../ai/copilot';
import { adapters } from '../channels';
import { parseCobreWebhook } from '../channels/cobre';
import { parseConektaWebhook } from '../channels/conekta';
import { formatMXN, formatMXNShort } from '../lib/money';
import { maskPhone } from '../lib/phone';
import { isWithinSendWindow, localHour } from '../lib/score';
import { configLegal } from '../legal/config';
import { catalogoReglas, evaluarMensaje } from '../legal/motor';
import type { AuthVars } from '../auth/middleware';
import { requireTenantMembership } from '../auth/middleware';
import { construirEnlace, enviarCorreoAuth } from '../auth/email';
import {
  emailIsValid,
  inviteTenantMember,
  listTenantMembers,
  normalizaEmail,
  removeTenantMember,
  type MembershipRole,
} from '../auth/native';
import type { Channel } from '../types/cobranza';
import type { Env } from '../types/env';
import {
  etiquetaEstado,
  getCase,
  listCasesByDate,
  proximaAccion,
  readChannelState,
  updateCase,
} from '../services/casos';
import { getClient, markDoNotDisturb } from '../services/clientes';
import {
  getContractByClient,
  getContractCfdi,
  isValidCfdiUuid,
  upsertContract,
  upsertContractCfdi,
} from '../services/contratos';
import { listPendingDebts, markDebtStatus } from '../services/deudas';
import { logEvent } from '../services/eventos';
import {
  countContactos24h,
  countSentForCase,
  listConversation,
  recordMessage,
  ultimaIntencion,
} from '../services/mensajes';
import { listAudit, registrarViolaciones, resumenCumplimiento } from '../services/legalAudit';
import { dailyMetrics } from '../services/metricas';
import { parsePaymentCsv, reconcilePayment, reconcilePaymentBatch } from '../services/pagos';
import { recordPromise } from '../services/promesas';
import { todayIso } from '../services/db';
import { dispararHoy } from '../orquestacion/disparador';
import { getEnabledChannels, mergeChannelCredentials } from '../tenancy/channels';
import {
  listAllTenantChannels,
  saveTenantChannels,
  type UpsertTenantChannelInput,
} from '../tenancy/repository';
import { exigeTenant } from '../auth/guards';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';

export const api = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// La cabecera `X-Tenant-Id` sólo puede seleccionar uno de los despachos del
// usuario: si pide un tenant del que no es miembro, la petición se rechaza
// aquí con 403 antes de tocar un solo dato.
api.use('*', requireTenantMembership);

/**
 * Panel de cobranza.
 *
 * Cada ruta exige **su** scope: leer métricas no habilita a leer casos y
 * despachar no habilita a leerlos. Antes era un `isAdmin` global que dejaba
 * pasar cualquier token de administración a todo el router.
 *
 * El contexto de tenant se resuelve con el principal que la guardia ya
 * autorizó (no se vuelve a autenticar) y, cuando la ruta lo resuelve, se
 * comprueba con `exigeTenant` que el principal puede operar sobre ese tenant.
 */
api.get('/metrics/today', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'metrics:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const metrics = await dailyMetrics(ctx, date);
  return c.json({ ok: true, date, metrics });
});

api.get('/cases/today', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const cases = await listCasesByDate(ctx, date);

  const rows = await Promise.all(
    cases.slice(0, 200).map(async (item) => {
      const state = readChannelState(item.channel_state);
      const intencion = await ultimaIntencion(ctx, item.id);
      return {
        id: item.id,
        client_id: item.client_id,
        nombre: item.name,
        telefono: maskPhone(item.phone),
        email: item.email,
        monto: formatMXNShort(item.amount_cents),
        monto_cents: item.amount_cents,
        estado: item.status,
        estado_label: etiquetaEstado(item.status),
        banda: item.score_band,
        score: item.score,
        ultimo_canal: state.lastChannel ?? null,
        intencion,
        proxima_accion: proximaAccion(item.status),
      };
    })
  );

  return c.json({
    ok: true,
    date,
    count: cases.length,
    total_cents: cases.reduce((sum, item) => sum + item.amount_cents, 0),
    cases: rows,
  });
});

api.post('/disparar', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:dispatch');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const result = await dispararHoy(ctx, date);
  return c.json({ ok: true, date, ...result });
});

/**
 * Caso por id.
 *
 * Estas rutas leen por id, así que además del scope hay que comprobar que el
 * principal puede operar sobre el tenant con el que se está respondiendo: un
 * usuario del despacho A no puede pedir el caso de un id del despacho B
 * poniéndole la cabecera del despacho B.
 */
api.get('/cases/:id', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const denegado = exigeTenant(guardia.principal, resultado.ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(resultado.ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, case: item });
});

/**
 * Ficha completa del caso para el Drawer del Operador:
 * caso + cliente + deudas + contrato legal + historial omnicanal + estado legal.
 */
api.get('/cases/:id/workspace', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const [client, debts, contract, messages, contactos24h] = await Promise.all([
    getClient(ctx, item.client_id),
    listPendingDebts(ctx, item.client_id),
    getContractByClient(ctx, item.client_id),
    listConversation(ctx, item.client_id, 50),
    countContactos24h(ctx, item.client_id),
  ]);

  // Notas manuales del agente (estilo Payments by Wix)
  let notes: Array<{ id: string; note: string; actor: string; created_at: string }> = [];
  try {
    const notesRows = await ctx.env.DB.prepare(
      "SELECT id, payload, created_at FROM events WHERE tenant_id = ? AND case_id = ? AND type = 'operador.nota_interna' ORDER BY created_at DESC LIMIT 20"
    )
      .bind(ctx.tenantId, item.id)
      .all<{ id: string; payload: string | null; created_at: string }>();
    notes = (notesRows.results ?? []).map((r) => {
      let parsed: { note?: string; actor?: string } = {};
      try {
        parsed = r.payload ? (JSON.parse(r.payload) as { note?: string; actor?: string }) : {};
      } catch {
        parsed = {};
      }
      return {
        id: r.id,
        note: parsed.note ?? '',
        actor: parsed.actor ?? 'operador',
        created_at: r.created_at,
      };
    });
  } catch {
    notes = [];
  }

  // Construcción del Diagnóstico Ejecutivo IA (Handoff sin leer el hilo completo)
  const inboundMsgs = messages.filter((m) => m.direction === 'inbound');
  const lastInbound = inboundMsgs.length > 0 ? inboundMsgs[inboundMsgs.length - 1]! : null;
  let lastIntention: string | null = null;
  let confidence = 0.85;
  if (lastInbound?.meta) {
    try {
      const m = JSON.parse(lastInbound.meta) as {
        intencion?: string;
        confianza?: number;
        payment_reconciled?: boolean;
      };
      if (m.intencion) lastIntention = m.intencion;
      if (typeof m.confianza === 'number') confidence = m.confianza;
      if (m.payment_reconciled) lastIntention = 'conciliado';
    } catch {
      /* ignore */
    }
  }

  let headline = `Caso en seguimiento por ${formatMXN(item.amount_cents)}.`;
  let reason = 'Gestión preventiva automática.';
  let paymentStatus: 'paid' | 'promised' | 'claimed_paid' | 'pending' = 'pending';
  let recommendedAction = 'Monitorear respuesta del cliente.';

  if (item.status === 'paid' || lastIntention === 'conciliado') {
    headline = `Pago conciliado y liquidado (${formatMXN(item.amount_cents)}).`;
    reason = 'Fondos confirmados por motor de conciliación (Cobre SPEI / Tesorería).';
    paymentStatus = 'paid';
    recommendedAction = 'No contactar al cliente. Caso cerrado.';
  } else if (lastIntention === 'paga') {
    headline = `⚠️ Cliente reporta haber realizado el pago de ${formatMXN(item.amount_cents)}.`;
    reason = `El deudor indicó pago en su último mensaje ("${lastInbound?.body.slice(0, 90) ?? ''}").`;
    paymentStatus = 'claimed_paid';
    recommendedAction =
      'Verificar recepción SPEI en Cobre o estado de cuenta antes de insistir en el cobro.';
  } else if (item.status === 'promised' || lastIntention === 'promete') {
    headline = `Promesa de pago activa por ${formatMXN(item.amount_cents)}.`;
    reason = lastInbound
      ? `Compromiso capturado por IA: "${lastInbound.body.slice(0, 90)}".`
      : 'Promesa registrada en el expediente.';
    paymentStatus = 'promised';
    recommendedAction =
      'Esperar liquidación automática vía CLABE virtual Cobre o CSV bancario en la fecha prometida.';
  } else if (lastIntention === 'pide_factura') {
    headline = `Cliente reconoce el saldo (${formatMXN(item.amount_cents)}) pero solicita CFDI / convenio.`;
    reason = `Escalado por IA (${Math.round(confidence * 100)}% confianza): "${lastInbound?.body.slice(0, 100) ?? ''}"`;
    recommendedAction =
      'Confirmar envío de CFDI al correo y registrar fecha de Promesa de Pago arriba.';
  } else if (lastIntention === 'molesto' || lastIntention === 'rechaza') {
    headline = `Cliente solicitó atención de ejecutivo humano (${formatMXN(item.amount_cents)}).`;
    reason = `Escalado por IA para contención empática: "${lastInbound?.body.slice(0, 100) ?? ''}"`;
    recommendedAction =
      'Acordar fecha viable de pago respetando CLABE contractual o aplicar Baja DND si revoca consentimiento.';
  } else if (item.status === 'human') {
    headline = `Caso delegado a supervisor humano (${formatMXN(item.amount_cents)}).`;
    reason = lastInbound
      ? `Último mensaje del cliente: "${lastInbound.body.slice(0, 100)}"`
      : 'Superó umbral de riesgo o requiere validación manual.';
    recommendedAction = 'Revisar condiciones del contrato y registrar acuerdo o promesa.';
  }

  const legal = configLegal(ctx);
  const cfdiUuid = contract ? await getContractCfdi(ctx, contract.id) : null;
  const enabledChannels = getEnabledChannels(ctx.channels);

  return c.json({
    ok: true,
    case: item,
    client,
    debts,
    contract: contract ? { ...contract, cfdi_uuid: cfdiUuid } : null,
    cfdi_uuid: cfdiUuid,
    messages,
    notes,
    ai_diagnostic: {
      headline,
      reason,
      payment_status: paymentStatus,
      recommended_action: recommendedAction,
      intention: lastIntention,
      confidence,
    },
    contactos_24h: contactos24h,
    legal: {
      nombre_legal: legal.nombreLegal || null,
      condusef: legal.condusef || null,
      ventana: { inicio: legal.horaInicio, fin: legal.horaFin },
      max_contactos_24h: legal.maxContactos24h,
      enabled_channels: enabledChannels,
    },
  });
});

/**
 * Vinculación del UUID de CFDI timbrado al contrato del cliente (`contract_cfdi`).
 * Cuando se timbra una factura/convenio ante el SAT, el UUID se enlaza al contrato
 * y se propaga automáticamente a las pólizas de Alegra (`cfdi_relacionado`).
 */
api.put('/cases/:id/cfdi', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:write');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const payload = (await c.req.json().catch(() => ({}))) as { cfdi_uuid?: string };
  const rawUuid = typeof payload.cfdi_uuid === 'string' ? payload.cfdi_uuid.trim() : '';

  if (!isValidCfdiUuid(rawUuid)) {
    return c.json(
      {
        ok: false,
        error:
          'El UUID del CFDI no tiene el formato fiscal estándar del SAT (XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX).',
      },
      400
    );
  }

  const legal = configLegal(ctx);
  let contract = await getContractByClient(ctx, item.client_id);
  if (!contract) {
    contract = await upsertContract(ctx, {
      tenantId: ctx.tenantId,
      clientId: item.client_id,
      montoPactadoCents: item.amount_cents,
      nombreLegal: legal.nombreLegal || null,
      condusef: legal.condusef || null,
    });
  }

  const saved = await upsertContractCfdi(ctx, contract.id, rawUuid);

  await logEvent(ctx, 'operador.cfdi_vinculado', {
    caseId: item.id,
    clientId: item.client_id,
    payload: {
      contract_id: contract.id,
      cfdi_uuid: saved.cfdi_uuid,
      actor: guardia.principal.actorId,
    },
  });

  return c.json({
    ok: true,
    contract_id: contract.id,
    cfdi_uuid: saved.cfdi_uuid,
  });
});

/**
 * Notas internas manuales del operador (estilo Payments by Wix).
 * Permite dejar contexto que la IA no vio sin enviar mensajes al deudor.
 */
api.post('/cases/:id/notes', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:write');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const payload = (await c.req.json().catch(() => ({}))) as { note?: string };
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  if (!note) {
    return c.json({ ok: false, error: 'La nota no puede estar vacía.' }, 400);
  }

  const actor = guardia.principal.actorId || 'operador';
  await logEvent(ctx, 'operador.nota_interna', {
    caseId: item.id,
    clientId: item.client_id,
    payload: { note: note.slice(0, 1000), actor },
  });

  return c.json({
    ok: true,
    note: {
      note: note.slice(0, 1000),
      actor,
      created_at: new Date().toISOString(),
    },
  });
});

/**
 * Envío de mensaje manual por el operador humano desde el Drawer.
 *
 * REGLA INQUEBRANTABLE: El humano pasa por el mismo Motor Legal (`evaluarMensaje`)
 * que la IA. Si escribe una amenaza, una CLABE apócrifa o intenta contactar a
 * un cliente en No Molestar, el envío se bloquea (422) y queda sellado en `legal_audit`.
 */
api.post('/cases/:id/reply', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'messages:send');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const bodyJson = await c.req.json().catch(() => null);
  if (!bodyJson || typeof bodyJson !== 'object') {
    return c.json({ error: 'JSON inválido' }, 400);
  }
  const payload = bodyJson as Record<string, unknown>;
  const texto = typeof payload.body === 'string' ? payload.body.trim() : '';
  const canalRaw = typeof payload.channel === 'string' ? payload.channel : 'whatsapp';
  const channel: Channel =
    canalRaw === 'whatsapp' || canalRaw === 'sms' || canalRaw === 'email' ? canalRaw : 'whatsapp';

  if (!texto) {
    return c.json({ error: 'El mensaje no puede estar vacío.' }, 400);
  }

  const enabledChannels = getEnabledChannels(ctx.channels);
  if (!enabledChannels.includes(channel)) {
    return c.json(
      {
        ok: false,
        error: `El canal ${channel} está deshabilitado por el Manager de este despacho.`,
        regla: 'canal_inactivo',
        violaciones: [],
      },
      422
    );
  }

  const [client, contract, contactos24h, logsReales] = await Promise.all([
    getClient(ctx, item.client_id),
    getContractByClient(ctx, item.client_id),
    countContactos24h(ctx, item.client_id),
    countSentForCase(ctx, item.id),
  ]);

  const destino =
    channel === 'email' ? (client?.email ?? item.email) : (client?.phone ?? item.phone);
  if (!destino) {
    return c.json({ error: `El cliente no tiene destino para el canal ${channel}.` }, 400);
  }

  if (client?.do_not_disturb) {
    return c.json(
      {
        ok: false,
        error: 'Bloqueado: el cliente tiene activo No Molestar (DND · Regla 2.3/6.1).',
        regla: '2.3',
        violaciones: [],
      },
      422
    );
  }

  const legal = configLegal(ctx);
  const veredicto = evaluarMensaje({
    ahora: new Date(),
    canal: channel,
    mensaje: texto,
    nombreLegal: legal.nombreLegal,
    condusef: legal.condusef,
    clienteId: item.client_id,
    clienteNombre: item.name,
    telefono: client?.phone ?? item.phone,
    email: client?.email ?? item.email,
    montoCents: item.amount_cents,
    contrato: contract,
    contactos24h,
    logsReales,
    logsCrm: logsReales,
    dominiosPermitidos: legal.dominiosPermitidos,
    maxContactos24h: legal.maxContactos24h,
    ventanaContacto: { inicio: legal.horaInicio, fin: legal.horaFin },
    toleranciaCents: legal.montoToleranciaCents,
    zonaHoraria: ctx.config.tz,
    caseId: item.id,
    esRespuesta: true,
    respuestaExenta: !legal.horarioEnRespuestas,
  });

  if (veredicto.violaciones.length > 0) {
    await registrarViolaciones(ctx, veredicto.violaciones, {
      caseId: item.id,
      clientId: item.client_id,
      canal: channel,
    });
  }

  if (!veredicto.permitido) {
    await logEvent(ctx, 'operador.mensaje_bloqueado_legal', {
      caseId: item.id,
      clientId: item.client_id,
      payload: {
        regla: veredicto.bloqueadoPor,
        actor: guardia.principal.actorId,
      },
    });
    return c.json(
      {
        ok: false,
        error: `Bloqueado por Motor Legal (Regla ${veredicto.bloqueadoPor})`,
        regla: veredicto.bloqueadoPor,
        violaciones: veredicto.violaciones,
      },
      422
    );
  }

  const sendRes = await adapters[channel].send(ctx.env, {
    to: destino,
    body: veredicto.mensaje,
    subject: typeof payload.subject === 'string' ? payload.subject : 'Seguimiento de cuenta',
    caseId: item.id,
    clientId: item.client_id,
    credentials: mergeChannelCredentials(ctx.channels),
    dryRun: ctx.config.dryRun,
    meta: { human_operator: true, actor: guardia.principal.actorId },
  });

  const recorded = await recordMessage(ctx, {
    caseId: item.id,
    clientId: item.client_id,
    channel,
    direction: 'outbound',
    providerId: sendRes.providerId ?? null,
    body: veredicto.mensaje,
    status: sendRes.ok ? 'sent' : 'failed',
    error: sendRes.error ?? null,
    meta: {
      human_operator: true,
      actor: guardia.principal.actorId,
      legal: veredicto.violaciones.map((v) => `${v.reglaId}:${v.accion}`).join(','),
    },
  });

  return c.json({
    ok: sendRes.ok,
    message: recorded,
    sanitized_body: veredicto.mensaje,
    violaciones: veredicto.violaciones,
  });
});

/**
 * Resolución manual de un caso delegado al humano:
 *   - `promise`: registra promesa de pago (monto y fecha) y marca caso/deudas como `promised`
 *   - `paid`: confirma pago y marca caso/deudas como `paid`
 *   - `return_ai`: devuelve el caso a la cola de la IA (`contacted`)
 *   - `dnd`: activa No Molestar (`do_not_disturb = 1`)
 */
api.post('/cases/:id/resolve', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:write');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const bodyJson = await c.req.json().catch(() => null);
  if (!bodyJson || typeof bodyJson !== 'object') {
    return c.json({ error: 'JSON inválido' }, 400);
  }
  const payload = bodyJson as Record<string, unknown>;
  const action = typeof payload.action === 'string' ? payload.action : '';
  const debts = await listPendingDebts(ctx, item.client_id);

  if (action === 'promise') {
    const promisedAmount =
      typeof payload.promised_amount_cents === 'number' && payload.promised_amount_cents > 0
        ? Math.round(payload.promised_amount_cents)
        : item.amount_cents;
    const promisedDate =
      typeof payload.promised_date === 'string' && payload.promised_date.trim()
        ? payload.promised_date.trim()
        : todayIso(ctx.config.tz);

    await recordPromise(ctx, {
      tenantId: ctx.tenantId,
      caseId: item.id,
      clientId: item.client_id,
      amountCents: promisedAmount,
      promisedDate,
      confidence: 1,
      source: 'human',
    });
    for (const debt of debts) await markDebtStatus(ctx, debt.id, 'promised');
    await updateCase(ctx, item.id, { status: 'promised' });
    await logEvent(ctx, 'operador.promesa_registrada', {
      caseId: item.id,
      clientId: item.client_id,
      payload: {
        amount_cents: promisedAmount,
        promised_date: promisedDate,
        actor: guardia.principal.actorId,
      },
    });
    return c.json({ ok: true, status: 'promised', promised_date: promisedDate });
  }

  if (action === 'paid') {
    for (const debt of debts) await markDebtStatus(ctx, debt.id, 'paid');
    await updateCase(ctx, item.id, { status: 'paid' });
    await logEvent(ctx, 'operador.pago_confirmado', {
      caseId: item.id,
      clientId: item.client_id,
      payload: { actor: guardia.principal.actorId },
    });
    return c.json({ ok: true, status: 'paid' });
  }

  if (action === 'return_ai') {
    await markDoNotDisturb(ctx, item.client_id, false);
    await updateCase(ctx, item.id, { status: 'sent' });
    await logEvent(ctx, 'operador.devuelto_ia', {
      caseId: item.id,
      clientId: item.client_id,
      payload: { actor: guardia.principal.actorId },
    });
    return c.json({ ok: true, status: 'sent' });
  }

  if (action === 'dnd') {
    await markDoNotDisturb(ctx, item.client_id, true);
    await logEvent(ctx, 'operador.no_molestar', {
      caseId: item.id,
      clientId: item.client_id,
      payload: { actor: guardia.principal.actorId },
    });
    return c.json({ ok: true, status: item.status, do_not_disturb: true });
  }

  return c.json({ error: 'Acción no reconocida' }, 400);
});

/**
 * Softphone del Operador (WebRTC en navegador + Auditoría Legal de Llamada).
 *
 * - `phase: 'start'`: verifica horario legal (Regla 2.1), límite de contactos
 *   diarios (Regla 2.2) y bandera No Molestar (Regla 6.1) antes de abrir línea,
 *   y devuelve el guion de identificación obligatorio (Regla 1.1).
 * - `phase: 'complete'`: audita las notas/transcripción de la llamada contra el
 *   Motor Legal, registra la llamada en el historial del caso y sella el evento.
 */
api.post('/cases/:id/call', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'messages:send');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const item = await getCase(ctx, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);

  const bodyJson = await c.req.json().catch(() => null);
  const payload =
    bodyJson && typeof bodyJson === 'object' ? (bodyJson as Record<string, unknown>) : {};
  const phase = typeof payload.phase === 'string' ? payload.phase : 'start';

  const [client, contract, contactos24h, logsReales] = await Promise.all([
    getClient(ctx, item.client_id),
    getContractByClient(ctx, item.client_id),
    countContactos24h(ctx, item.client_id),
    countSentForCase(ctx, item.id),
  ]);

  const legal = configLegal(ctx);
  const razonSocial = contract?.nombre_legal || legal.nombreLegal || 'Despacho Autorizado';
  const condusef = contract?.condusef || legal.condusef || 'REDECO-PENDIENTE';

  if (phase === 'start') {
    if (client?.do_not_disturb) {
      return c.json(
        {
          ok: false,
          error: 'Llamada bloqueada: el cliente tiene activo No Molestar (DND).',
          regla: '2.3',
          violaciones: [],
        },
        422
      );
    }

    const guionApertura = `Buenos días/tardes, le llamamos de ${razonSocial} (CONDUSEF ${condusef}) respecto a su saldo de ${formatMXNShort(item.amount_cents)}.`;
    const veredicto = evaluarMensaje({
      ahora: new Date(),
      canal: 'sms',
      mensaje: guionApertura,
      nombreLegal: razonSocial,
      condusef,
      clienteId: item.client_id,
      clienteNombre: item.name,
      telefono: client?.phone ?? item.phone,
      email: client?.email ?? item.email,
      montoCents: item.amount_cents,
      contrato: contract,
      contactos24h,
      logsReales,
      logsCrm: logsReales,
      dominiosPermitidos: legal.dominiosPermitidos,
      maxContactos24h: legal.maxContactos24h,
      ventanaContacto: { inicio: legal.horaInicio, fin: legal.horaFin },
      toleranciaCents: legal.montoToleranciaCents,
      zonaHoraria: ctx.config.tz,
      caseId: item.id,
      esRespuesta: false,
    });

    if (!veredicto.permitido) {
      await registrarViolaciones(ctx, veredicto.violaciones, {
        caseId: item.id,
        clientId: item.client_id,
        canal: 'sms',
      });
      return c.json(
        {
          ok: false,
          error: `Llamada bloqueada por Motor Legal (Regla ${veredicto.bloqueadoPor})`,
          regla: veredicto.bloqueadoPor,
          violaciones: veredicto.violaciones,
        },
        422
      );
    }

    await logEvent(ctx, 'operador.llamada_iniciada', {
      caseId: item.id,
      clientId: item.client_id,
      payload: { actor: guardia.principal.actorId },
    });

    return c.json({
      ok: true,
      call_id: `call_${Date.now()}`,
      phone: client?.phone ?? item.phone,
      guion_obligatorio: guionApertura,
      clabe_autorizada: contract?.clabe ?? null,
    });
  }

  // phase === 'complete'
  const durationSeconds =
    typeof payload.duration_seconds === 'number'
      ? Math.max(0, Math.round(payload.duration_seconds))
      : 0;
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const outcome = typeof payload.outcome === 'string' ? payload.outcome : 'contacted';

  const resumenLlamada = `[Llamada Softphone · ${durationSeconds}s · ${outcome}] ${notes || 'Llamada finalizada con identificación legal.'} — ${razonSocial} (${condusef})`;

  const recorded = await recordMessage(ctx, {
    caseId: item.id,
    clientId: item.client_id,
    channel: 'sms',
    direction: 'outbound',
    providerId: `softphone_${Date.now()}`,
    body: resumenLlamada,
    status: 'delivered',
    meta: {
      softphone: true,
      duration_seconds: durationSeconds,
      outcome,
      actor: guardia.principal.actorId,
    },
  });

  await logEvent(ctx, 'operador.llamada_completada', {
    caseId: item.id,
    clientId: item.client_id,
    payload: {
      duration_seconds: durationSeconds,
      outcome,
      actor: guardia.principal.actorId,
    },
  });

  return c.json({ ok: true, message: recorded });
});

api.get('/clients/:id', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'clients:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const denegado = exigeTenant(guardia.principal, resultado.ctx.tenantId);
  if (denegado) return denegado;

  const client = await getClient(resultado.ctx, c.req.param('id'));
  if (!client) return c.json({ error: 'not_found' }, 404);
  const debts = await listPendingDebts(resultado.ctx, client.id);
  return c.json({ ok: true, client, debts });
});

api.get('/clients/:id/conversation', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'messages:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const denegado = exigeTenant(guardia.principal, resultado.ctx.tenantId);
  if (denegado) return denegado;

  const limit = Number(c.req.query('limit') ?? 50);
  const messages = await listConversation(resultado.ctx, c.req.param('id'), limit);
  return c.json({ ok: true, messages });
});

/** Catálogo legal: la ley del agente, ejecutable y auditable. */
api.get('/legal/catalogo', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:read');
  if (!guardia.ok) return guardia.response;
  return c.json({ ok: true, reglas: catalogoReglas() });
});

api.get('/legal/hoy', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const legal = configLegal(ctx);
  const resumen = await resumenCumplimiento(ctx, date);
  const auditoria = await listAudit(ctx, 20);

  return c.json({
    ok: true,
    date,
    identidad_configurada: Boolean(legal.nombreLegal),
    nombre_legal: legal.nombreLegal || null,
    condusef: legal.condusef || null,
    dominios_permitidos: legal.dominiosPermitidos,
    max_contactos_24h: legal.maxContactos24h,
    ventana: { inicio: legal.horaInicio, fin: legal.horaFin },
    resumen,
    auditoria,
  });
});

/**
 * Telemetría en vivo del sistema para el widget "Estado del Sistema".
 * Mide latencia real de D1, estado de Workers AI, cola activa, motor legal,
 * ventana NOM-184 en tiempo real y RPM del Durable Object / D1.
 */
api.get('/system/status', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'metrics:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const t0 = Date.now();

  let d1Ok = true;
  let clientsTotal = 0;
  let rpmDb = 0;
  try {
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    const [clientsRow, rpmRow] = await Promise.all([
      ctx.env.DB.prepare('SELECT COUNT(*) AS total FROM clients WHERE tenant_id = ?')
        .bind(ctx.tenantId)
        .first<{ total: number }>(),
      ctx.env.DB.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ? AND direction = 'outbound' AND created_at >= ?"
      )
        .bind(ctx.tenantId, oneMinAgo)
        .first<{ total: number }>(),
    ]);
    clientsTotal = Number(clientsRow?.total ?? 0);
    rpmDb = Number(rpmRow?.total ?? 0);
  } catch {
    d1Ok = false;
  }
  const latencyMs = Math.max(1, Date.now() - t0);

  const [metrics, resumen] = await Promise.all([
    dailyMetrics(ctx, date),
    resumenCumplimiento(ctx, date),
  ]);

  const maxRpm = ctx.config.rateLimitRpm || 42;
  let doRpm = 0;
  try {
    if (ctx.env.RATE_LIMITER) {
      const doId = ctx.env.RATE_LIMITER.idFromName(`${ctx.tenantId}:whatsapp`);
      const stub = ctx.env.RATE_LIMITER.get(doId);
      const res = await stub.fetch(`https://rate-limiter/status?action=status&rpm=${maxRpm}`);
      if (res.ok) {
        const data = await res.json<{ count?: number }>();
        doRpm = Number(data.count ?? 0);
      }
    }
  } catch {
    /* fallback silencioso al conteo de ventana de 60s en D1 */
  }

  const legal = configLegal(ctx);
  const reglasActivas = catalogoReglas().length;
  const now = new Date();
  const abiertaAhora = isWithinSendWindow(now, legal.horaInicio, legal.horaFin, ctx.config.tz);
  const horaLocal = localHour(now, ctx.config.tz);
  const aiModel = (ctx.env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    .replace('@cf/meta/', '')
    .replace('-instruct-fp8-fast', '');

  return c.json({
    ok: true,
    timestamp: now.toISOString(),
    d1: {
      ok: d1Ok,
      latency_ms: latencyMs,
      clients_total: clientsTotal,
    },
    workers_ai: {
      ok: Boolean(ctx.env.AI),
      model: aiModel,
      dry_run: ctx.config.dryRun,
    },
    queue: {
      ok: Boolean(ctx.env.COBRANZA_QUEUE),
      ready: metrics.por_estado?.ready ?? 0,
      sending: metrics.por_estado?.sending ?? 0,
    },
    legal_engine: {
      ok: Boolean(legal.nombreLegal && legal.condusef),
      reglas_activas: reglasActivas,
      conductas_auditadas: 48,
      razon_social: legal.nombreLegal || null,
      condusef: legal.condusef || null,
      bloqueos_hoy: resumen.bloqueos,
    },
    ventana: {
      inicio: legal.horaInicio,
      fin: legal.horaFin,
      tz: ctx.config.tz,
      hora_local: horaLocal,
      abierta_ahora: abiertaAhora,
    },
    rate_limit: {
      whatsapp_rpm: Math.min(maxRpm, Math.max(doRpm, rpmDb)),
      max_rpm: maxRpm,
      enviados_hoy: metrics.enviadas,
    },
  });
});

/**
 * Copiloto Operativo y QA Legal en vivo (Workers AI + Contexto completo del Worker).
 * Permite a empleados nuevos o supervisores consultar cómo operar la plataforma,
 * qué casos urgentes atender, reglas legales o pedir un borrador blindado para el caso activo.
 */
api.post('/copilot/chat', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const payload = (await c.req.json().catch(() => ({}))) as {
    message?: string;
    history?: CopilotHistoryItem[];
    active_case_id?: string | null;
  };

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return c.json({ ok: false, error: 'Escribe una pregunta para el Copiloto.' }, 400);
  }

  const history = Array.isArray(payload.history)
    ? payload.history.filter(
        (h): h is CopilotHistoryItem =>
          Boolean(h) &&
          (h.role === 'user' || h.role === 'assistant') &&
          typeof h.content === 'string'
      )
    : [];

  const activeCaseId =
    typeof payload.active_case_id === 'string' && payload.active_case_id.trim()
      ? payload.active_case_id.trim()
      : null;

  const response = await askCopilot(ctx, {
    message,
    history,
    activeCaseId,
  });

  return c.json({
    ok: true,
    reply: response.reply,
    suggested_draft: response.suggestedDraft,
    context_summary: response.contextSummary,
  });
});

/**
 * Embudo Canónico de Conciliación de Pagos (`POST /api/v1/payments/reconcile`).
 * Acepta:
 *  1) `multipart/form-data` con campo `file` (CSV bancario legacy: BBVA, Banorte, Santander, STP).
 *  2) JSON con `{ csv: "..." }` (CSV crudo).
 *  3) JSON con evento de Cobre (`{ event: "money_movements.status.completed", data: { ... } }`).
 *  4) JSON directo (`{ clabe, amount_cents, tracking_key, reference, phone, email, source }`).
 */
api.post('/payments/reconcile', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:write');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    const csvText = file instanceof File ? await file.text() : String(form.get('csv') ?? '');
    if (!csvText.trim()) {
      return c.json({ ok: false, error: 'Archivo CSV de pagos vacío.' }, 400);
    }
    const items = parsePaymentCsv(csvText);
    if (items.length === 0) {
      return c.json(
        { ok: false, error: 'No se encontraron filas de pago válidas en el CSV.' },
        400
      );
    }
    const summary = await reconcilePaymentBatch(ctx, items);
    return c.json({ ok: true, mode: 'csv_legacy', ...summary });
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.csv === 'string' && body.csv.trim()) {
    const items = parsePaymentCsv(body.csv);
    const summary = await reconcilePaymentBatch(ctx, items);
    return c.json({ ok: true, mode: 'csv_legacy', ...summary });
  }

  // Si es un payload de Conekta (`type: "order.paid"` / `"charge.paid"`)
  if (body.type === 'order.paid' || body.type === 'charge.paid' || body.source === 'conekta_spei') {
    const conektaPayment = parseConektaWebhook(body);
    if (conektaPayment) {
      const single = await reconcilePayment(ctx, conektaPayment);
      return c.json({
        ok: true,
        mode: 'conekta_spei',
        total: 1,
        reconciled: single.status === 'reconciled' ? 1 : 0,
        duplicate: single.status === 'duplicate' ? 1 : 0,
        unmatched: single.status === 'unmatched' ? 1 : 0,
        totalReconciledCents: single.appliedCents,
        results: [single],
      });
    }
  }

  // Si es un payload de Cobre SPEI (`event: "money_movements.status.completed"` o `data.virtual_clabe`)
  const cobrePayment = parseCobreWebhook(body);
  if (cobrePayment && (body.event || body.data || body.source === 'cobre_spei')) {
    const single = await reconcilePayment(ctx, cobrePayment);
    return c.json({
      ok: true,
      mode: 'cobre_spei',
      total: 1,
      reconciled: single.status === 'reconciled' ? 1 : 0,
      duplicate: single.status === 'duplicate' ? 1 : 0,
      unmatched: single.status === 'unmatched' ? 1 : 0,
      totalReconciledCents: single.appliedCents,
      results: [single],
    });
  }

  const amountCents =
    typeof body.amount_cents === 'number'
      ? Math.round(body.amount_cents)
      : typeof body.amount === 'number'
        ? Math.round(body.amount * 100)
        : 0;

  const single = await reconcilePayment(ctx, {
    clabe: typeof body.clabe === 'string' ? body.clabe : null,
    reference: typeof body.reference === 'string' ? body.reference : null,
    phone: typeof body.phone === 'string' ? body.phone : null,
    email: typeof body.email === 'string' ? body.email : null,
    trackingKey: typeof body.tracking_key === 'string' ? body.tracking_key : null,
    amountCents,
    source:
      body.source === 'cobre_spei' || body.source === 'csv_legacy' || body.source === 'api_webhook'
        ? body.source
        : 'manual_operator',
  });

  return c.json({
    ok: true,
    mode: 'single',
    total: 1,
    reconciled: single.status === 'reconciled' ? 1 : 0,
    duplicate: single.status === 'duplicate' ? 1 : 0,
    unmatched: single.status === 'unmatched' ? 1 : 0,
    totalReconciledCents: single.appliedCents,
    results: [single],
  });
});

/**
 * Configuración Legal y Operativa del Despacho (`GET /api/v1/tenant/settings` y `PUT /api/v1/tenant/settings`).
 * Permite editar razón social, registro CONDUSEF/REDECO, dominios permitidos,
 * ventana horaria NOM-184, límites de contacto y modo de operación IA desde la UI.
 */
api.get('/tenant/settings', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const appUrl = (ctx.env.APP_URL || 'https://arkangel.arksystems.site').replace(/\/+$/, '');

  return c.json({
    ok: true,
    settings: {
      tenant_id: ctx.tenantId,
      slug: ctx.tenant.slug,
      nombre: ctx.tenant.nombre,
      config_mode: ctx.tenant.config_mode,
      razon_social: ctx.config.razonSocial,
      condusef_registro: ctx.config.condusef,
      allowed_payment_domains: ctx.config.dominiosPermitidos.join(', '),
      tz: ctx.config.tz,
      send_window_start: ctx.config.horaInicio,
      send_window_end: ctx.config.horaFin,
      max_contacts_per_day: ctx.config.maxContactos24h,
      rate_limit_rpm: ctx.config.rateLimitRpm,
      agent_mode: ctx.config.agentMode,
      agent_auto_threshold_cents: ctx.config.agentAutoThresholdCents,
      dry_run: ctx.config.dryRun,
    },
    webhooks: {
      conekta: `${appUrl}/webhooks/conekta`,
      cobre: `${appUrl}/webhooks/cobre`,
      whatsapp: `${appUrl}/webhooks/whatsapp`,
      telnyx: `${appUrl}/webhooks/telnyx`,
      resend: `${appUrl}/webhooks/resend`,
    },
  });
});

api.put('/tenant/settings', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:config');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const nombre =
    typeof body.nombre === 'string' && body.nombre.trim()
      ? body.nombre.trim().slice(0, 120)
      : ctx.tenant.nombre;

  const razonSocial =
    typeof body.razon_social === 'string'
      ? body.razon_social.trim().slice(0, 200)
      : ctx.config.razonSocial;

  const condusefRegistro =
    typeof body.condusef_registro === 'string'
      ? body.condusef_registro.trim().slice(0, 80)
      : ctx.config.condusef;

  const allowedPaymentDomains =
    typeof body.allowed_payment_domains === 'string'
      ? body.allowed_payment_domains
          .split(',')
          .map((d) =>
            d
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/\/.*$/, '')
          )
          .filter(Boolean)
          .join(',')
      : ctx.config.dominiosPermitidos.join(',');

  const sendWindowStart =
    typeof body.send_window_start === 'number'
      ? Math.max(0, Math.min(22, Math.round(body.send_window_start)))
      : ctx.config.horaInicio;

  const sendWindowEnd =
    typeof body.send_window_end === 'number'
      ? Math.max(sendWindowStart + 1, Math.min(24, Math.round(body.send_window_end)))
      : ctx.config.horaFin;

  const maxContactsPerDay =
    typeof body.max_contacts_per_day === 'number'
      ? Math.max(1, Math.min(10, Math.round(body.max_contacts_per_day)))
      : ctx.config.maxContactos24h;

  const rateLimitRpm =
    typeof body.rate_limit_rpm === 'number'
      ? Math.max(1, Math.min(600, Math.round(body.rate_limit_rpm)))
      : ctx.config.rateLimitRpm;

  const agentMode =
    body.agent_mode === 'autonomous' || body.agent_mode === 'supervised'
      ? body.agent_mode
      : ctx.config.agentMode;

  const agentAutoThresholdCents =
    typeof body.agent_auto_threshold_cents === 'number'
      ? Math.max(0, Math.round(body.agent_auto_threshold_cents))
      : ctx.config.agentAutoThresholdCents;

  const dryRun =
    typeof body.dry_run === 'boolean' ? (body.dry_run ? 1 : 0) : ctx.config.dryRun ? 1 : 0;

  const configMode = razonSocial && condusefRegistro ? 'db' : ctx.tenant.config_mode;

  await ctx.env.DB.prepare(
    `UPDATE tenants
     SET nombre = ?,
         config_mode = ?,
         razon_social = ?,
         condusef_registro = ?,
         allowed_payment_domains = ?,
         send_window_start = ?,
         send_window_end = ?,
         max_contacts_per_day = ?,
         rate_limit_rpm = ?,
         agent_mode = ?,
         agent_auto_threshold_cents = ?,
         dry_run = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      nombre,
      configMode,
      razonSocial,
      condusefRegistro,
      allowedPaymentDomains,
      sendWindowStart,
      sendWindowEnd,
      maxContactsPerDay,
      rateLimitRpm,
      agentMode,
      agentAutoThresholdCents,
      dryRun,
      ctx.tenantId
    )
    .run();

  if (razonSocial && condusefRegistro) {
    try {
      await ctx.env.DB.prepare(
        "UPDATE contracts SET nombre_legal = ?, condusef = ?, updated_at = datetime('now') WHERE tenant_id = ?"
      )
        .bind(razonSocial, condusefRegistro, ctx.tenantId)
        .run();
    } catch {
      /* si contracts no está en un mock de prueba, continúa */
    }
  }

  await logEvent(ctx, 'tenant.config_actualizada', {
    payload: {
      actor: guardia.principal.actorId,
      razonSocial,
      condusefRegistro,
      allowedPaymentDomains,
      sendWindowStart,
      sendWindowEnd,
      maxContactsPerDay,
      rateLimitRpm,
      agentMode,
      dryRun: Boolean(dryRun),
    },
  });

  return c.json({
    ok: true,
    settings: {
      tenant_id: ctx.tenantId,
      slug: ctx.tenant.slug,
      nombre,
      config_mode: configMode,
      razon_social: razonSocial,
      condusef_registro: condusefRegistro,
      allowed_payment_domains: allowedPaymentDomains,
      tz: ctx.config.tz,
      send_window_start: sendWindowStart,
      send_window_end: sendWindowEnd,
      max_contacts_per_day: maxContactsPerDay,
      rate_limit_rpm: rateLimitRpm,
      agent_mode: agentMode,
      agent_auto_threshold_cents: agentAutoThresholdCents,
      dry_run: Boolean(dryRun),
    },
  });
});

/**
 * Gestión Self-Serve del Equipo del Despacho (`GET /api/v1/tenant/members`,
 * `POST /api/v1/tenant/members/invite` y `DELETE /api/v1/tenant/members/:userId`).
 */
api.get('/tenant/members', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const members = await listTenantMembers(ctx.env, ctx.tenantId);
  return c.json({ ok: true, members });
});

api.post('/tenant/members/invite', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:config');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = normalizaEmail(typeof body.email === 'string' ? body.email : '');
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 120) : '';
  const role: MembershipRole =
    body.role === 'owner' || body.role === 'admin' || body.role === 'member' ? body.role : 'admin';

  if (!emailIsValid(email)) {
    return c.json({ ok: false, error: 'Ingresa un correo electrónico válido.' }, 400);
  }

  const invited = await inviteTenantMember(ctx.env, {
    tenantId: ctx.tenantId,
    email,
    fullName,
    role,
  });

  const origen = new URL(c.req.url).origin;
  const inviteUrl = construirEnlace(ctx.env, 'invitar', invited.activationToken, origen);
  const emailSent = await enviarCorreoAuth(
    ctx.env,
    invited.email,
    'invitar',
    invited.activationToken,
    origen
  );

  await logEvent(ctx, 'tenant.miembro_invitado', {
    payload: {
      actor: guardia.principal.actorId,
      invitedUserId: invited.userId,
      email: invited.email,
      role: invited.role,
      isNewUser: invited.isNewUser,
      emailSent,
    },
  });

  const members = await listTenantMembers(ctx.env, ctx.tenantId);
  return c.json({
    ok: true,
    invited: {
      user_id: invited.userId,
      email: invited.email,
      full_name: invited.fullName,
      role: invited.role,
      is_new_user: invited.isNewUser,
    },
    email_sent: emailSent,
    invite_url: inviteUrl,
    members,
  });
});

api.delete('/tenant/members/:userId', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:config');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const targetUserId = c.req.param('userId');
  const res = await removeTenantMember(ctx.env, ctx.tenantId, targetUserId);
  if (!res.ok) {
    return c.json({ ok: false, error: res.error ?? 'No se pudo revocar al miembro.' }, 400);
  }

  await logEvent(ctx, 'tenant.miembro_revocado', {
    payload: {
      actor: guardia.principal.actorId,
      revokedUserId: targetUserId,
    },
  });

  const members = await listTenantMembers(ctx.env, ctx.tenantId);
  return c.json({ ok: true, members });
});

/**
 * Gestión Self-Serve de Canales por Despacho (`GET /api/v1/tenant/channels` y
 * `PUT /api/v1/tenant/channels`).
 * Permite al Manager (`legal:config`) encender/apagar canales (WhatsApp, SMS, Email)
 * y configurar su identificador de enrutado (`phone_number_id`, `messaging_profile_id`,
 * dominio receptor) y remitente propio.
 */
function buildNormalizedChannelConfigs(rows: Awaited<ReturnType<typeof listAllTenantChannels>>) {
  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  const channels: Array<{
    channel: 'whatsapp' | 'sms' | 'email';
    status: 'active' | 'inactive';
    provider_account_id: string;
    template_name: string;
    from_number: string;
    from_address: string;
  }> = [
    {
      channel: 'whatsapp',
      status: byChannel.get('whatsapp')?.status ?? 'active',
      provider_account_id:
        byChannel.get('whatsapp')?.provider_account_id ??
        byChannel.get('whatsapp')?.credentials?.whatsapp?.phone_number_id ??
        '',
      template_name: byChannel.get('whatsapp')?.credentials?.whatsapp?.template_name ?? '',
      from_number: '',
      from_address: '',
    },
    {
      channel: 'sms',
      status: byChannel.get('sms')?.status ?? 'active',
      provider_account_id:
        byChannel.get('sms')?.provider_account_id ??
        byChannel.get('sms')?.credentials?.sms?.messaging_profile_id ??
        '',
      template_name: '',
      from_number: byChannel.get('sms')?.credentials?.sms?.from_number ?? '',
      from_address: '',
    },
    {
      channel: 'email',
      status: byChannel.get('email')?.status ?? 'active',
      provider_account_id: byChannel.get('email')?.provider_account_id ?? '',
      template_name: '',
      from_number: '',
      from_address: byChannel.get('email')?.credentials?.email?.from_email ?? '',
    },
  ];
  return channels;
}

api.get('/tenant/channels', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const rows = await listAllTenantChannels(ctx.env, ctx.tenantId);
  const channels = buildNormalizedChannelConfigs(rows);
  return c.json({
    ok: true,
    channels,
    enabled_channels: channels.filter((ch) => ch.status === 'active').map((ch) => ch.channel),
  });
});

api.put('/tenant/channels', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:config');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const body = (await c.req.json().catch(() => ({}))) as {
    channels?: Array<Record<string, unknown>>;
  };

  if (!Array.isArray(body.channels) || body.channels.length === 0) {
    return c.json({ ok: false, error: 'Se requiere el arreglo channels.' }, 400);
  }

  const incoming = new Map<string, Record<string, unknown>>();
  for (const item of body.channels) {
    if (item && typeof item.channel === 'string') {
      incoming.set(item.channel, item);
    }
  }

  const orden: Array<'whatsapp' | 'sms' | 'email'> = ['whatsapp', 'sms', 'email'];
  const toSave: UpsertTenantChannelInput[] = orden.map((ch) => {
    const raw = incoming.get(ch) ?? {};
    const status = raw.status === 'inactive' ? 'inactive' : 'active';
    const providerAccountId =
      typeof raw.provider_account_id === 'string' && raw.provider_account_id.trim()
        ? raw.provider_account_id.trim().slice(0, 120)
        : null;
    const templateName =
      typeof raw.template_name === 'string' && raw.template_name.trim()
        ? raw.template_name.trim().slice(0, 120)
        : undefined;
    const fromNumber =
      typeof raw.from_number === 'string' && raw.from_number.trim()
        ? raw.from_number.trim().slice(0, 40)
        : undefined;
    const fromAddress =
      typeof raw.from_address === 'string' && raw.from_address.trim()
        ? raw.from_address.trim().slice(0, 140)
        : undefined;

    if (ch === 'whatsapp') {
      return {
        channel: 'whatsapp',
        status,
        providerAccountId,
        credentials:
          providerAccountId || templateName
            ? {
                whatsapp: {
                  ...(providerAccountId ? { phone_number_id: providerAccountId } : {}),
                  ...(templateName ? { template_name: templateName } : {}),
                },
              }
            : null,
      };
    }

    if (ch === 'sms') {
      return {
        channel: 'sms',
        status,
        providerAccountId,
        credentials:
          providerAccountId || fromNumber
            ? {
                sms: {
                  ...(providerAccountId ? { messaging_profile_id: providerAccountId } : {}),
                  ...(fromNumber ? { from_number: fromNumber } : {}),
                },
              }
            : null,
      };
    }

    return {
      channel: 'email',
      status,
      providerAccountId,
      credentials: fromAddress
        ? {
            email: {
              from_email: fromAddress,
            },
          }
        : null,
    };
  });

  const activeCount = toSave.filter((item) => item.status === 'active').length;
  if (activeCount === 0) {
    return c.json(
      {
        ok: false,
        error: 'Debes mantener al menos un canal activo para operar el despacho.',
      },
      400
    );
  }

  const savedRows = await saveTenantChannels(ctx.env, ctx.tenantId, toSave);
  const channels = buildNormalizedChannelConfigs(savedRows);

  await logEvent(ctx, 'tenant.canales_actualizados', {
    payload: {
      actor: guardia.principal.actorId,
      enabled_channels: channels.filter((ch) => ch.status === 'active').map((ch) => ch.channel),
    },
  });

  return c.json({
    ok: true,
    channels,
    enabled_channels: channels.filter((ch) => ch.status === 'active').map((ch) => ch.channel),
  });
});
