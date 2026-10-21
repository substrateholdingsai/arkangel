/**
 * Percentiles de latencia para el spike de voz.
 *
 * Por qué en su propio módulo y no dentro del DO: el cálculo es puro (una
 * lista de muestras → un número) y así se puede probar sin Durable Object,
 * sin base de datos y sin reloj. El DO sólo guarda las muestras crudas; el
 * resumen p50/p95 se calcula al leerlas.
 *
 * Definición de percentil: se ordena ascendente y se toma el elemento de
 * índice `ceil(p/100 * n) - 1` (percentil más cercano, "nearest rank"). Con
 * 20 muestras, p50 es la 10.ª y p95 es la 19.ª. Es la convención que usa el
 * resto de herramientas de latencia y la que evita inventar un valor por
 * interpolación entre dos muestras que nunca ocurrieron.
 */

/** Percentil más cercano (nearest rank). `null` si no hay muestras. */
export function percentil(valores: number[], p: number): number | null {
  const limpios = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (limpios.length === 0) return null;
  if (p <= 0) return limpios[0] ?? null;
  if (p >= 100) return limpios[limpios.length - 1] ?? null;
  const rango = Math.ceil((p / 100) * limpios.length);
  const indice = Math.min(Math.max(rango - 1, 0), limpios.length - 1);
  return limpios[indice] ?? null;
}

/** Resumen de una métrica: p50, p95 y contexto para leerlo en contexto. */
export interface ResumenMetrica {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  media: number | null;
}

/** Resumen de una colección de métricas. */
export type ResumenMetricas = Record<string, ResumenMetrica>;

export function resumenMetrica(valores: number[]): ResumenMetrica {
  const limpios = valores.filter((v) => Number.isFinite(v));
  if (limpios.length === 0) {
    return { n: 0, min: null, p50: null, p95: null, max: null, media: null };
  }
  const suma = limpios.reduce((acc, v) => acc + v, 0);
  return {
    n: limpios.length,
    min: Math.min(...limpios),
    p50: percentil(limpios, 50),
    p95: percentil(limpios, 95),
    max: Math.max(...limpios),
    media: Math.round((suma / limpios.length) * 100) / 100,
  };
}

/** Resumen de varias métricas a la vez. */
export function resumenMetricas(muestras: Record<string, number[]>): ResumenMetricas {
  const salida: ResumenMetricas = {};
  for (const [clave, valores] of Object.entries(muestras)) {
    salida[clave] = resumenMetrica(valores);
  }
  return salida;
}
