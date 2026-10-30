/**
 * Jerarquía de tenants: organización (cámara, asociación, despacho) → socio.
 *
 * La usa el Motor de Comunicación para saber de quién es el canal, quién paga
 * y qué marca se firma. La resolución de canales de cobranza NO pasa por aquí:
 * sigue siendo la de `listTenantChannels` del propio tenant, sin herencia.
 */

import type { Env } from '../types/env';
import { getTenantById, listTenantChannels } from './repository';
import type { Tenant, TenantChannel } from './types';

/** Profundidad máxima de la jerarquía (plataforma → organización → socio). */
const PROFUNDIDAD_MAXIMA = 3;

export class JerarquiaInvalidaError extends Error {
  constructor(
    public readonly tenantId: string,
    motivo: string
  ) {
    super(`Jerarquía inválida para ${tenantId}: ${motivo}`);
    this.name = 'JerarquiaInvalidaError';
  }
}

/**
 * Organización dueña del canal y de la bolsa de créditos de un tenant.
 *
 * Un tenant raíz (sin padre) es su propia organización. Un socio sube hasta su
 * organización. Un ciclo, un padre inexistente o un padre suspendido son error
 * (fail-closed): nunca se cae a la organización equivocada.
 */
export async function resolverOrganizacion(env: Env, tenant: Tenant): Promise<Tenant> {
  let actual = tenant;
  const vistos = new Set<string>([tenant.id]);

  for (let nivel = 0; nivel < PROFUNDIDAD_MAXIMA; nivel++) {
    const padreId = actual.parent_tenant_id ?? null;
    if (!padreId || actual.tenant_level !== 'socio') return actual;

    if (vistos.has(padreId)) throw new JerarquiaInvalidaError(tenant.id, 'ciclo');
    vistos.add(padreId);

    const padre = await getTenantById(env, padreId);
    if (!padre) throw new JerarquiaInvalidaError(tenant.id, `padre ${padreId} no existe`);
    if (padre.status !== 'active') {
      throw new JerarquiaInvalidaError(tenant.id, `padre ${padreId} no está activo`);
    }
    actual = padre;
  }
  throw new JerarquiaInvalidaError(tenant.id, 'profundidad excedida');
}

/**
 * Canales efectivos para comunicación general: los propios del tenant y, para
 * cada canal que no tenga, los de su organización.
 */
export async function canalesEfectivos(
  env: Env,
  tenant: Tenant,
  organizacion: Tenant
): Promise<TenantChannel[]> {
  const propios = await listTenantChannels(env, tenant.id);
  if (organizacion.id === tenant.id) return propios;

  const heredados = await listTenantChannels(env, organizacion.id);
  const tiene = new Set(propios.map((c) => c.channel));
  return [...propios, ...heredados.filter((c) => !tiene.has(c.channel))];
}

/** Ids de la organización y de todos sus socios directos (alcance de una baja). */
export async function idsDeLaOrganizacion(env: Env, organizacionId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT id FROM tenants WHERE parent_tenant_id = ? AND tenant_level = 'socio'"
  )
    .bind(organizacionId)
    .all<{ id: string }>();
  return [organizacionId, ...(result.results ?? []).map((r) => r.id)];
}
