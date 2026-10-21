import { Hono } from 'hono';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import { todayIso } from '../services/db';
import { listCasesByDate } from '../services/casos';
import { dailyMetrics } from '../services/metricas';
import { configLegal } from '../legal/config';
import { catalogoReglas } from '../legal/motor';
import { resumenCumplimiento } from '../services/legalAudit';
import { dispararHoy } from '../orquestacion/disparador';
import { logEvent } from '../services/eventos';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';

export const agent = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * API del agente.
 *
 * Cada ruta exige su scope (`agent:read`, `agent:decide`, `agent:dispatch`,
 * `agent:audit`). El token del bot (`GROK_BOT_TOKEN`, rol `service_agent`) los
 * tiene los cuatro; el de administración, también. Antes bastaba con que la
 * petición fuera del bot o del admin, sin distinguir qué se le pedía.
 */
agent.get('/state', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'agent:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const date = c.req.query('date') ?? todayIso(ctx.config.tz);
  const cases = await listCasesByDate(ctx, date);
  const metrics = await dailyMetrics(ctx, date);
  const legal = configLegal(ctx);
  const cumplimiento = await resumenCumplimiento(ctx, date);
  const mode = ctx.config.agentMode.toLowerCase();
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
  const guardia = await exigePrincipalConScope(c, 'agent:decide');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const body = await c.req.json().catch(() => ({}));
  const date = (body?.date as string) ?? todayIso(ctx.config.tz);
  const cases = await listCasesByDate(ctx, date);
  const threshold = ctx.config.agentAutoThresholdCents;
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
      priority:
        item.score_band === 'alto' ? 'high' : item.score_band === 'medio' ? 'medium' : 'low',
    };
  });
  await logEvent(ctx, 'agent.decide', { payload: { date, count: plan.length } });
  return c.json({ ok: true, date, plan });
});

agent.post('/dispatch', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'agent:dispatch');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const body = await c.req.json().catch(() => ({}));
  const date = (body?.date as string) ?? todayIso(ctx.config.tz);
  const mode = (body?.mode as string) ?? ctx.config.agentMode;
  const autonomous = mode.toLowerCase() === 'autonomous';

  if (!autonomous) {
    const cases = await listCasesByDate(ctx, date);
    await logEvent(ctx, 'agent.dispatch.supervised', { payload: { date, cases: cases.length } });
    return c.json({
      ok: true,
      mode: 'supervised',
      message: 'recomendacion_generada_use_disparar_manual',
      date,
    });
  }

  const result = await dispararHoy(ctx, date);
  await logEvent(ctx, 'agent.dispatch.autonomous', { payload: { date, ...result } });
  return c.json({ ok: true, mode: 'autonomous', date, ...result });
});

agent.post('/audit', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'agent:audit');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const body = await c.req.json().catch(() => ({}));
  await logEvent(resultado.ctx, 'agent.audit', { payload: body ?? {} });
  return c.json({ ok: true });
});
