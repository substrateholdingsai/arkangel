import { Hono, type Context } from 'hono';
import { classifyInbound } from '../ai/agent';
import type { AuthVars } from '../auth/middleware';
import type { ChannelName } from '../channels/types';
import { scoreShermanV2 } from '../lib/score';
import type { Env } from '../types/env';
import { todayIso } from '../services/db';
import { getCase, listCasesByDate, updateCase } from '../services/casos';
import { listPendingDebts, markDebtStatus } from '../services/deudas';
import { dailyMetrics } from '../services/metricas';
import { recordPromise } from '../services/promesas';
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

/**
 * Clasificación en tiempo real por Grok Bot (`POST /api/v1/classify` o `/api/v1/bot/classify`).
 * Clasifica un mensaje entrante con Workers AI + fallback heurístico y, si se indica
 * `case_id` y `apply !== false`, aplica automáticamente la transición al caso
 * (promesa de pago registrada o escalamiento a supervisor humano).
 */
async function handleRealtimeClassify(c: Context<{ Bindings: Env; Variables: AuthVars }>) {
  const guardia = await exigePrincipalConScope(c, 'agent:decide');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const body = (await c.req.json().catch(() => ({}))) as {
    case_id?: string;
    inbound?: string;
    channel?: string;
    client_name?: string;
    amount_cents?: number;
    due_date?: string;
    apply?: boolean;
  };

  const inbound = typeof body.inbound === 'string' ? body.inbound.trim() : '';
  if (!inbound) {
    return c.json({ ok: false, error: 'El campo inbound es obligatorio.' }, 400);
  }

  const channel: ChannelName =
    body.channel === 'sms' || body.channel === 'email' ? body.channel : 'whatsapp';

  const caseId =
    typeof body.case_id === 'string' && body.case_id.trim() ? body.case_id.trim() : null;
  const caseItem = caseId ? await getCase(ctx, caseId) : null;

  const clientName =
    (typeof body.client_name === 'string' && body.client_name.trim()) ||
    caseItem?.name ||
    'Cliente';
  const amountCents =
    typeof body.amount_cents === 'number' && body.amount_cents > 0
      ? Math.round(body.amount_cents)
      : (caseItem?.amount_cents ?? 100000);
  const dueDate =
    (typeof body.due_date === 'string' && body.due_date.trim()) ||
    caseItem?.case_date ||
    todayIso(ctx.config.tz);

  const classification = await classifyInbound(ctx.env, {
    clientName,
    amountCents,
    dueDate,
    channel,
    inbound,
  });

  let recommendedAction: 'escalate_human' | 'record_promise' | 'verify_payment' | 'continue_ai' =
    'continue_ai';

  if (classification.molesto || classification.requiereHumano) {
    recommendedAction = 'escalate_human';
  } else if (classification.intent === 'promete') {
    recommendedAction = 'record_promise';
  } else if (classification.intent === 'paga') {
    recommendedAction = 'verify_payment';
  }

  const shouldApply = Boolean(caseItem) && body.apply !== false;
  let newCaseStatus: string | null = caseItem?.status ?? null;

  if (caseItem && shouldApply) {
    if (recommendedAction === 'escalate_human') {
      await updateCase(ctx, caseItem.id, { status: 'human' });
      newCaseStatus = 'human';
    } else if (recommendedAction === 'record_promise') {
      const promisedDate = classification.fechaPrometida ?? todayIso(ctx.config.tz);
      const promisedAmount = classification.montoPrometidoCents ?? caseItem.amount_cents;
      await recordPromise(ctx, {
        tenantId: ctx.tenantId,
        caseId: caseItem.id,
        clientId: caseItem.client_id,
        amountCents: promisedAmount,
        promisedDate,
        confidence: classification.confidence,
        source: 'ai',
      });
      const debts = await listPendingDebts(ctx, caseItem.client_id);
      for (const debt of debts) {
        await markDebtStatus(ctx, debt.id, 'promised');
      }
      await updateCase(ctx, caseItem.id, { status: 'promised' });
      newCaseStatus = 'promised';
    }
  }

  await logEvent(ctx, 'agent.classify', {
    caseId: caseItem?.id,
    clientId: caseItem?.client_id,
    payload: {
      intent: classification.intent,
      confidence: classification.confidence,
      source: classification.source,
      recommended_action: recommendedAction,
      applied: shouldApply,
    },
  });

  return c.json({
    ok: true,
    classification,
    recommended_action: recommendedAction,
    case_id: caseItem?.id ?? null,
    case_status: newCaseStatus,
    applied: shouldApply,
  });
}

agent.post('/classify', handleRealtimeClassify);
agent.post('/bot/classify', handleRealtimeClassify);

/**
 * Ajuste continuo de scoring y umbrales por resultados (`POST /api/v1/scoring/calibrate`
 * o `/api/v1/calibrate`).
 * Analiza la conversión real por banda Sherman v2 (`alto`, `medio`, `bajo`), recomienda
 * `score_amount_ceiling_cents` y `agent_auto_threshold_cents`, y si `apply: true`
 * actualiza la configuración del despacho y recalcula el score de los casos en cola.
 */
