/**
 * API del módulo contable.
 *
 * `GET /api/v1/contabilidad/resumen?fecha=YYYY-MM-DD` devuelve el mismo JSON
 * que el cron dejó en R2: el contador o el analista financiero consultan los
 * asientos sin abrir Alegra.
 */

import { Hono } from 'hono';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import { diaPrevioIso } from '../contabilidad/buildPayload';
import { leerPayloadDesdeR2, leerUltimoPayload } from '../contabilidad/sendToAlegra';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';

export const contabilidad = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * El resumen contable exige `accounting:read`.
 *
 * Ojo: `accounting:read` no está en `service_readonly` (sí en `viewer`): el
 * corte contable de un cliente es información sensible de negocio y no se
 * abre al rol de sólo lectura de los servicios.
 */
contabilidad.get('/contabilidad/resumen', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'accounting:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;

  const pedida = c.req.query('fecha');

  if (pedida && !/^\d{4}-\d{2}-\d{2}$/.test(pedida)) {
    return c.json({ error: 'fecha_invalida', detalle: 'usa YYYY-MM-DD' }, 400);
  }

  // Sin fecha: se devuelve el último corte publicado (el cron publica con un
  // día de rezago, así que "ayer" todavía no existe como payload).
  if (!pedida) {
    const ultimo = await leerUltimoPayload(ctx);
    if (!ultimo) {
      return c.json(
        {
          error: 'sin_payload',
          fecha_corte: diaPrevioIso(ctx.config.tz),
          detalle: 'el cron contable todavía no publicó ningún corte',
        },
        404
      );
    }
    return c.json({ ok: true, ...ultimo.payload });
  }

  const payload = await leerPayloadDesdeR2(ctx, pedida);
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
