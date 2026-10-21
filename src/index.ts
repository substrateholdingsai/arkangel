import { Hono } from 'hono';
import { logger } from './lib/logger';
import type { CobranzaQueueMessage, ContabilidadRetryMessage, Env } from './types/env';
import { api } from './routes/api';
import { agent } from './routes/agent';
import { contabilidad } from './routes/contabilidad';
import { health } from './routes/health';
import { ingest } from './routes/ingest';
import { webhooks } from './routes/webhooks';
import { consumeBatch } from './orquestacion/consumidor';
import { handleScheduled } from './cron/manana';
import { handleContabilidadDaily } from './cron/contabilidadDaily';
import { CallLockDO } from './durable/call-lock';

export { CallLockDO };

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Access-Control-Allow-Origin', c.req.header('origin') ?? '*');
  // `Authorization` es lo que lleva la SPA (JWT de sesión de Clerk o token de
  // máquina). `x-tenant-id` / `x-tenant-slug` sólo acotan el tenant: sin ellos
  // el preflight del navegador bloquearía la petición.
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-token, x-intake-token, x-tenant-id, x-tenant-slug'
  );
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return undefined;
});

app.route('/api/v1', health);
app.route('/api/v1', ingest);
app.route('/api/v1', api);
app.route('/api/v1', agent);
app.route('/api/v1', contabilidad);
app.route('/webhooks', webhooks);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

/** SPA: sirve el dashboard compilado y cae a index.html en rutas de cliente. */
app.all('*', async (c) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'method_not_allowed' }, 405);
  }

  const url = new URL(c.req.url);
  const assetUrl = new URL(url.pathname === '/' ? '/index.html' : url.pathname, url.origin);

  let response = await c.env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));

  if (response.status === 404) {
    response = await c.env.ASSETS.fetch(
      new Request(new URL('/index.html', url.origin), { method: 'GET' })
    );
  }

  return response;
});

app.onError((error, c) => {
  logger.error('Error no controlado', {
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
  });
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<unknown>, env: Env) =>
    consumeBatch(batch as MessageBatch<CobranzaQueueMessage | ContabilidadRetryMessage>, env),
  scheduled: async (controller: ScheduledController, env: Env) => {
    const scheduledTime = new Date(controller.scheduledTime);
    // 05:59 UTC = 23:59 CDMX → cierre contable; cualquier otro disparo → cobranza.
    if (scheduledTime.getUTCHours() === 5 && scheduledTime.getUTCMinutes() === 59) {
      await handleContabilidadDaily(env);
      return;
    }
    await handleScheduled(env, scheduledTime);
  },
} satisfies ExportedHandler<Env>;
