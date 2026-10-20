/**
 * API del módulo contable.
 *
 * `GET /api/v1/contabilidad/resumen?fecha=YYYY-MM-DD` devuelve el mismo JSON
 * que el cron dejó en R2: el contador o el analista financiero consultan los
 * asientos sin abrir Alegra.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { diaPrevioIso } from '../contabilidad/buildPayload';
import { leerPayloadDesdeR2, leerUltimoPayload } from '../contabilidad/sendToAlegra';
import { isAdmin } from './auth';

export const contabilidad = new Hono<{ Bindings: Env }>();

contabilidad.use('*', async (c, next) => {
  if (!isAdmin(c.req.raw, c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

contabilidad.get('/contabilidad/resumen', async (c) => {
  const timeZone = c.env.TZ ?? 'America/Mexico_City';
  const pedida = c.req.query('fecha');

  if (pedida && !/^\d{4}-\d{2}-\d{2}$/.test(pedida)) {
    return c.json({ error: 'fecha_invalida', detalle: 'usa YYYY-MM-DD' }, 400);
  }

  // Sin fecha: se devuelve el último corte publicado (el cron publica con un
  // día de rezago, así que "ayer" todavía no existe como payload).
  if (!pedida) {
    const ultimo = await leerUltimoPayload(c.env);
    if (!ultimo) {
      return c.json(
        {
          error: 'sin_payload',
          fecha_corte: diaPrevioIso(timeZone),
          detalle: 'el cron contable todavía no publicó ningún corte',
        },
        404
      );
    }
    return c.json({ ok: true, ...ultimo.payload });
  }

  const payload = await leerPayloadDesdeR2(c.env, pedida);
  if (!payload) {
    return c.json(
      {
        error: 'sin_payload',
        fecha_corte: pedida,
        detalle: 'el cron contable todavía no generó el corte de esa fecha',
      },
      404
    );
  }

  return c.json({ ok: true, ...payload });
});
