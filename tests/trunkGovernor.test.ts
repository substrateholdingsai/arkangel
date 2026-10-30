import { describe, expect, it, vi } from 'vitest';
import { TrunkGovernorDO } from '../src/durable/trunk-governor';

function createMockTrunkState(): DurableObjectState {
  const store = new Map<string, any>();
  let alarmTime: number | null = null;
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, val: any) => {
        store.set(key, val);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      getAlarm: async () => alarmTime,
      setAlarm: async (time: number) => {
        alarmTime = time;
      },
      deleteAlarm: async () => {
        alarmTime = null;
      },
    },
  } as unknown as DurableObjectState;
}

describe('Sprint 5: TrunkGovernorDO — Control de Troncal y Prioridad de Voz AI', () => {
  it('respeta el límite de concurrencia saliente (2 canales por defecto)', async () => {
    const state = createMockTrunkState();
    const governor = new TrunkGovernorDO(state, {} as any);

    // Canal 1: Permitido
    const req1 = new Request(
      'http://trunk/?action=request_dial&callControlId=call_1&priority=marketing'
    );
    const res1 = await (await governor.fetch(req1)).json<any>();
    expect(res1.allowed).toBe(true);

    // Canal 2: Permitido
    const req2 = new Request(
      'http://trunk/?action=request_dial&callControlId=call_2&priority=marketing'
    );
    const res2 = await (await governor.fetch(req2)).json<any>();
    expect(res2.allowed).toBe(true);

    // Canal 3: Concurrencia agotada (debe encolarse)
    const req3 = new Request(
      'http://trunk/?action=request_dial&callControlId=call_3&priority=marketing'
    );
    const res3 = await (await governor.fetch(req3)).json<any>();
    expect(res3.allowed).toBe(false);
    expect(res3.queued).toBe(true);
  });

  it('prioridad fail-closed: cobranza tiene paso preferencial sobre marketing al liberarse un canal', async () => {
    const state = createMockTrunkState();
    const governor = new TrunkGovernorDO(state, {} as any);

    // Llenar los 2 canales
    await governor.fetch(
      new Request('http://trunk/?action=request_dial&callControlId=c1&priority=cobranza')
    );
    await governor.fetch(
      new Request('http://trunk/?action=request_dial&callControlId=c2&priority=marketing')
    );

    // Encolar llamada de Marketing primero
    await governor.fetch(
      new Request(
        'http://trunk/?action=request_dial&id=mkt_promo_1&priority=marketing&to=+529991112233'
      )
    );

    // Encolar llamada de Cobranza después
    await governor.fetch(
      new Request(
        'http://trunk/?action=request_dial&id=cob_urgente_1&priority=cobranza&to=+529994445566'
      )
    );

    // Liberar canal 1
    const releaseRes = await (
      await governor.fetch(new Request('http://trunk/?action=release_call&callControlId=c1'))
    ).json<any>();

    expect(releaseRes.ok).toBe(true);
    // El siguiente despachado DEBE ser el de cobranza, aunque marketing llegó primero
    expect(releaseRes.nextDispatched).toBeDefined();
    expect(releaseRes.nextDispatched.id).toBe('cob_urgente_1');
    expect(releaseRes.nextDispatched.priority).toBe('cobranza');
  });

  it('report_429 activa backoff y congela llamadas de marketing', async () => {
    const state = createMockTrunkState();
    const governor = new TrunkGovernorDO(state, {} as any);

    // Notificar error 429 de Telnyx
    const reportRes = await (
      await governor.fetch(new Request('http://trunk/?action=report_429'))
    ).json<any>();
    expect(reportRes.backoffActive).toBe(true);
    expect(reportRes.retryAfterMs).toBeGreaterThanOrEqual(2000);

    // Intentar llamada de marketing durante el backoff -> rechazada con 429
    const mktReq = new Request('http://trunk/?action=request_dial&priority=marketing');
    const mktRes = await governor.fetch(mktReq);
    expect(mktRes.status).toBe(429);
    const mktJson = await mktRes.json<any>();
    expect(mktJson.reason).toBe('backoff_429_active');

    // Despertar alarma tras expirar el backoff
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    await governor.alarm();
    vi.useRealTimers();

    // El status ahora muestra backoff inactivo
    const statusRes = await (
      await governor.fetch(new Request('http://trunk/?action=status'))
    ).json<any>();
    expect(statusRes.isBackoffActive).toBe(false);
  });
});
