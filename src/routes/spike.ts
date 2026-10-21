/**
 * Rutas del spike de voz.
 *
 * **No es producción.** Todo lo que hay aquí detrás de `SPIKE_VOZ_ENABLED`:
 * si el flag no está en `true`, las rutas responden 404 y no existe ninguna
 * puerta abierta hacia la voz. El flag vive en `wrangler.jsonc` (`false` por
 * defecto) y se enciende sólo para el spike, en staging o en local.
 *
 * Qué hace cada ruta:
 *
 * · `POST /spike/call` → crea la llamada: abre la reunión en Cloudflare
 *   Realtime (el producto que hoy sustituye a Cloudflare Calls), da de alta al
 *   participante y devuelve su `authToken` para el SDK del navegador. También
 *   inicializa el `CallSessionDO`.
 * · `GET /spike/call/:id/audio` → el canal de signaling: WebSocket con el DO.
 *   Por ahí entra el audio del navegador y sale el del bot.
 * · `GET /spike/call/:id/estado` → el estado de la llamada y sus métricas.
 * · `POST /spike/call/:id/metricas` → el navegador reporta las métricas que
 *   sólo él puede ver (por ejemplo, la latencia acústica del barge-in).
 *
 * Todo lleva `traceId`: el mismo que se ve en los logs del Worker.
 */

import { Hono } from 'hono';
import { resolverPrincipalDetallado } from '../auth/guards';
import type { AuthVars } from '../auth/middleware';
import { getTraceContext } from '../lib/logger';
import type { Env } from '../types/env';

/** Respuesta de la API de Realtime (éxito). */
interface RespuestaRealtime<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

interface ParticipanteRealtime {
  authToken?: string;
  id?: string;
}

interface LlamadaCreada {
  callId: string;
  tenantId: string;
  meetingId: string;
  authToken: string;
  traceId: string;
  /** URL del WebSocket de signaling (el navegador lo abre). */
  audioUrl: string;
}

/** ¿Está el spike encendido? */
export function spikeVozHabilitado(env: Env): boolean {
  return env.SPIKE_VOZ_ENABLED === 'true';
}

export const spike = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * Middleware del spike: si el flag no está en `true`, la ruta no existe.
 *
 * Se responde 404 (y no 403) a propósito: desde fuera no debe verse que hay
 * un spike detrás.
 *
 * Y además exige credencial: el spike abre llamadas y micros, así que sin
 * identidad (token de administración o sesión) no se opera. Fail-closed.
 */
