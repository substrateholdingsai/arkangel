import { describe, expect, it } from 'vitest';
import { detectColumns, parseCsvRows, rowsToCollectionRows } from '../src/lib/csv';

describe('parseCsvRows', () => {
  it('detecta el delimitador y respeta comillas', () => {
    const rows = parseCsvRows('a,b,c\n"x,1",2,3');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x,1', '2', '3'],
    ]);
  });

  it('soporta punto y coma', () => {
    const rows = parseCsvRows('nombre;tel;monto\nJuan;5512345678;100');
    expect(rows[1]).toEqual(['Juan', '5512345678', '100']);
  });
});

describe('detectColumns', () => {
  it('detecta columnas por palabra clave', () => {
    const rows = parseCsvRows('Nombre,Telefono,Monto\nJuan,5512345678,100');
    const map = detectColumns(rows);
    expect(map.tieneEncabezado).toBe(true);
    expect(map.nombre).toBe(0);
    expect(map.telefono).toBe(1);
    expect(map.monto).toBe(2);
  });

  it('cae a posicional cuando no hay encabezado', () => {
    const rows = parseCsvRows('Juan Perez,5512345678,8450');
    const map = detectColumns(rows);
    expect(map.tieneEncabezado).toBe(false);
    expect(map.nombre).toBe(0);
    expect(map.telefono).toBe(1);
    expect(map.monto).toBe(2);
  });
});

describe('rowsToCollectionRows', () => {
  it('normaliza montos con signo de moneda', () => {
    const rows = parseCsvRows('Nombre,Tel,Monto\nJuan Perez,5512345678,"$8,450"');
    const result = rowsToCollectionRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.nombre).toBe('Juan Perez');
    expect(result[0]?.montoCents).toBe(845000);
  });

  it('convierte fechas dd/mm/aaaa', () => {
    const rows = parseCsvRows('Nombre,Tel,Monto,Vencimiento\nAna,5512345678,100,15/03/2026');
    const result = rowsToCollectionRows(rows);
    expect(result[0]?.vencimiento).toBe('2026-03-15');
  });

  it('descarta filas totalmente vacías', () => {
    const rows = parseCsvRows('Nombre,Tel,Monto\nJuan,5512345678,100\n,,');
    const result = rowsToCollectionRows(rows);
    expect(result).toHaveLength(1);
  });

  it('reensambla separadores de miles sin comillas', () => {
    const rows = parseCsvRows('Nombre,Tel,Monto\nJuan,5512345678,$8,450');
    const result = rowsToCollectionRows(rows);
    expect(result[0]?.montoCents).toBe(845000);
  });

  it('no reensambla cuando el monto ya es de tres dígitos', () => {
    const rows = parseCsvRows('Nombre,Tel,Monto,Ref\nJuan,5512345678,450,ABC');
    const result = rowsToCollectionRows(rows);
    expect(result[0]?.montoCents).toBe(45000);
  });
});
