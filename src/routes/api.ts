import { Hono } from 'hono';
import { formatMXNShort } from '../lib/money';
import { maskPhone } from '../lib/phone';
import { configLegal } from '../legal/config';
import { catalogoReglas } from '../legal/motor';
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
import { isAdmin } from './auth';

export const api = new Hono<{ Bindings: Env }>();

api.use('*', async (c, next) => {
  if (!isAdmin(c.req.raw, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

api.get('/metrics/today', async (c) => {
  const date = c.req.query('date') ?? todayIso(c.env.TZ);
  const metrics = await dailyMetrics(c.env, date);
  return c.json({ ok: true, date, metrics });
});

api.get('/cases/today', async (c) => {
  const date = c.req.query('date') ?? todayIso(c.env.TZ);
  const cases = await listCasesByDate(c.env, date);

  const rows = await Promise.all(
    cases.slice(0, 200).map(async (item) => {
      const state = readChannelState(item.channel_state);
      const intencion = await ultimaIntencion(c.env, item.id);
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
  const date = c.req.query('date') ?? todayIso(c.env.TZ);
  const result = await dispararHoy(c.env, date);
  return c.json({ ok: true, date, ...result });
});

api.get('/cases/:id', async (c) => {
  const item = await getCase(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, case: item });
});

api.get('/clients/:id', async (c) => {
  const client = await getClient(c.env, c.req.param('id'));
  if (!client) return c.json({ error: 'not_found' }, 404);
  const debts = await listPendingDebts(c.env, client.id);
  return c.json({ ok: true, client, debts });
});

api.get('/clients/:id/conversation', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const messages = await listConversation(c.env, c.req.param('id'), limit);
  return c.json({ ok: true, messages });
});

/** Catálogo legal: la ley del agente, ejecutable y auditable. */
api.get('/legal/catalogo', (c) => c.json({ ok: true, reglas: catalogoReglas() }));

api.get('/legal/hoy', async (c) => {
  const date = c.req.query('date') ?? todayIso(c.env.TZ);
  const legal = configLegal(c.env);
  const resumen = await resumenCumplimiento(c.env, date);
  const auditoria = await listAudit(c.env, 20);

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
