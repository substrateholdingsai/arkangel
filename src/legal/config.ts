import type { TenantContext } from '../tenancy/types';

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

/**
 * Configuración legal del tenant en curso.
 *
 * La identidad (razón social y registro CONDUSEF) es **por tenant**: cada
 * empresa de cobranza se presenta ante el deudor con la suya. Por eso esta
 * función recibe el contexto y no el `env`: leerla del entorno fue exactamente
 * el defecto que el multi-tenant viene a corregir (regla 1.1).
 */
export function configLegal(ctx: TenantContext): ConfigLegal {
  const config = ctx.config;
  return {
    nombreLegal: config.razonSocial,
    condusef: config.condusef,
    dominiosPermitidos: config.dominiosPermitidos,
    horaInicio: config.horaInicio,
    horaFin: config.horaFin,
    maxContactos24h: config.maxContactos24h,
    montoToleranciaCents: config.montoToleranciaCents,
    horarioEnRespuestas: config.horarioEnRespuestas,
  };
}