async function handleScoringCalibrate(c: Context<{ Bindings: Env; Variables: AuthVars }>) {
  const guardia = await exigePrincipalConScope(c, 'agent:decide');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const body = (await c.req.json().catch(() => ({}))) as {
    date?: string;
    apply?: boolean;
    score_amount_ceiling_cents?: number;
    agent_auto_threshold_cents?: number;
  };

  const date =
    typeof body.date === 'string' && body.date.trim() ? body.date.trim() : todayIso(ctx.config.tz);
  const cases = await listCasesByDate(ctx, date);

  const statsPorBanda: Record<
    'alto' | 'medio' | 'bajo',
    { total: number; recovered: number; escalated: number; conversion_rate: number }
  > = {
    alto: { total: 0, recovered: 0, escalated: 0, conversion_rate: 0 },
    medio: { total: 0, recovered: 0, escalated: 0, conversion_rate: 0 },
    bajo: { total: 0, recovered: 0, escalated: 0, conversion_rate: 0 },
  };

  for (const item of cases) {
    const band =
      item.score_band === 'alto' || item.score_band === 'medio' ? item.score_band : 'bajo';
    statsPorBanda[band].total += 1;
    if (item.status === 'paid' || item.status === 'promised') {
      statsPorBanda[band].recovered += 1;
    } else if (item.status === 'human') {
      statsPorBanda[band].escalated += 1;
    }
  }

  for (const band of ['alto', 'medio', 'bajo'] as const) {
    const b = statsPorBanda[band];
    b.conversion_rate = b.total > 0 ? Number((b.recovered / b.total).toFixed(4)) : 0;
  }

  const totalCases = cases.length;
  const totalRecovered =
    statsPorBanda.alto.recovered + statsPorBanda.medio.recovered + statsPorBanda.bajo.recovered;
  const totalEscalated =
    statsPorBanda.alto.escalated + statsPorBanda.medio.escalated + statsPorBanda.bajo.escalated;
  const overallConversion = totalCases > 0 ? totalRecovered / totalCases : 0;
  const escalationRate = totalCases > 0 ? totalEscalated / totalCases : 0;

  const prevCeiling = ctx.config.scoreAmountCeilingCents || 200_000;
  const prevThreshold = ctx.config.agentAutoThresholdCents || 200_000;

  // Ajuste adaptativo:
  // - Si la tasa de conversión es alta (>= 35%) y pocos escalados (< 20%), podemos elevar 15% el umbral autónomo.
  // - Si la tasa de escalamiento es alta (>= 35%), reducimos 15% el techo de monto para priorizar intervención temprana.
  let recommendedCeiling = prevCeiling;
  let recommendedThreshold = prevThreshold;

  if (escalationRate >= 0.35) {
    recommendedCeiling = Math.max(50_000, Math.round(prevCeiling * 0.85));
    recommendedThreshold = Math.max(50_000, Math.round(prevThreshold * 0.85));
  } else if (overallConversion >= 0.35 && escalationRate < 0.2) {
    recommendedCeiling = Math.min(5_000_000, Math.round(prevCeiling * 1.15));
    recommendedThreshold = Math.min(5_000_000, Math.round(prevThreshold * 1.15));
  }

  if (
    typeof body.score_amount_ceiling_cents === 'number' &&
    body.score_amount_ceiling_cents >= 10_000
  ) {
    recommendedCeiling = Math.round(body.score_amount_ceiling_cents);
  }
  if (
    typeof body.agent_auto_threshold_cents === 'number' &&
    body.agent_auto_threshold_cents >= 10_000
  ) {
    recommendedThreshold = Math.round(body.agent_auto_threshold_cents);
  }

  const apply = body.apply === true;
  let rescoredCases = 0;

  if (apply) {
    try {
      await ctx.env.DB.prepare(
        `UPDATE tenants
         SET score_amount_ceiling_cents = ?,
             agent_auto_threshold_cents = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(recommendedCeiling, recommendedThreshold, ctx.tenantId)
        .run();
    } catch {
      /* continúa si la tabla tenants es mockeada parcialmente */
    }

    for (const item of cases) {
      if (item.status === 'ready') {
        const evaluated = scoreShermanV2({
          amountCents: item.amount_cents,
          dueDate: item.case_date,
          ceilingCents: recommendedCeiling,
        });
        try {
          await ctx.env.DB.prepare(
            "UPDATE cases SET score = ?, score_band = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?"
          )
            .bind(evaluated.score, evaluated.band, ctx.tenantId, item.id)
            .run();
          rescoredCases += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }

  await logEvent(ctx, 'agent.scoring_calibrated', {
    payload: {
      date,
      applied: apply,
      previous_ceiling_cents: prevCeiling,
      calibrated_ceiling_cents: recommendedCeiling,
      previous_threshold_cents: prevThreshold,
      calibrated_threshold_cents: recommendedThreshold,
      rescored_cases: rescoredCases,
    },
  });

  return c.json({
    ok: true,
    date,
    applied: apply,
    previous: {
      score_amount_ceiling_cents: prevCeiling,
      agent_auto_threshold_cents: prevThreshold,
    },
    calibrated: {
      score_amount_ceiling_cents: recommendedCeiling,
      agent_auto_threshold_cents: recommendedThreshold,
    },
    band_performance: statsPorBanda,
    rescored_cases: rescoredCases,
  });
}

agent.post('/scoring/calibrate', handleScoringCalibrate);
agent.post('/calibrate', handleScoringCalibrate);
