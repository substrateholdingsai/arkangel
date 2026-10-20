import { describe, expect, it } from 'vitest';
import { formatMXN, parseAmountToCents } from '../src/lib/money';
import { maskPhone, normalizePhone } from '../src/lib/phone';

describe('parseAmountToCents', () => {
  it('parsea formatos con moneda', () => {
    expect(parseAmountToCents('$8,450')).toBe(845000);
    expect(parseAmountToCents('8450.50')).toBe(845050);
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents('1.234,56')).toBe(123456);
    expect(parseAmountToCents('1234')).toBe(123400);
  });

  it('devuelve null cuando no hay número', () => {
    expect(parseAmountToCents('N/A')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents(null)).toBeNull();
  });
});

describe('formatMXN', () => {
  it('formatea centavos como pesos', () => {
    expect(formatMXN(845000)).toContain('8,450');
  });
});

describe('normalizePhone', () => {
  it('normaliza celulares mexicanos', () => {
    expect(normalizePhone('5512345678')).toBe('+525512345678');
    expect(normalizePhone('+52 1 55 1234 5678')).toBe('+525512345678');
    expect(normalizePhone('+525512345678')).toBe('+525512345678');
  });

  it('rechaza basura', () => {
    expect(normalizePhone('n/a')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('maskPhone', () => {
  it('enmascara el número', () => {
    expect(maskPhone('+525512345678')).toBe('••• ••• 5678');
  });
});
