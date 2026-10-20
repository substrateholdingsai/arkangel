// Durable Object: serializa el envío por cliente (un cliente, una llamada a la vez).
import type { Env } from '../types/env';

interface LockState {
  lockedUntil: number;
  reason?: string;
}

const DEFAULT_TTL_MS = 60_000;

export class CallLockDO {
  private state: LockState = { lockedUntil: 0 };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'acquire';
    const ttl = Number(url.searchParams.get('ttl') ?? DEFAULT_TTL_MS);

    if (action === 'release') {
      this.state = { lockedUntil: 0 };
      return Response.json({ ok: true, released: true });
    }

    const now = Date.now();
    if (this.state.lockedUntil > now) {
      return Response.json(
        { ok: false, locked: true, retryAfterMs: this.state.lockedUntil - now },
        { status: 409 }
      );
    }

    this.state = { lockedUntil: now + ttl, reason: url.searchParams.get('reason') ?? 'send' };
    return Response.json({ ok: true, locked: true, until: this.state.lockedUntil });
  }
}

export async function acquireClientLock(
  env: Env,
  clientId: string,
  ttlMs = DEFAULT_TTL_MS
): Promise<boolean> {
  const id = env.CALL_LOCK.idFromName(clientId);
  const stub = env.CALL_LOCK.get(id);
  const response = await stub.fetch(
    `https://call-lock/?action=acquire&ttl=${ttlMs}&reason=cobranza`
  );
  return response.ok;
}

export async function releaseClientLock(env: Env, clientId: string): Promise<void> {
  const id = env.CALL_LOCK.idFromName(clientId);
  const stub = env.CALL_LOCK.get(id);
  await stub.fetch('https://call-lock/?action=release');
}
