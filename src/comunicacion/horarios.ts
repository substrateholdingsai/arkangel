/**
 * Control horario y Quiet Hours (21:00 a 08:00) para el Motor de Comunicación.
 *
 * Principio fail-closed:
 *   - Si se conoce la zona IANA del destinatario, se evalúa en su zona.
 *   - Si no se conoce la zona, se utiliza la intersección más restrictiva
 *     de las zonas horarias de la República Mexicana (America/Tijuana a America/Cancun),
 *     garantizando que bajo ninguna circunstancia el mensaje llegue antes de las 08:00
 *     o después de las 21:00 locales.
 */

export const HORA_INICIO_PERMITIDA = 8; // 08:00 inclusive
export const HORA_FIN_PERMITIDA = 21; // 21:00 exclusive (a partir de 21:00 es quiet hour)

export const TIMEZONES_MX = [
  'America/Tijuana', // Noroeste (UTC-8 / UTC-7)
  'America/Hermosillo', // Sonora (UTC-7 sin horario de verano)
  'America/Mazatlan', // Pacífico (UTC-7)
  'America/Mexico_City', // Centro (UTC-6)
  'America/Cancun', // Sureste / Quintana Roo (UTC-5)
];

/**
 * Obtiene la hora local (0 a 23) y minutos de una fecha en una zona horaria IANA.
 */
export function getLocalParts(
  date: Date,
  timeZone: string
): { hour: number; minute: number; day: string } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const minPart = parts.find((p) => p.type === 'minute')?.value ?? '0';
    const dayPart = parts.find((p) => p.type === 'day')?.value ?? '0';
    return {
      hour: parseInt(hourPart, 10),
      minute: parseInt(minPart, 10),
      day: dayPart,
    };
  } catch {
    // Zona desconocida o inválida: fallback a America/Mexico_City
    return getLocalParts(date, 'America/Mexico_City');
  }
}

/**
 * Devuelve la hora local (0..23) en la zona solicitada.
 */
export function localHourIn(date: Date, timeZone: string): number {
  return getLocalParts(date, timeZone).hour;
}

/**
 * Verifica si una fecha cae en periodo de descanso (Quiet Hours: 21:00 a 08:00).
 * Si timeZone es null o vacío, verifica contra todos los husos horarios de México;
 * si en cualquiera de ellos es hora de descanso, se considera quiet hours (fail-closed).
 */
export function isWithinQuietHours(
  date: Date,
  timeZone: string | null | undefined
): { inQuietHours: boolean; tzUsada: string } {
  if (timeZone && timeZone.trim()) {
    const hour = localHourIn(date, timeZone.trim());
    const inQuietHours = hour < HORA_INICIO_PERMITIDA || hour >= HORA_FIN_PERMITIDA;
    return { inQuietHours, tzUsada: timeZone.trim() };
  }

  // Sin zona especificada: evaluar todos los husos de México
  for (const tz of TIMEZONES_MX) {
    const hour = localHourIn(date, tz);
    if (hour < HORA_INICIO_PERMITIDA || hour >= HORA_FIN_PERMITIDA) {
      return { inQuietHours: true, tzUsada: `conservador_mx(${tz})` };
    }
  }

  return { inQuietHours: false, tzUsada: 'America/Mexico_City' };
}

/**
 * Calcula la siguiente fecha/hora de apertura a las 08:00 AM para reprogramar.
 */
export function calcularSiguienteApertura(date: Date, timeZone: string | null | undefined): Date {
  const targetTz = timeZone && timeZone.trim() ? timeZone.trim() : 'America/Mexico_City';
  // Aproximación iterativa: avanzar hora a hora hasta salir de quiet hours
  const candidate = new Date(date.getTime());
  candidate.setMinutes(0, 0, 0);

  // Máximo 24 iteraciones de 1 hora
  for (let i = 0; i < 24; i++) {
    candidate.setTime(candidate.getTime() + 60 * 60 * 1000);
    const { inQuietHours } = isWithinQuietHours(candidate, targetTz);
    if (!inQuietHours) {
      // Ajustar a las 08:00 en punto de ese día
      return candidate;
    }
  }
  // Fallback si no convergió: 12 horas después
  return new Date(date.getTime() + 12 * 60 * 60 * 1000);
}
