/**
 * Rutas de la API para el Agente Autónomo Hermes en Cloudflare Sandboxes (Hermes-flare).
 *
 * Expone:
 * 1. POST /api/v1/hermes/forensics/:caseId       (Scope: cases:resolve)
 * 2. POST /api/v1/hermes/skip-trace/:clientId     (Scope: clients:read)
 * 3. POST /api/v1/hermes/docket-synthesis/:caseId (Scope: cases:write)
 * 4. GET  /api/v1/hermes/jobs/:jobId             (Scope: cases:read)
 * 5. GET  /api/v1/hermes/cases/:caseId/jobs      (Scope: cases:read)
 */

import { Hono } from 'hono';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';
import {
  dispatchHermesForensicJob,
  getHermesForensicJob,
  listHermesJobsForCase,
  listHermesJobsForClient,
} from '../services/hermesForensics';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import type { AuthVars } from '../auth/middleware';

export const hermes = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * POST /api/v1/hermes/forensics/:caseId
 * Detona auditoría forense de facturas SAT, estados de cuenta y simulación de operaciones (Art. 69-B CFF).
 */
hermes.post('/forensics/:caseId', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:resolve');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ ok: false, error: 'Identificador de caso requerido' }, 400);
  }

  let body: { documentsR2Urls?: string[]; customPrompt?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const job = await dispatchHermesForensicJob(ctx, {
      caseId,
      taskType: 'sat_materiality',
      documentsR2Urls: body.documentsR2Urls,
      customPrompt: body.customPrompt,
    });

    return c.json({ ok: true, job });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al despachar peritaje SAT en Hermes:', { error: errorMsg, caseId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});

/**
 * POST /api/v1/hermes/skip-trace/:clientId
 * Inicia investigación patrimonial autónoma de bienes, inmuebles y sociedades del deudor.
 */
hermes.post('/skip-trace/:clientId', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'clients:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const clientId = c.req.param('clientId');
  if (!clientId) {
    return c.json({ ok: false, error: 'Identificador de cliente requerido' }, 400);
  }

  let body: { caseId?: string; customPrompt?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const job = await dispatchHermesForensicJob(ctx, {
      clientId,
      caseId: body.caseId,
      taskType: 'skip_trace',
      customPrompt: body.customPrompt,
    });

    return c.json({ ok: true, job });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al despachar skip-tracing en Hermes:', { error: errorMsg, clientId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});

/**
 * POST /api/v1/hermes/docket-synthesis/:caseId
 * Solicita la redacción pericial automatizada del capítulo de pruebas para el Cuaderno Judicial.
 */
hermes.post('/docket-synthesis/:caseId', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:write');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ ok: false, error: 'Identificador de caso requerido' }, 400);
  }

  let body: { customPrompt?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const job = await dispatchHermesForensicJob(ctx, {
      caseId,
      taskType: 'judicial_synthesis',
      customPrompt: body.customPrompt,
    });

    return c.json({ ok: true, job });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al generar síntesis judicial en Hermes:', { error: errorMsg, caseId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});

/**
 * GET /api/v1/hermes/jobs/:jobId
 * Consulta estado, logs de ejecución y conclusiones emitidas por el agente Hermes.
 */
hermes.get('/jobs/:jobId', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const jobId = c.req.param('jobId');
  if (!jobId) {
    return c.json({ ok: false, error: 'Identificador de trabajo requerido' }, 400);
  }

  try {
    const job = await getHermesForensicJob(ctx, jobId);

    if (!job) {
      return c.json({ ok: false, error: 'Peritaje forense no encontrado' }, 404);
    }

    return c.json({ ok: true, job });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al consultar trabajo en Hermes:', { error: errorMsg, jobId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});

/**
 * GET /api/v1/hermes/cases/:caseId/jobs
 * Lista peritajes forenses ejecutados para un caso.
 */
hermes.get('/cases/:caseId/jobs', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'cases:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const caseId = c.req.param('caseId');
  if (!caseId) {
    return c.json({ ok: false, error: 'Identificador de caso requerido' }, 400);
  }

  try {
    const jobs = await listHermesJobsForCase(ctx, caseId);
    return c.json({ ok: true, jobs });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al listar trabajos por caso en Hermes:', { error: errorMsg, caseId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});

/**
 * GET /api/v1/hermes/clients/:clientId/jobs
 * Lista peritajes forenses ejecutados para un cliente.
 */
hermes.get('/clients/:clientId/jobs', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'clients:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const clientId = c.req.param('clientId');
  if (!clientId) {
    return c.json({ ok: false, error: 'Identificador de cliente requerido' }, 400);
  }

  try {
    const jobs = await listHermesJobsForClient(ctx, clientId);
    return c.json({ ok: true, jobs });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error al listar trabajos por cliente en Hermes:', { error: errorMsg, clientId });
    return c.json({ ok: false, error: errorMsg }, 500);
  }
});
