import { Hono } from 'hono';
import { rowsToCollectionRows, parseCsvRows } from '../lib/csv';
import { logger } from '../lib/logger';
import type { Env } from '../types/env';
import { ingestRows } from '../services/ingesta';
import { isIntake } from './auth';

export const ingest = new Hono<{ Bindings: Env }>();

/**
 * Entrega del CSV de las 6:00 AM (CRM → Arkangel).
 * Acepta multipart/form-data (campo `file`), text/csv crudo o application/json { csv }.
 */
ingest.post('/ingest/csv', async (c) => {
  if (!isIntake(c.req.raw, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

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

  const result = await ingestRows(c.env, rows, { source: 'csv', fileName });

  logger.info('CSV ingerido', { fileName, accepted: result.accepted, total: result.total });

  return c.json({
    ok: true,
    intake_id: result.intakeId,
    total: result.total,
    accepted: result.accepted,
    skipped: result.skipped,
    preview: result.preview,
  });
});
