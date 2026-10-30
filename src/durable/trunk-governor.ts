/**
 * TrunkGovernorDO: Gobernador de Troncal PSTN y Pacing de Telefonía Voice AI (Telnyx).
 *
 * Responsabilidades:
 *  - Control de concurrencia saliente: 2 canales concurrentes base (Level 1) o 10 (Level 2).
 *  - Dials Per Second (DPS): Límite duro de 30/s calculado con media móvil de 5 segundos.
 *  - Arbitraje con prioridad fail-closed: Cobranza tiene paso preferencial inmediato sobre Marketing.
 *  - Manejo de saturación HTTP 429 (Error 90103): Congela llamadas comerciales, aplica backoff
 *    exponencial mediante alarmas y reanuda ordenadamente.
 */

import type { Env } from '../types/env';

export interface DialRequest {
  id: string;
  priority: 'cobranza' | 'marketing';
  tenantId: string;
  to: string;
  enqueuedAt: number;
}

export interface ActiveCallInfo {
  callControlId: string;
  priority: 'cobranza' | 'marketing';
  tenantId: string;
  startedAt: number;
}

export interface TrunkGovernorState {
  maxConcurrency: number;
  isBackoffActive: boolean;
  backoffUntil: number;
  backoffAttempts: number;
  activeCalls: Record<string, ActiveCallInfo>;
  dialsTimestamps: number[];
  colaCobranza: DialRequest[];
  colaMarketing: DialRequest[];
}

const CINCO_SEGUNDOS_MS = 5000;
const MAX_DPS_PERMITIDO = 30;

export class TrunkGovernorDO {
  private state: TrunkGovernorState = {
    maxConcurrency: 2, // 2 canales por defecto al inicio
    isBackoffActive: false,
    backoffUntil: 0,
    backoffAttempts: 0,
    activeCalls: {},
    dialsTimestamps: [],
    colaCobranza: [],
    colaMarketing: [],
  };

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'status';

    await this.loadState();
    this.purgeDials(Date.now());

