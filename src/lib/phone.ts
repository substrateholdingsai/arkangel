// Normalización de teléfonos orchestration (MX por defecto).

export function digitsOnly(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\D/g, '');
}

/**
 * Normaliza a E.164. Reglas:
 *  - 10 dígitos  -> +52 (MX por defecto)
 *  - 52 + 1 + 10 -> +52 (quita el "1" de móvil de larga distancia)
 *  - 11 dígitos empezando con 1 -> +52
 *  - ya en E.164 (+52...) -> se respeta
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = digitsOnly(raw);
  if (!digits) return null;

  // Quita prefijos de salida internacional heredados.
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('521') && digits.length === 13) {
    digits = `52${digits.slice(3)}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    digits = `52${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `52${digits}`;
  } else if (digits.length === 11 && digits.startsWith('52')) {
    // 52 + 10 dígitos, ya bien.
  } else if (digits.length > 12 && digits.startsWith('52')) {
    digits = `52${digits.slice(2)}`;
  }

  if (digits.length < 10) return null;
  return `+${digits}`;
}

export function maskPhone(raw: string | null | undefined): string {
  const digits = digitsOnly(raw);
  if (digits.length < 4) return '••••';
  return `••• ••• ${digits.slice(-4)}`;
}