spike.use('*', async (c, next) => {
  if (!spikeVozHabilitado(c.env)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const resuelto = await resolverPrincipalDetallado(c.env, c.req.raw, c.get('sesionNativa'));
  if (!resuelto.principal) {
    return c.json({ error: resuelto.motivo ?? 'unauthorized' }, resuelto.status ?? 401);
  }
  await next();
});

/** Comprueba que el tenant existe (fail-closed: sin tenant, no hay llamada). */
async function tenantExiste(env: Env, tenantId: string): Promise<boolean> {
  try {
    const fila = await env.DB.prepare('SELECT id FROM tenants WHERE id = ? LIMIT 1')
      .bind(tenantId)
      .first<{ id: string }>();
    return Boolean(fila?.id);
  } catch (error) {
    // Si la tabla no existe (migración 0004 sin aplicar), no hay tenant y la
    // llamada no se crea: el spike no opera sin un tenant real.
    const mensaje = error instanceof Error ? error.message : String(error);
    if (mensaje.includes('no such table: tenants')) return false;
    throw error;
  }
}

/** Crea la reunión y el participante en Cloudflare Realtime. */
async function creaReunion(
  env: Env,
  titulo: string
): Promise<{ meetingId: string; authToken: string } | { error: string }> {
  const token = env.CF_REALTIME_API_TOKEN;
  const appId = env.CF_REALTIME_APP_ID;
  const accountId = env.CF_REALTIME_ACCOUNT_ID;
  const preset = env.CF_REALTIME_PRESET_NAME;
  if (!token || !appId || !accountId || !preset) {
    return {
      error:
        'Faltan credenciales de Cloudflare Realtime: CF_REALTIME_API_TOKEN, ' +
        'CF_REALTIME_APP_ID, CF_REALTIME_ACCOUNT_ID y CF_REALTIME_PRESET_NAME.',
    };
  }

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/apps/${appId}`;

  const respuestaReunion = await fetch(`${base}/meetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: titulo }),
  });
  const cuerpoReunion = (await respuestaReunion.json().catch(() => null)) as RespuestaRealtime<{
    id?: string;
  }> | null;
  const meetingId = cuerpoReunion?.result?.id;
  if (!respuestaReunion.ok || !meetingId) {
    return {
      error:
        cuerpoReunion?.errors?.[0]?.message ??
        `Realtime rechazó la creación de la reunión (HTTP ${respuestaReunion.status})`,
    };
  }

  const respuestaParticipante = await fetch(`${base}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: titulo, preset_name: preset }),
  });
  const cuerpoParticipante = (await respuestaParticipante
    .json()
    .catch(() => null)) as RespuestaRealtime<ParticipanteRealtime> | null;
  const authToken = cuerpoParticipante?.result?.authToken;
  if (!respuestaParticipante.ok || !authToken) {
    return {
      error:
        cuerpoParticipante?.errors?.[0]?.message ??
        `Realtime rechazó al participante (HTTP ${respuestaParticipante.status})`,
    };
  }

  return { meetingId, authToken };
}

/** Crea (o recupera) el stub del DO de la llamada. */
function stubDeLlamada(env: Env, callId: string) {
  const id = env.CALL_SESSION.idFromName(callId);
  return env.CALL_SESSION.get(id);
}

/** Crea la llamada. */
spike.post('/call', async (c) => {
  const traceCtx = getTraceContext(c);
  const cuerpo = (await c.req.raw.json().catch(() => null)) as {
    tenantId?: string;
    clientName?: string;
    amountCents?: number;
  } | null;

  const tenantId = cuerpo?.tenantId;
  if (!tenantId) {
    return c.json({ error: 'tenantId es obligatorio' }, 400);
  }
  if (!(await tenantExiste(c.env, tenantId))) {
    return c.json({ error: 'tenant_desconocido' }, 404);
  }

  const llamada = await creaReunion(c.env, `spike-voz ${cuerpo?.clientName ?? 'cliente'}`);
  if ('error' in llamada) {
    // Fail-closed: sin credenciales del proveedor no se simula una llamada.
    return c.json({ error: 'proveedor_no_configurado', detalle: llamada.error }, 503);
  }

  const callId = `spk_${crypto.randomUUID()}`;
  const stub = stubDeLlamada(c.env, callId);
  await stub.fetch('https://call-session/iniciar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, tenantId, traceId: traceCtx.traceId }),
  });

  const respuesta: LlamadaCreada = {
    callId,
    tenantId,
    meetingId: llamada.meetingId,
    authToken: llamada.authToken,
    traceId: traceCtx.traceId,
    audioUrl: `/spike/call/${callId}/audio`,
  };
  return c.json(respuesta, 201);
});

/** Estado de la llamada + métricas. */
spike.get('/call/:id/estado', async (c) => {
  const callId = c.req.param('id');
  const stub = stubDeLlamada(c.env, callId);
  return stub.fetch('https://call-session/estado');
});

/** Canal de signaling (WebSocket). */
spike.get('/call/:id/audio', async (c) => {
  const callId = c.req.param('id');
  const stub = stubDeLlamada(c.env, callId);
  return stub.fetch(c.req.raw);
});

/** El navegador reporta las métricas que sólo él puede medir. */
spike.post('/call/:id/metricas', async (c) => {
  const callId = c.req.param('id');
  const cuerpo = (await c.req.raw.json().catch(() => null)) as {
    bargeInLatencyMs?: number;
    roundTripMs?: number;
    sttPartialMs?: number;
  } | null;
  if (!cuerpo) {
    return c.json({ error: 'cuerpo_invalido' }, 400);
  }
  const stub = stubDeLlamada(c.env, callId);
  if (typeof cuerpo.bargeInLatencyMs === 'number') {
    await stub.fetch('https://call-session/cortar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bargeInLatencyMs: cuerpo.bargeInLatencyMs }),
    });
  }
  return stub.fetch('https://call-session/turno', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metricas: {
        barge_in_latency_ms: cuerpo.bargeInLatencyMs,
        round_trip_ms: cuerpo.roundTripMs,
        stt_partial_ms: cuerpo.sttPartialMs,
      },
    }),
  });
});
