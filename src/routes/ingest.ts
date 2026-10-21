import { Hono } from 'hono';
import { rowsToCollectionRows, parseCsvRows } from '../lib/csv';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import { ingestRows } from '../services/ingesta';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';

export const ingest = new Hono<{ Bindings: Env }>();

/**
 * Entrega del CSV de las 6:00 AM (CRM → Arkangel).
 * Acepta multipart/form-data (campo `file`), text/csv crudo o application/json { csv }.
 *
 * Exige el scope `ingest:write`, que tienen el token de ingesta
 * (`INTAKE_TOKEN`, rol `service_ingest`) y el de administración. La
 * autenticación por token no cambia: el token sigue siendo la credencial.
 */
ingest.post('/ingest/csv', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'ingest:write');
  if (!guardia.ok) return guardia.response;

  const contentType = c.req.header('content-type') ?? '';
  let csvText = '';
  let fileName: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (file instanceof File) {
      fileName = file.name;
      csvText = await file.text();
    } else {
      const fallback = form.get('csv');
      csvText = typeof fallback === 'string' ? fallback : '';
    }
  } else if (contentType.includes('application/json')) {
    const body = (await c.req.json()) as { csv?: string; fileName?: string };
    csvText = body.csv ?? '';
    fileName = body.fileName ?? null;
  } else {
    csvText = await c.req.text();
  }

  if (!csvText.trim()) {
    return c.json({ error: 'csv_vacio' }, 400);
  }

  const rows = rowsToCollectionRows(parseCsvRows(csvText));
  if (rows.length === 0) {
    return c.json({ error: 'csv_sin_filas_utiles' }, 400);
  }

  // El CSV se ingiere para el tenant que dice la cabecera. Sin cabecera, el
  // tenant por defecto de la plataforma (el que operaba antes del multi-tenant).
  // El principal ya viene resuelto por la guardia: no se vuelve a autenticar.
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const result = await ingestRows(ctx, rows, {
    source: 'csv',
    fileName,
    tz: ctx.config.tz,
    scoreCeilingCents: ctx.config.scoreAmountCeilingCents,
  });

  logger.info('CSV ingerido', {
    tenantId: ctx.tenantId,
    fileName,
    accepted: result.accepted,
    total: result.total,
  });

  return c.json({
    ok: true,
    intake_id: result.intakeId,
    total: result.total,
    accepted: result.accepted,
    skipped: result.skipped,
    preview: result.preview,
  });
});
