import type { Env } from '../types/env';

export interface FrequencyCapState {
  impacts: number[]; // Epoch timestamps en milisegundos de los impactos
}

export interface FrequencyCapResult {
  allowed: boolean;
  count: number;
  remaining: number;
  maxWeekly: number;
}

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * FrequencyCapDO: Gestiona el límite semanal de impactos comerciales
 * para una combinación específica de Marca + Teléfono (ej. `fcap:brand_123:+529991234567`).
 *
 * Emplea el patrón estándar de Arkangel (clase con fetch y constructor ctx/env,
 * sin heredar de DurableObject para permitir pruebas en vitest sin runtime de Workerd).
 */
export class FrequencyCapDO {
  private impacts: number[] = [];

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'check_and_increment';
    const maxWeekly = Math.max(1, parseInt(url.searchParams.get('max') ?? '2', 10));

    await this.loadState();
    this.purgeOld(Date.now());

    if (action === 'status') {
      const remaining = Math.max(0, maxWeekly - this.impacts.length);
      const res: FrequencyCapResult = {
        allowed: this.impacts.length < maxWeekly,
        count: this.impacts.length,
        remaining,
        maxWeekly,
      };
      return new Response(JSON.stringify(res), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action === 'check_and_increment') {
      const now = Date.now();
      if (this.impacts.length >= maxWeekly) {
        const res: FrequencyCapResult = {
          allowed: false,
          count: this.impacts.length,
          remaining: 0,
          maxWeekly,
        };
        return new Response(JSON.stringify(res), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      this.impacts.push(now);
      await this.saveState();

      // Programar alarma para purga si no hay una programada
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(now + SIETE_DIAS_MS);
      }

      const res: FrequencyCapResult = {
        allowed: true,
        count: this.impacts.length,
        remaining: maxWeekly - this.impacts.length,
        maxWeekly,
      };
      return new Response(JSON.stringify(res), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action === 'reset') {
      this.impacts = [];
      await this.ctx.storage.delete('impacts');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'invalid_action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async alarm(): Promise<void> {
    await this.loadState();
    const now = Date.now();
    this.purgeOld(now);
    await this.saveState();

    if (this.impacts.length > 0) {
      // Próxima alarma cuando expire el impacto más antiguo restante
      const oldest = Math.min(...this.impacts);
      await this.ctx.storage.setAlarm(oldest + SIETE_DIAS_MS);
    }
  }

  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<number[]>('impacts');
    this.impacts = stored ?? [];
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('impacts', this.impacts);
  }

  private purgeOld(now: number): void {
    const cutoff = now - SIETE_DIAS_MS;
    this.impacts = this.impacts.filter((ts) => ts > cutoff);
  }
}
