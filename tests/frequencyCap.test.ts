import { describe, expect, it } from 'vitest';
import { FrequencyCapDO, type FrequencyCapResult } from '../src/durable/frequency-cap';

function createMockState(): DurableObjectState {
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

describe('FrequencyCapDO — Control Semanal por Marca y Número', () => {
  it('permite impactos hasta el tope semanal configurado y bloquea los excedentes', async () => {
    const state = createMockState();
    const doInstance = new FrequencyCapDO(state, {} as any);

    // Primer impacto (max 2)
    const req1 = new Request('http://fcap/?action=check_and_increment&max=2');
    const res1 = (await (await doInstance.fetch(req1)).json()) as FrequencyCapResult;
    expect(res1.allowed).toBe(true);
    expect(res1.count).toBe(1);
    expect(res1.remaining).toBe(1);

    // Segundo impacto
    const req2 = new Request('http://fcap/?action=check_and_increment&max=2');
    const res2 = (await (await doInstance.fetch(req2)).json()) as FrequencyCapResult;
    expect(res2.allowed).toBe(true);
    expect(res2.count).toBe(2);
    expect(res2.remaining).toBe(0);

    // Tercer impacto: colisión (debe bloquearse fail-closed)
    const req3 = new Request('http://fcap/?action=check_and_increment&max=2');
    const res3 = (await (await doInstance.fetch(req3)).json()) as FrequencyCapResult;
    expect(res3.allowed).toBe(false);
    expect(res3.count).toBe(2);
    expect(res3.remaining).toBe(0);
  });

  it('el aislamiento por DO garantiza que marcas distintas no compartan límite para el mismo teléfono', async () => {
    // Brand A y Brand B para el mismo teléfono tienen instancias DO independientes
    const stateBrandA = createMockState();
    const doBrandA = new FrequencyCapDO(stateBrandA, {} as any);

    const stateBrandB = createMockState();
    const doBrandB = new FrequencyCapDO(stateBrandB, {} as any);

    // Brand A agota sus 2 impactos
    await doBrandA.fetch(new Request('http://fcap/?action=check_and_increment&max=2'));
    await doBrandA.fetch(new Request('http://fcap/?action=check_and_increment&max=2'));
    const resA = (await (
      await doBrandA.fetch(new Request('http://fcap/?action=status&max=2'))
    ).json()) as FrequencyCapResult;
    expect(resA.remaining).toBe(0);

    // Brand B sigue teniendo sus impactos completos disponibles
    const resB = (await (
      await doBrandB.fetch(new Request('http://fcap/?action=status&max=2'))
    ).json()) as FrequencyCapResult;
    expect(resB.count).toBe(0);
    expect(resB.remaining).toBe(2);
    expect(resB.allowed).toBe(true);
  });
});
