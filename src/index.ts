import { Hono } from 'hono';
import {
  logger,
  traceMiddleware,
  getTraceContext,
  generateTraceId,
  generateSpanId,
} from './lib/logger';
import { authenticateRequest, type AuthVars } from './auth/middleware';
import type { CobranzaQueueMessage, ContabilidadRetryMessage, Env } from './types/env';
import { api } from './routes/api';
import { agent } from './routes/agent';
import { autenticacion } from './routes/autenticacion';
import { contabilidad } from './routes/contabilidad';
import { health } from './routes/health';
import { ingest } from './routes/ingest';
import { webhooks } from './routes/webhooks';
import { consumeBatch } from './orquestacion/consumidor';
import { handleScheduled } from './cron/manana';
import { handleContabilidadDaily } from './cron/contabilidadDaily';
import { CallLockDO } from './durable/call-lock';
import { RateLimiterDO } from './durable/rate-limiter';
import { CallSessionDO } from './durable/call-session';
import { spike } from './routes/spike';

export { CallLockDO, RateLimiterDO, CallSessionDO };

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Trace middleware - adds trace context to all requests
app.use('*', traceMiddleware());

app.use('/api/*', async (c, next) => {
  await next();
  const origin = c.req.header('origin');
  // La sesión viaja en cookie: el navegador sólo acepta credenciales si el
  // origen es explícito (no `*`) y se permite el envío de credenciales.
  c.header('Access-Control-Allow-Origin', origin ?? '*');
  if (origin) c.header('Access-Control-Allow-Credentials', 'true');
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-token, x-intake-token, x-tenant-id, x-tenant-slug'
  );
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return undefined;
});

// Identidad nativa: resuelve la cookie `ark_session` una sola vez por
// petición y la deja en el contexto. No bloquea: las rutas de máquina
// (ingesta, agente) se autentican con token, no con sesión.
app.use('/api/v1/*', authenticateRequest);

app.route('/api/auth', autenticacion);
app.route('/api/v1', health);
app.route('/api/v1', ingest);
app.route('/api/v1', api);
app.route('/api/v1', agent);
app.route('/api/v1', contabilidad);
app.route('/webhooks', webhooks);

// Spike de voz (EXPERIMENTAL). Las rutas responden 404 mientras
// SPIKE_VOZ_ENABLED no sea 'true' (ver src/routes/spike.ts).
app.route('/spike', spike);

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
  const traceCtx = getTraceContext(c);
  logger.error('Error no controlado', {
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
    traceId: traceCtx.traceId,
    spanId: traceCtx.spanId,
  });
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch<unknown>, env: Env) => {
    // Extract trace context from first message or generate new
    const firstMsg = batch.messages[0]?.body as
      CobranzaQueueMessage | ContabilidadRetryMessage | undefined;
    const traceId = firstMsg?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const traceCtx = { traceId, spanId, sampled: true };

    logger.info('Queue batch received', {
      traceId,
      spanId,
      batchSize: batch.messages.length,
    });

    await consumeBatch(
      batch as MessageBatch<CobranzaQueueMessage | ContabilidadRetryMessage>,
      env,
      traceCtx
    );
  },
  scheduled: async (controller: ScheduledController, env: Env) => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const traceCtx = { traceId, spanId, sampled: true };

    logger.info('Scheduled trigger', {
      traceId,
      spanId,
      scheduledTime: controller.scheduledTime,
      cron: controller.cron,
    });

    const scheduledTime = new Date(controller.scheduledTime);
    if (scheduledTime.getUTCHours() === 5 && scheduledTime.getUTCMinutes() === 59) {
      await handleContabilidadDaily(env, undefined, traceCtx);
      return;
    }
    await handleScheduled(env, scheduledTime, traceCtx);
  },
} satisfies ExportedHandler<Env>;
