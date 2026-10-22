import { Hono } from 'hono';
import { adapters } from '../channels';
import { formatMXNShort } from '../lib/money';
import { maskPhone } from '../lib/phone';
import { configLegal } from '../legal/config';
import { catalogoReglas, evaluarMensaje } from '../legal/motor';
import type { AuthVars } from '../auth/middleware';
import { requireTenantMembership } from '../auth/middleware';
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
import { getContractByClient } from '../services/contratos';
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
import { recordPromise } from '../services/promesas';
import { todayIso } from '../services/db';
import { dispararHoy } from '../orquestacion/disparador';
import { mergeChannelCredentials } from '../tenancy/channels';
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

  const legal = configLegal(ctx);

  return c.json({
    ok: true,
    case: item,
    client,
    debts,
    contract,
    messages,
    contactos_24h: contactos24h,
    legal: {
      nombre_legal: legal.nombreLegal || null,
      condusef: legal.condusef || null,
      ventana: { inicio: legal.horaInicio, fin: legal.horaFin },
      max_contactos_24h: legal.maxContactos24h,
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
