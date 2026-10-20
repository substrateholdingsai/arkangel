import { describe, expect, it } from 'vitest';
import { extractJson, extractText } from '../src/ai/agent';
import { extractPromisedDate, heuristicClassify, sanitizeClassification } from '../src/ai/classify';

describe('extractText', () => {
  it('lee el shape de Workers AI', () => {
    expect(extractText({ response: 'hola' })).toBe('hola');
    expect(extractText({ choices: [{ message: { content: 'hola' } }] })).toBe('hola');
    expect(extractText('hola')).toBe('hola');
    expect(extractText({ nada: true })).toBeNull();
  });
});

describe('extractJson', () => {
  it('saca el JSON aunque venga con markdown', () => {
    const text = '```json\n{"intent":"paga","confidence":0.9}\n```';
    expect(extractJson(text)).toEqual({ intent: 'paga', confidence: 0.9 });
  });

  it('devuelve null si no hay JSON', () => {
    expect(extractJson('nada que ver')).toBeNull();
  });
});

describe('heuristicClassify', () => {
  it('detecta pago', () => {
    const result = heuristicClassify('Ya hice el pago por transferencia');
    expect(result.intent).toBe('paga');
  });

  it('detecta promesa con fecha', () => {
    const result = heuristicClassify('Lo pago el lunes por favor');
    expect(result.intent).toBe('promete');
  });

  it('detecta molestia y escala a humano', () => {
    const result = heuristicClassify('No me escriban por favor, es molestia');
    expect(result.intent).toBe('molesto');
    expect(result.requiereHumano).toBe(true);
  });

  it('detecta solicitud de factura', () => {
    expect(heuristicClassify('¿me pueden mandar la factura?').intent).toBe('pide_factura');
  });

  it('cae a "otro" sin señales', () => {
    expect(heuristicClassify('ok').intent).toBe('otro');
  });
});

describe('extractPromisedDate', () => {
  it('entiende ISO', () => {
    expect(extractPromisedDate('pago el 2026-11-05')).toBe('2026-11-05');
  });

  it('entiende dd/mm/aaaa', () => {
    expect(extractPromisedDate('pago el 05/11/2026')).toBe('2026-11-05');
  });
});

describe('sanitizeClassification', () => {
  it('descarta intents desconocidos', () => {
    expect(sanitizeClassification({ intent: 'inventado' })).toBeNull();
  });

  it('normaliza confianza y montos', () => {
    const result = sanitizeClassification({
      intent: 'promete',
      confidence: 5,
      montoPrometidoCents: 1234.7,
      fechaPrometida: '2026-11-05',
    });
    expect(result?.confidence).toBe(0.5);
    expect(result?.montoPrometidoCents).toBe(1235);
  });
});
