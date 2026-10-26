/**
 * Cliente WebService para ATEB Servicios PSC (Prestador de Servicios de Certificación).
 *
 * Conecta Arkangel con la infraestructura criptográfica de ATEB Servicios PSC,
 * acreditada por la Secretaría de Economía de México bajo la NOM-151-SCFI-2016
 * y los Artículos 89 a 114 del Código de Comercio.
 *
 * Soporta modo dual:
 * - Modo A (Cumplimiento Pleno Oficial): Estampado en tiempo real con WebService ATEB PSC.
 * - Modo B (Evidencia Interna Preparada): Motor Arkangel con cola de timbrado diferido.
 */

import { logger } from '../lib/logger';
import type { Env } from '../types/env';

export interface TenantPscSettings {
  tenantId: string;
  atebEnabled: boolean;
  atebEnvironment: 'sandbox' | 'production';
  atebClientId: string | null;
  atebApiKey: string | null;
  atebTsaEnabled: boolean;
  autoStampOutbound: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AtebStampRequest {
  digestSha256: string;
  certificateFolio: string;
  metadata?: Record<string, unknown> | null;
}

export interface AtebStampResult {
  success: boolean;
  provider: 'ateb_psc' | 'arkangel_internal';
  complianceLevel: 'modo_a_pleno' | 'modo_b_presuntivo';
  constanciaId: string | null;
  timestampToken: string | null;
  authorityName: string;
  rawResponse?: Record<string, unknown> | null;
  error?: string;
}

const ATEB_ENDPOINTS = {
  sandbox: 'https://testpsc.atebservicios.com.mx/api/v1/nom151',
  production: 'https://psc.atebservicios.com.mx/api/v1/nom151',
};

/**
 * Consulta la configuración de ATEB PSC para un tenant.
 */
export async function getTenantPscSettings(env: Env, tenantId: string): Promise<TenantPscSettings> {
  const row = await env.DB.prepare(`SELECT * FROM tenant_psc_settings WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<any>();

  if (!row) {
    return {
      tenantId,
      atebEnabled: false,
      atebEnvironment: 'sandbox',
      atebClientId: null,
      atebApiKey: null,
      atebTsaEnabled: true,
      autoStampOutbound: false,
    };
  }

  return {
    tenantId: row.tenant_id,
    atebEnabled: Boolean(row.ateb_enabled),
    atebEnvironment: (row.ateb_environment as 'sandbox' | 'production') || 'sandbox',
    atebClientId: row.ateb_client_id || null,
    atebApiKey: row.ateb_api_key || null,
    atebTsaEnabled: Boolean(row.ateb_tsa_enabled),
    autoStampOutbound: Boolean(row.auto_stamp_outbound),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Guarda o actualiza la configuración de ATEB PSC para un tenant.
 */
export async function upsertTenantPscSettings(
  env: Env,
  settings: Partial<TenantPscSettings> & { tenantId: string }
): Promise<TenantPscSettings> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tenant_psc_settings (
      tenant_id, ateb_enabled, ateb_environment, ateb_client_id,
      ateb_api_key, ateb_tsa_enabled, auto_stamp_outbound, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      ateb_enabled = excluded.ateb_enabled,
      ateb_environment = excluded.ateb_environment,
      ateb_client_id = excluded.ateb_client_id,
      ateb_api_key = excluded.ateb_api_key,
      ateb_tsa_enabled = excluded.ateb_tsa_enabled,
      auto_stamp_outbound = excluded.auto_stamp_outbound,
      updated_at = excluded.updated_at`
  )
    .bind(
      settings.tenantId,
      settings.atebEnabled ? 1 : 0,
      settings.atebEnvironment || 'sandbox',
      settings.atebClientId || null,
      settings.atebApiKey || null,
      (settings.atebTsaEnabled ?? 1) ? 1 : 0,
      settings.autoStampOutbound ? 1 : 0,
      now,
      now
    )
    .run();

  return getTenantPscSettings(env, settings.tenantId);
}

/**
 * Solicita el timbrado oficial de constancia NOM-151 ante ATEB Servicios PSC.
 * Si ATEB no está configurado, o si la llamada al WebService falla temporalmente,
 * se aplica failover automático al Modo B (Arkangel Internal) para garantizar continuidad.
 */
export async function stampDigestWithAtebPsc(
  settings: TenantPscSettings,
  request: AtebStampRequest
): Promise<AtebStampResult> {
  // Si el tenant no tiene habilitado ATEB, o no cuenta con API key, se entrega Modo B presuntivo
  if (!settings.atebEnabled || !settings.atebApiKey) {
    return {
      success: true,
      provider: 'arkangel_internal',
      complianceLevel: 'modo_b_presuntivo',
      constanciaId: null,
      timestampToken: null,
      authorityName: 'Motor Criptográfico Arkangel (Preparado para timbrado posterior ATEB)',
    };
  }

  const endpointUrl = `${ATEB_ENDPOINTS[settings.atebEnvironment]}/stamp`;

  try {
    // Si estamos en entorno de pruebas sandbox o simulación
    if (settings.atebApiKey.startsWith('test_') || settings.atebEnvironment === 'sandbox') {
      const simulatedConstanciaId = `ATEB-NOM151-SE-${Date.now().toString(36).toUpperCase()}-${request.certificateFolio.slice(-6)}`;
      const simulatedToken = Buffer.from(
        `TSA-RFC3161-ATEB-PSC|${request.digestSha256}|${new Date().toISOString()}`
      ).toString('base64');

      return {
        success: true,
        provider: 'ateb_psc',
        complianceLevel: 'modo_a_pleno',
        constanciaId: simulatedConstanciaId,
        timestampToken: simulatedToken,
        authorityName: 'ATEB Servicios PSC · Secretaría de Economía Acreditado (Sandbox)',
        rawResponse: {
          status: 'STAMPED',
          certificate_id: simulatedConstanciaId,
          tsa_rfc3161: simulatedToken,
          protocol: 'NOM-151-SCFI-2016/ASN.1-DER',
        },
      };
    }

    // Llamada HTTP real al WebService ATEB
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout max

    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.atebApiKey}`,
        'X-ATEB-Client-Id': settings.atebClientId || '',
      },
      body: JSON.stringify({
        hash_sha256: request.digestSha256,
        folio: request.certificateFolio,
        require_tsa: settings.atebTsaEnabled,
        metadata: request.metadata || {},
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      logger.warn('ATEB PSC WebService devolvió error HTTP, activando failover a Modo B', {
        status: res.status,
        errText,
      });

      return {
        success: false,
        provider: 'arkangel_internal',
        complianceLevel: 'modo_b_presuntivo',
        constanciaId: null,
        timestampToken: null,
        authorityName: 'Motor Criptográfico Arkangel (Failover preventivo)',
        error: `ATEB HTTP ${res.status}: ${errText.slice(0, 100)}`,
      };
    }

    const data: any = await res.json();
    return {
      success: true,
      provider: 'ateb_psc',
      complianceLevel: 'modo_a_pleno',
      constanciaId: data.constancia_id || data.id,
      timestampToken: data.timestamp_token || data.tst,
      authorityName: 'ATEB Servicios PSC · Secretaría de Economía Acreditado',
      rawResponse: data,
    };
  } catch (err: any) {
    logger.warn('Fallo de conexión con ATEB PSC WebService, ejecutando failover Modo B', {
      error: err?.message,
    });

    return {
      success: false,
      provider: 'arkangel_internal',
      complianceLevel: 'modo_b_presuntivo',
      constanciaId: null,
      timestampToken: null,
      authorityName: 'Motor Criptográfico Arkangel (Failover preventivo)',
      error: err?.message || 'Error de red con WebService ATEB',
    };
  }
}
