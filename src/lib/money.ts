// Helpers de dinero: el worker guarda centavos (enteros) para evitar float errors.

const CLEAN = /[^0-9.,-]/g;

/**
 * Convierte un monto escrito por humanos ("$8,450", "8450.50", "1,234.56 MXN")
 * a centavos enteros. Devuelve null si no hay un número interpretable.
 */
export function parseAmountToCents(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const cleaned = raw.replace(CLEAN, '').trim();
  if (!cleaned) return null;

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;

  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador decimal es el que aparece más a la derecha.
    if (lastComma > lastDot) {
      normalized = unsigned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = unsigned.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const decimals = unsigned.length - lastComma - 1;
    normalized = decimals === 2 ? unsigned.replace(',', '.') : unsigned.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const decimals = unsigned.length - lastDot - 1;
    normalized = decimals === 2 || decimals === 1 ? unsigned : unsigned.replace(/\./g, '');
  } else {
    normalized = unsigned;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;

  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

export function formatMXN(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
  });
}

export function formatMXNShort(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  });
}

export function formatDateMX(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}
