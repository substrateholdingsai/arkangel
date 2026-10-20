import { describe, expect, it } from 'vitest';
import { channelPriority, isWithinSendWindow, localHour, scoreShermanV2 } from '../src/lib/score';

describe('scoreShermanV2', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('sube con los días de retraso y el monto', () => {
    const bajo = scoreShermanV2({
      amountCents: 10_000,
      dueDate: '2026-10-20',
      now,
      ceilingCents: 200_000,
    });
    const alto = scoreShermanV2({
      amountCents: 200_000,
      dueDate: '2026-06-01',
      now,
      ceilingCents: 200_000,
    });

    expect(bajo.band).toBe('bajo');
    expect(alto.band).toBe('alto');
    expect(alto.score).toBeGreaterThan(bajo.score);
    expect(alto.diasRetraso).toBeGreaterThan(100);
  });

  it('usa la fórmula D1=0.7 R2=0.3', () => {
    const result = scoreShermanV2({
      amountCents: 100_000,
      dueDate: '2026-10-01',
      now,
      ceilingCents: 200_000,
    });
    // 19 días de retraso -> d1 = 19/60; monto 100000/200000 = 0.5
    const esperado = Number((0.7 * (19 / 60) + 0.3 * 0.5).toFixed(4));
    expect(result.score).toBe(esperado);
  });

  it('nunca es negativo con fecha futura', () => {
    const result = scoreShermanV2({
      amountCents: 1000,
      dueDate: '2027-01-01',
      now,
    });
    expect(result.diasRetraso).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('isWithinSendWindow', () => {
  it('permite 08:00–22:00 hora CDMX (NOM-184)', () => {
    // 2026-10-20 10:00 UTC = 04:00 CDMX (fuera)
    expect(isWithinSendWindow(new Date('2026-10-20T10:00:00Z'))).toBe(false);
    // 2026-10-20 16:00 UTC = 10:00 CDMX (dentro)
    expect(isWithinSendWindow(new Date('2026-10-20T16:00:00Z'))).toBe(true);
    // 2026-10-21 02:00 UTC = 20:00 CDMX (dentro)
    expect(isWithinSendWindow(new Date('2026-10-21T02:00:00Z'))).toBe(true);
    // 2026-10-21 05:00 UTC = 23:00 CDMX (fuera)
    expect(isWithinSendWindow(new Date('2026-10-21T05:00:00Z'))).toBe(false);
  });

  it('respeta la ventana configurable', () => {
    // Ventana estricta 9:00–20:00: las 08:30 quedan fuera
    expect(isWithinSendWindow(new Date('2026-10-20T14:30:00Z'), 9, 20)).toBe(false);
  });

  it('calcula la hora local', () => {
    expect(localHour(new Date('2026-10-20T16:00:00Z'), 'America/Mexico_City')).toBe(10);
  });
});

describe('channelPriority', () => {
  it('prioriza WhatsApp en riesgo alto y email en riesgo bajo', () => {
    expect(channelPriority('alto')[0]).toBe('whatsapp');
    expect(channelPriority('bajo')[0]).toBe('email');
  });
});
