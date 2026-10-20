import { Hono } from 'hono';
import type { Env } from '../types/env';

export const health = new Hono<{ Bindings: Env }>();

health.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'arkangel-cobranza',
    env: c.env.ENVIRONMENT,
    now: new Date().toISOString(),
  })
);
