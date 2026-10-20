// Scoring "Sherman v2" — D1 = días de retraso (peso 0.7), R2 = monto relativo (peso 0.3).

export type ScoreBand = 'bajo' | 'medio' | 'alto';

export interface ShermanInput {
  amountCents: number;
  dueDate: string;
  now?: Date;
  ceilingCents?: number;
}

export interface ShermanScore {
  score: number;
  band: ScoreBand;
  diasRetraso: number;
  d1: number;
  r2: number;
}

const DAY_MS = 86_400_000;
export const DEFAULT_CEILING_CENTS = 200_000; // $2,000 MXN
export const RETRASO_POR_SATURACION = 60; // días a partir de los cuales D1 = 1

export function scoreShermanV2(input: ShermanInput): ShermanScore {
  const now = input.now ?? new Date();
  const ceiling = input.ceilingCents ?? DEFAULT_CEILING_CENTS;

  const due = new Date(`${input.dueDate}T00:00:00Z`);
  const dueMs = Number.isNaN(due.getTime()) ? now.getTime() : due.getTime();

  const diasRetraso = Math.max(0, Math.floor((now.getTime() - dueMs) / DAY_MS));
  const d1 = Math.min(diasRetraso / RETRASO_POR_SATURACION, 1);
  const r2 = ceiling > 0 ? Math.min(Math.max(input.amountCents, 0) / ceiling, 1) : 0;

  const score = Number((0.7 * d1 + 0.3 * r2).toFixed(4));
  const band: ScoreBand = score >= 0.66 ? 'alto' : score >= 0.33 ? 'medio' : 'bajo';

  return { score, band, diasRetraso, d1: Number(d1.toFixed(4)), r2: Number(r2.toFixed(4)) };
}

/** Devuelve la hora local de una zona IANA (default America/Mexico_City). */
export function localHour(date: Date, timeZone = 'America/Mexico_City'): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  });
  const hour = Number.parseInt(formatter.format(date), 10);
  return Number.isNaN(hour) ? 0 : hour;
}

/**
 * Ventana legal de contacto: 08:00–20:00 hora CDMX por defecto (NOM-184-SCFI-2012,
 * numeral 5.1.2). Fuera de la ventana se difiere el envío (no se manda de madrugada).
 */
export function isWithinSendWindow(
  now: Date,
  startHour = 8,
  endHour = 22,
  timeZone = 'America/Mexico_City'
): boolean {
  const hour = localHour(now, timeZone);
  return hour >= startHour && hour < endHour;
}

/** Orden de canales por banda de riesgo (el resto lo decide el opt-in del cliente). */
export function channelPriority(band: ScoreBand): Array<'whatsapp' | 'sms' | 'email'> {
  if (band === 'alto') return ['whatsapp', 'sms', 'email'];
  if (band === 'medio') return ['whatsapp', 'email', 'sms'];
  return ['email', 'whatsapp', 'sms'];
}
