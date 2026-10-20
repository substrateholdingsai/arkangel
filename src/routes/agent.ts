import { Hono } from 'hono';
import type { Env } from '../types/env';
import { isAgent, isAdmin } from './auth';
import { todayIso } from '../services/db';
import { listCasesByDate } from '../services/casos';
import { dailyMetrics } from '../services/metricas';
import { configLegal } from '../legal/config';
import { catalogoReglas } from '../legal/motor';
import { resumenCumplimiento } from '../services/legalAudit';
import { dispararHoy } from '../orquestacion/disparador';
import { logEvent } from '../services/eventos';

export const agent = new Hono<{ Bindings: Env }>();

agent.use('*', async (c, next) => {
  if (!isAgent(c.req.raw, c.env) && !isAdmin(c.req.raw, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

agent.get('/state', async (c) => {
  const date = c.req.query('date') ?? todayIso(c.env.TZ);
  const cases = await listCasesByDate(c.env, date);
  const metrics = await dailyMetrics(c.env, date);
  const legal = configLegal(c.env);
  const cumplimiento = await resumenCumplimiento(c.env, date);
  const mode = (c.env.AGENT_MODE ?? 'supervised').toLowerCase();
  return c.json({
    ok: true,
    date,
    mode,
    legal: {
      nombre_legal: legal.nombreLegal || null,
      condusef: legal.condusef || null,
      ventana: { inicio: legal.horaInicio, fin: legal.horaFin },
      max_contactos_24h: legal.maxContactos24h,
      reglas: catalogoReglas().length,
    },
    metrics,
    cumplimiento,
    cases: cases.map((item) => ({
      id: item.id,
      name: item.name,
      amount_cents: item.amount_cents,
      status: item.status,
      score: item.score,
      score_band: item.score_band,
      channel_state: item.channel_state,
    })),
    count: cases.length,
  });
});

agent.post('/decide', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = (body?.date as string) ?? todayIso(c.env.TZ);
  const cases = await listCasesByDate(c.env, date);
  const threshold = Number(c.env.AGENT_AUTO_THRESHOLD_CENTS ?? 200000);
  const plan = cases.map((item) => {
    const escalado = item.amount_cents > threshold;
    return {
      case_id: item.id,
      action: escalado ? 'escalate_human' : 'dispatch',
      reason: escalado
        ? item.amount_cents > threshold
          ? 'monto_sobre_umbral'
          : 'caso_molesto'
        : 'dentro_de_reglas',
      priority: item.score_band === 'alto' ? 'high' : item.score_band === 'medio' ? 'medium' : 'low',
    };
  });
  await logEvent(c.env, 'agent.decide', { payload: { date, count: plan.length } });
  return c.json({ ok: true, date, plan });
});

agent.post('/dispatch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = (body?.date as string) ?? todayIso(c.env.TZ);
  const mode = (body?.mode as string) ?? (c.env.AGENT_MODE ?? 'supervised');
  const autonomous = mode.toLowerCase() === 'autonomous';

  if (!autonomous) {
    const cases = await listCasesByDate(c.env, date);
    await logEvent(c.env, 'agent.dispatch.supervised', { payload: { date, cases: cases.length } });
    return c.json({
      ok: true,
      mode: 'supervised',
      message: 'recomendacion_generada_use_disparar_manual',
      date,
    });
  }

  const result = await dispararHoy(c.env, date);
  await logEvent(c.env, 'agent.dispatch.autonomous', { payload: { date, ...result } });
  return c.json({ ok: true, mode: 'autonomous', date, ...result });
});

agent.post('/audit', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await logEvent(c.env, 'agent.audit', { payload: body ?? {} });
  return c.json({ ok: true });
});
