import type { Intent } from '../types/cobranza';

export interface Classification {
  intent: Intent;
  confidence: number;
  montoPrometidoCents: number | null;
  fechaPrometida: string | null;
  requiereHumano: boolean;
  molesto: boolean;
  resumen: string;
}

const INTENTS: Intent[] = [
  'paga',
  'promete',
  'rechaza',
  'pide_factura',
  'pide_info',
  'no_responde',
  'molesto',
  'otro',
];

const KEYWORDS: Record<Intent, string[]> = {
  paga: [
    'ya pague',
    'ya pagué',
    'pagué',
    'pague',
    'acabo de pagar',
    'hice el pago',
    'ya hice el pago',
    'transferí',
    'transfieri',
    'deposité',
    'deposite',
    'ya abone',
    'abono hecho',
  ],
  promete: [
    'el lunes',
    'el martes',
    'el miercoles',
    'el miércoles',
    'el jueves',
    'el viernes',
    'la proxima semana',
    'la próxima semana',
    'prometo',
    'te prometo',
    'lo pago',
    'pago el',
    'pago en',
    'en dos dias',
    'en dos días',
    'la otra semana',
    'fin de mes',
    'en cuanto',
  ],
  rechaza: [
    'no voy a pagar',
    'no pienso pagar',
    'no reconozco',
    'no es mi deuda',
    'no me corresponde',
    'ya lo cancelé',
    'ya lo cancele',
    'no me conviene',
    'deje de usar',
    'lo cerre',
  ],
  pide_factura: [
    'factura',
    'comprobante',
    'cfdi',
    'constancia',
    'nota de credito',
    'nota de crédito',
    'recibo',
  ],
  pide_info: [
    'cuanto debo',
    'cuánto debo',
    'cuanto es',
    'cuánto es',
    'mi saldo',
    'por que me cobras',
    'por qué me cobras',
    'de que se trata',
    'cual es el monto',
    'cuál es el monto',
    'que concepto',
  ],
  molesto: [
    'no me molesten',
    'no me llames',
    'no me escriban',
    'dejen de',
    'déjenme en paz',
    'ya me dio igual',
    'me quejo',
    'baja mi numero',
    'baja mi número',
    'no autorizo',
  ],
  no_responde: [],
  otro: [],
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Clasificador heurístico de respaldo: si la IA falla o devuelve basura,
 * el agente sigue funcionando con reglas.
 */
export function heuristicClassify(inbound: string): Classification {
  const text = normalize(inbound);

  const hits = (intent: Intent): number =>
    KEYWORDS[intent].filter((keyword) => text.includes(keyword)).length;

  const molestoHits = hits('molesto');
  if (molestoHits > 0) {
    return {
      intent: 'molesto',
      confidence: 0.75,
      montoPrometidoCents: null,
      fechaPrometida: null,
      requiereHumano: true,
      molesto: true,
      resumen: 'Cliente molesto: pide que le dejen de escribir.',
    };
  }

  const pagaHits = hits('paga');
  const prometeHits = hits('promete');
  const rechazaHits = hits('rechaza');
  const facturaHits = hits('pide_factura');
  const infoHits = hits('pide_info');

  const top = Math.max(pagaHits, prometeHits, rechazaHits, facturaHits, infoHits);
  if (top === 0) {
    return {
      intent: 'otro',
      confidence: 0.3,
      montoPrometidoCents: null,
      fechaPrometida: null,
      requiereHumano: false,
      molesto: false,
      resumen: 'No se identificó una intención clara.',
    };
  }

  let intent: Intent = 'otro';
  if (pagaHits === top) intent = 'paga';
  else if (prometeHits === top) intent = 'promete';
  else if (rechazaHits === top) intent = 'rechaza';
  else if (facturaHits === top) intent = 'pide_factura';
  else if (infoHits === top) intent = 'pide_info';

  return {
    intent,
    confidence: Math.min(0.55 + top * 0.15, 0.95),
    montoPrometidoCents: extractPromisedAmount(text),
    fechaPrometida: extractPromisedDate(text),
    requiereHumano: intent === 'pide_factura',
    molesto: false,
    resumen: `Intención heurística: ${intent}.`,
  };
}

export function extractPromisedAmount(text: string): number | null {
  const matches = text.match(/(\d[\d.,]*)\s*(pesos|peso|mx|mxn|\$)?/g);
  if (!matches) return null;

  let best: number | null = null;
  for (const match of matches) {
    const numeric = match.replace(/[^0-9.,]/g, '');
    if (!numeric) continue;
    const value = Number.parseFloat(numeric.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const cents = Math.round(value * 100);
    if (best === null || cents > best) best = cents;
  }
  return best;
}

export function extractPromisedDate(text: string): string | null {
  const hoy = new Date();
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    return `${year}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  }

  const enDias = /en (\d{1,2}) d[ií]as?/.exec(text);
  if (enDias) {
    const dias = Number.parseInt(enDias[1]!, 10);
    const fecha = new Date(hoy.getTime() + dias * 86_400_000);
    return fecha.toISOString().slice(0, 10);
  }

  const proximaSemana = /(la )?pr[oó]xima semana/.test(text);
  if (proximaSemana) {
    const fecha = new Date(hoy.getTime() + 7 * 86_400_000);
    return fecha.toISOString().slice(0, 10);
  }

  return null;
}

export function sanitizeClassification(raw: unknown): Classification | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;

  const intent = INTENTS.includes(value.intent as Intent) ? (value.intent as Intent) : null;
  if (!intent) return null;

  const confidence =
    typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1
      ? value.confidence
      : 0.5;

  const monto =
    typeof value.montoPrometidoCents === 'number' && value.montoPrometidoCents > 0
      ? Math.round(value.montoPrometidoCents)
      : null;

  const fecha =
    typeof value.fechaPrometida === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.fechaPrometida)
      ? value.fechaPrometida
      : null;

  return {
    intent,
    confidence,
    montoPrometidoCents: monto,
    fechaPrometida: fecha,
    requiereHumano: value.requiereHumano === true,
    molesto: value.molesto === true || intent === 'molesto',
    resumen: typeof value.resumen === 'string' ? value.resumen.slice(0, 200) : '',
  };
}
