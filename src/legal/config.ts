import type { Env } from '../types/env';

export interface ConfigLegal {
  nombreLegal: string;
  condusef: string;
  dominiosPermitidos: string[];
  horaInicio: number;
  horaFin: number;
  maxContactos24h: number;
  montoToleranciaCents: number;
  horarioEnRespuestas: boolean;
}

const DOMINIO_POR_DEFECTO = 'prestamoclaro.com';

export function configLegal(env: Env): ConfigLegal {
  // Allowlist vacía = ningún link permitido (política "sin links").
  // Sólo si la variable NO está definida se usa el dominio por defecto.
  const crudo = env.ALLOWED_PAYMENT_DOMAINS;
  const dominios =
    crudo === undefined
      ? [DOMINIO_POR_DEFECTO]
      : crudo
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean);

  return {
    nombreLegal: (env.LEGAL_RAZON_SOCIAL ?? '').trim(),
    condusef: (env.LEGAL_CONDUSEF_REGISTRO ?? '').trim(),
    dominiosPermitidos: dominios,
    horaInicio: Number(env.SEND_WINDOW_START ?? 8),
    horaFin: Number(env.SEND_WINDOW_END ?? 22),
    maxContactos24h: Number(env.MAX_CONTACTS_PER_DAY ?? 3),
    montoToleranciaCents: Number(env.LEGAL_MONTO_TOLERANCIA_CENTS ?? 0),
    horarioEnRespuestas: (env.LEGAL_HORARIO_EN_RESPUESTAS ?? 'false') === 'true',
  };
}
