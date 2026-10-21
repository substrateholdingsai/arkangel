import type { TenantContext } from '../tenancy/types';
import { logger } from '../lib/logger';

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

/**
 * Excepción lanzada cuando un tenant en modo 'db' no tiene identidad legal
 * configurada. Fail-closed: no se envía ningún mensaje hasta que se complete
 * la configuración del tenant.
 */
export class TenantSinIdentidadLegalError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly configMode: string
  ) {
    super(
      `Tenant ${tenantId} en modo '${configMode}' no tiene razón social configurada. Configure la identidad legal (razón social y CONDUSEF) en el panel de administración antes de operar.`
    );
    this.name = 'TenantSinIdentidadLegalError';
  }
}

/**
 * Verifica que el tenant pueda operar legalmente.
 *
 * Fail-closed: si el tenant está en modo 'db' y no tiene razón social,
 * bloquea la operación y lanza TenantSinIdentidadLegalError con mensaje
 * accionable. En modo 'platform_env' se permite (compatibilidad heredada).
 *
 * Debe llamarse ANTES de cualquier envío de mensaje (saliente o respuesta).
 */
export function assertTenantListoParaOperar(ctx: TenantContext): void {
  const config = ctx.config;
  const tenant = ctx.tenant;

  if (tenant.config_mode === 'db' && config.razonSocial.length === 0) {
    logger.error('Tenant en modo db sin identidad legal: operación bloqueada', {
      tenantId: tenant.id,
      configMode: tenant.config_mode,
      accionRequerida:
        'Complete razon_social y condusef_registro en el panel de administración y cambie config_mode a db',
    });
    throw new TenantSinIdentidadLegalError(tenant.id, tenant.config_mode);
  }
}
