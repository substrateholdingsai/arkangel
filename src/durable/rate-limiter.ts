import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

export interface RateLimiterState {
  count: number;
  windowStart: number;
}

export class RateLimiterDO extends DurableObject<Env, RateLimiterState> {
  private state: RateLimiterState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = { count: 0, windowStart: Date.now() };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'acquire';
    const rpm = Number(url.searchParams.get('rpm') ?? '42');
    const windowMs = 60000;

    if (action === 'acquire') {
      return this.acquire(rpm, windowMs);
    }
    if (action === 'reset') {
      return this.reset();
    }
    if (action === 'status') {
      return this.status(rpm, windowMs);
    }
    return new Response('Invalid action', { status: 400 });
  }

  private async acquire(rpm: number, windowMs: number): Promise<Response> {
    const now = Date.now();
    const storage = this.ctx.storage;

    // Load persisted state
    const stored = await storage.get<RateLimiterState>('state');
    if (stored) {
      this.state = stored;
    }

    // Check if we're in a new window
    if (now - this.state.windowStart >= windowMs) {
      this.state = { count: 0, windowStart: now };
    }

    if (this.state.count >= rpm) {
      const retryAfter = Math.ceil((this.state.windowStart + windowMs - now) / 1000);
      return new Response(JSON.stringify({ allowed: false, retryAfter }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      });
    }

    this.state.count++;
    await storage.put('state', this.state);

    return new Response(JSON.stringify({ allowed: true, remaining: rpm - this.state.count }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async reset(): Promise<Response> {
    this.state = { count: 0, windowStart: Date.now() };
    await this.ctx.storage.put('state', this.state);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async status(rpm: number, windowMs: number): Promise<Response> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<RateLimiterState>('state');
    if (stored) this.state = stored;

    if (now - this.state.windowStart >= windowMs) {
      return new Response(JSON.stringify({ count: 0, remaining: rpm, windowStart: now }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      count: this.state.count,
      remaining: rpm - this.state.count,
      windowStart: this.state.windowStart,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}