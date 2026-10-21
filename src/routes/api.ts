import { Hono } from 'hono';
import { formatMXNShort } from '../lib/money';
import { maskPhone } from '../lib/phone';
import { configLegal } from '../legal/config';
import { catalogoReglas } from '../legal/motor';
import type { AuthVars } from '../auth/middleware';
import { requireTenantMembership } from '../auth/middleware';
import type { Env } from '../types/env';
import {
  etiquetaEstado,
  getCase,
  listCasesByDate,
  proximaAccion,
  readChannelState,
} from '../services/casos';
import { getClient } from '../services/clientes';
import { listPendingDebts } from '../services/deudas';
import { listConversation, ultimaIntencion } from '../services/mensajes';
import { listAudit, resumenCumplimiento } from '../services/legalAudit';
import { dailyMetrics } from '../services/metricas';
import { todayIso } from '../services/db';
import { dispararHoy } from '../orquestacion/disparador';
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