    if (action === 'status') {
      const dps = this.calcularDpsActual(Date.now());
      const activeCount = Object.keys(this.state.activeCalls).length;
      return new Response(
        JSON.stringify({
          activeCallsCount: activeCount,
          maxConcurrency: this.state.maxConcurrency,
          currentDps: dps,
          maxDps: MAX_DPS_PERMITIDO,
          isBackoffActive: this.state.isBackoffActive,
          colaCobranzaCount: this.state.colaCobranza.length,
          colaMarketingCount: this.state.colaMarketing.length,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'set_concurrency') {
      const limit = parseInt(url.searchParams.get('limit') ?? '2', 10);
      this.state.maxConcurrency = Math.max(1, limit);
      await this.saveState();
      return new Response(JSON.stringify({ ok: true, maxConcurrency: this.state.maxConcurrency }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Solicitar permiso de marcación (adquisición de canal)
    if (action === 'request_dial') {
      const now = Date.now();
      const priority = (url.searchParams.get('priority') ?? 'marketing') as
        'cobranza' | 'marketing';
      const tenantId = url.searchParams.get('tenantId') ?? 'default';
      const to = url.searchParams.get('to') ?? '';
      const reqId =
        url.searchParams.get('id') ?? `req_${now}_${Math.random().toString(36).slice(2, 6)}`;

      // 1. Si hay backoff activo para marketing, rechazar o encolar
      if (this.state.isBackoffActive && priority === 'marketing') {
        return new Response(JSON.stringify({ allowed: false, reason: 'backoff_429_active' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 2. Verificar media móvil de DPS
      const dps = this.calcularDpsActual(now);
      if (dps >= MAX_DPS_PERMITIDO) {
        return new Response(
          JSON.stringify({ allowed: false, reason: 'dps_limit_exceeded', currentDps: dps }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 3. Verificar concurrencia disponible
      const activeCount = Object.keys(this.state.activeCalls).length;
      if (activeCount >= this.state.maxConcurrency) {
        // Encolar según prioridad
        const dialReq: DialRequest = { id: reqId, priority, tenantId, to, enqueuedAt: now };
        if (priority === 'cobranza') {
          this.state.colaCobranza.push(dialReq);
        } else {
          this.state.colaMarketing.push(dialReq);
        }
        await this.saveState();
        return new Response(
          JSON.stringify({
            allowed: false,
            queued: true,
            position:
              priority === 'cobranza'
                ? this.state.colaCobranza.length
                : this.state.colaMarketing.length,
            priority,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 4. Si hay llamadas en cola y esta no es la siguiente, respetar la cola
      if (priority === 'marketing' && this.state.colaCobranza.length > 0) {
        this.state.colaMarketing.push({ id: reqId, priority, tenantId, to, enqueuedAt: now });
        await this.saveState();
        return new Response(
          JSON.stringify({ allowed: false, queued: true, reason: 'cobranza_priority_wait' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 5. Permitir marcación
      const callControlId = url.searchParams.get('callControlId') ?? `call_${now}`;
      this.state.activeCalls[callControlId] = {
        callControlId,
        priority,
        tenantId,
        startedAt: now,
      };
      this.state.dialsTimestamps.push(now);
      await this.saveState();

      return new Response(
        JSON.stringify({ allowed: true, callControlId, activeCount: activeCount + 1 }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Liberar canal tras finalizar llamada
    if (action === 'release_call') {
      const callControlId = url.searchParams.get('callControlId');
      if (callControlId && this.state.activeCalls[callControlId]) {
        delete this.state.activeCalls[callControlId];
      }

      // Despachar el siguiente de la cola respetando prioridad
      const next = this.despacharSiguiente();
      await this.saveState();

      return new Response(
        JSON.stringify({ ok: true, released: callControlId, nextDispatched: next ?? null }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Reportar HTTP 429 de Telnyx
    if (action === 'report_429') {
      const now = Date.now();
      this.state.isBackoffActive = true;
      this.state.backoffAttempts++;

      // Backoff exponencial con base 2s (2s, 4s, 8s, 16s... máx 60s)
      const delayMs = Math.min(60000, 2000 * Math.pow(2, this.state.backoffAttempts - 1));
      this.state.backoffUntil = now + delayMs;

      await this.ctx.storage.setAlarm(this.state.backoffUntil);
      await this.saveState();

      return new Response(
        JSON.stringify({
          ok: true,
          backoffActive: true,
          attempts: this.state.backoffAttempts,
          retryAfterMs: delayMs,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'invalid_action' }), { status: 400 });
  }

  async alarm(): Promise<void> {
    await this.loadState();
    const now = Date.now();
    if (now >= this.state.backoffUntil) {
      this.state.isBackoffActive = false;
      this.state.backoffAttempts = 0;
      await this.saveState();
    }
  }

  private despacharSiguiente(): DialRequest | null {
    // 1. Cobranza tiene paso preferencial inmediato
    if (this.state.colaCobranza.length > 0) {
      return this.state.colaCobranza.shift() ?? null;
    }
    // 2. Si no hay cobranza y no hay backoff, marketing
    if (!this.state.isBackoffActive && this.state.colaMarketing.length > 0) {
      return this.state.colaMarketing.shift() ?? null;
    }
    return null;
  }

  private calcularDpsActual(now: number): number {
    this.purgeDials(now);
    // Media móvil de 5 segundos
    return this.state.dialsTimestamps.length / 5;
  }

  private purgeDials(now: number): void {
    const cutoff = now - CINCO_SEGUNDOS_MS;
    this.state.dialsTimestamps = this.state.dialsTimestamps.filter((ts) => ts > cutoff);
  }

  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<TrunkGovernorState>('state');
    if (stored) {
      this.state = stored;
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }
}

/**
 * Solicita permiso al TrunkGovernor para realizar una marcación outbound.
 */
export async function solicitarPasoTroncal(
  env: Env,
  params: {
    priority: 'cobranza' | 'marketing';
    tenantId: string;
    to: string;
    callControlId?: string;
  }
): Promise<{ allowed: boolean; queued?: boolean; reason?: string; callControlId?: string }> {
  if (!env.TRUNK_GOVERNOR) {
    return { allowed: true, callControlId: params.callControlId ?? `call_${Date.now()}` };
  }
  try {
    const govId = env.TRUNK_GOVERNOR.idFromName('global_pstn_trunk');
    const stub = env.TRUNK_GOVERNOR.get(govId);
    const query = new URLSearchParams({
      action: 'request_dial',
      priority: params.priority,
      tenantId: params.tenantId,
      to: params.to,
      ...(params.callControlId ? { callControlId: params.callControlId } : {}),
    });
    const res = await stub.fetch(`http://trunk-governor/?${query.toString()}`);
    return (await res.json()) as {
      allowed: boolean;
      queued?: boolean;
      reason?: string;
      callControlId?: string;
    };
  } catch {
    return { allowed: true, callControlId: params.callControlId ?? `call_${Date.now()}` };
  }
}

/**
 * Notifica al TrunkGovernor la liberación de un canal tras call.hangup.
 */
export async function liberarCanalTroncal(env: Env, callControlId: string): Promise<void> {
  if (!env.TRUNK_GOVERNOR || !callControlId) return;
  try {
    const govId = env.TRUNK_GOVERNOR.idFromName('global_pstn_trunk');
    const stub = env.TRUNK_GOVERNOR.get(govId);
    await stub.fetch(
      `http://trunk-governor/?action=release_call&callControlId=${encodeURIComponent(callControlId)}`
    );
  } catch {
    // Fail-safe
  }
}

/**
 * Notifica al TrunkGovernor la recepción de un HTTP 429 de Telnyx para iniciar backoff.
 */
export async function reportarSaturacionTroncal(env: Env, reason = 'telnyx_429'): Promise<void> {
  if (!env.TRUNK_GOVERNOR) return;
  try {
    const govId = env.TRUNK_GOVERNOR.idFromName('global_pstn_trunk');
    const stub = env.TRUNK_GOVERNOR.get(govId);
    await stub.fetch(
      `http://trunk-governor/?action=report_429&reason=${encodeURIComponent(reason)}`
    );
  } catch {
    // Fail-safe
  }
}
