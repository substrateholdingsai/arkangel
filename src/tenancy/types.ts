/**
 * Tipos del modelo multi-tenant.
 *
 * Un tenant es una empresa de cobranza: tiene su propia razón social, su
 * registro ante CONDUSEF, sus dominios de pago, su ventana de contacto y sus
 * credenciales de canal. El worker es la plataforma; el tenant es el cliente.
 */

import type { ChannelName, ChannelOverride } from '../channels/types';
import type { Principal } from '../auth/principal';
import type { Env } from '../types/env';

export type TenantStatus = 'active' | 'suspended' | 'onboarding';

/**
 * De dónde sale la configuración operativa y legal del tenant.
 *
 * · `db`         → la fila de `tenants` es la fuente de verdad (modo normal).
 * · `platform_env` → la configuración se lee del entorno del Worker. Es el
 *   puente de transición para el tenant que ya existía antes del multi-tenant:
 *   garantiza que el comportamiento no cambie ni un byte al migrar.
 *
 * Los tenants nuevos nacen SIEMPRE en `db`: un tenant en `db` nunca hereda la
 * identidad legal de la plataforma (eso sería el bug que motivator todo esto).
 */
export type TenantConfigMode = 'db' | 'platform_env';

/** Fila de `tenants`. */
export interface Tenant {
  id: string;
  slug: string;
  nombre: string;
  status: TenantStatus;
  config_mode: TenantConfigMode;
  /** Razón social: es lo que se imprime al pie del mensaje (regla 1.1). */
  razon_social: string;
  condusef_registro: string;
  /** Lista separada por comas. Vacío = ningún link permitido (fail-closed). */
  allowed_payment_domains: string;
  tz: string;
  send_window_start: number;
  send_window_end: number;
  max_contacts_per_day: number;
  legal_monto_tolerancia_cents: number;
  legal_horario_en_respuestas: number;
  rate_limit_rpm: number;
  dedupe_window_hours: number;
  score_amount_ceiling_cents: number;
  agent_mode: string;
  agent_auto_threshold_cents: number;
  dry_run: number;
  cron_auto_fire: number;
  /** 1 = tenant por defecto de la plataforma (el que se usa sin resolver). */
  is_default: number;
  created_at: string;
  updated_at: string;
}

/** Credenciales propias del tenant para un canal, sobre las de la plataforma. */
export type TenantChannelCredentials = ChannelOverride;

/**
 * Fila de `tenant_channels`: cómo se enruta el tráfico de un canal a un tenant.
 *
 * `provider_account_id` es el identificador que trae el proveedor en el webhook
 * (`phone_number_id` de Meta, `messaging_profile_id` de Telnyx, dominio de
 * Resend). Es lo que permite resolver el tenant de un mensaje entrante.
 */
export interface TenantChannel {
  id: string;
  tenant_id: string;
  channel: ChannelName;
  provider_account_id: string | null;
  credentials: TenantChannelCredentials | null;
  status: 'active' | 'inactive';
  /** Momento de alta de la fila: decide cuál gana si hay varias del mismo canal. */
  created_at: string;
}

/**
 * Configuración efectiva del tenant, ya resuelta (fila + entorno + defaults).
 *
 * Es el objeto que consumen el motor legal, la IA y los canales. Todo lo que
 * hoy se lee de `env.*` y depende del cliente debe salir de aquí.
 */
export interface TenantConfig {
  tz: string;

  // ── Identidad legal ──
  razonSocial: string;
  condusef: string;
  dominiosPermitidos: string[];
  horaInicio: number;
  horaFin: number;
  maxContactos24h: number;
  montoToleranciaCents: number;
  horarioEnRespuestas: boolean;

  // ── Operativa ──
  rateLimitRpm: number;
  dedupeWindowHours: number;
  scoreAmountCeilingCents: number;
  agentMode: string;
  agentAutoThresholdCents: number;
  dryRun: boolean;
  cronAutoFire: boolean;
}

/**
 * Contexto de trabajo: todo lo que una función necesita para operar *dentro*
 * de un tenant. Se pasa explícitamente en la firma (no por `env`) para que el
 * compilador obligue a propagarlo: D1 no tiene RLS, así que el aislamiento
 * depende de que ningún servicio pueda tocar la base sin contexto.
 */
export interface TenantContext {
  env: Env;
  tenantId: string;
  tenant: Tenant;
  config: TenantConfig;
  channels: TenantChannel[];
  principal: Principal;
}
