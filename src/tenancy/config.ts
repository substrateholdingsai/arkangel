/**
 * Resolución de la configuración efectiva de un tenant.
 *
 * Dos modos, y la diferencia entre ellos es la diferencia entre un sistema
 * multi-tenant y uno que no lo es:
 *
 * · `db`           → la fila de `tenants` es la fuente de verdad. Fail-closed:
 *                    si faltan datos, el sistema no los inventa.
 * · `platform_env` → la configuración se lee del entorno del Worker. Es el
 *                    puente de transición para el tenant que ya operaba antes
 *                    del multi-tenant: conserva EXACTAMENTE el comportamiento
 *                    anterior, byte por byte.
 *
 * Los tenants nuevos nacen siempre en `db`. Un tenant en `platform_env`
 * heredaría la identidad legal de la plataforma, que es precisamente el
 * defecto que el multi-tenant viene a corregir.
 */

import type { Env } from '../types/env';
import type { Tenant, TenantConfig } from './types';

/**
 * Valores por defecto de la plataforma.
 *
 * Viven aquí y en el `INSERT` de backfill de la migración 0004 (que es el
 * único otro sitio donde se escriben literales). El DDL **no** lleva `DEFAULT`
 * a propósito: si los llevara, un tenant insertado sin valores explícitos
 * heredaría unos defaults que pueden divergir de los de la plataforma.
 */
export const DEFAULTS_PLATAFORMA = {
  dominioPagoPorDefecto: 'prestamoclaro.com',
  tz: 'America/Mexico_City',
  horaInicio: 8,
  horaFin: 22,
  maxContactos24h: 3,
  montoToleranciaCents: 0,
  horarioEnRespuestas: false,
  rateLimitRpm: 42,
  dedupeWindowHours: 24,
  scoreAmountCeilingCents: 200000,
  agentMode: 'supervised',
  agentAutoThresholdCents: 200000,
  dryRun: false,
  cronAutoFire: false,
} as const;

/** Longitud máxima de la identidad legal que se imprime al pie del mensaje. */
export const MAX_IDENTIDAD_LEGAL = 180;

/**
 * Id del tenant por defecto de la plataforma.
 *
 * Es el mismo id que crea el backfill de la migración 0004. Deben coincidir:
 * si el id del tenant de respaldo fuera otro, al aplicar la migración cambiaría
 * el namespace de claves de KV (`t:{tenantId}:...`) y se perderían las
 * ventanas de dedupe ya reservadas.
 */
export const TENANT_POR_DEFECTO_ID = 't_arkangel';

// eslint-disable-next-line no-control-regex -- el objetivo es justo sanear los caracteres de control
const CARACTERES_DE_CONTROL = /[\u0000-\u001F\u007F]/g;

/**
 * Normaliza la identidad legal antes de usarla.
 *
 * La razón social y el registro CONDUSEF van al pie de cada mensaje **y** al
 * prompt del modelo. Sin acotar, un tenant podría inyectar instrucciones en el
 * prompt o un pie sin formato. Se eliminan los caracteres de control, se
 * colapsan los espacios y se corta la longitud.
 */
export function sanearIdentidadLegal(valor: string): string {
  return valor
    .replace(CARACTERES_DE_CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_IDENTIDAD_LEGAL);
}

/** Divide una lista CSV de dominios y normaliza a minúsculas. */
export function splitPaymentDomains(crudo: string): string[] {
  return crudo
    .split(',')
    .map((dominio) => dominio.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Configuración tomada del entorno del Worker.
 *
 * Es el comportamiento pre-multi-tenant. Se conserva literal: la allowlist de
 * dominios distingue entre "variable no definida" (dominio por defecto) y
 * "variable vacía" (ningún link permitido).
 */
export function configDesdeEntorno(env: Env): TenantConfig {
  const crudo = env.ALLOWED_PAYMENT_DOMAINS;
  const dominios =
    crudo === undefined ? [DEFAULTS_PLATAFORMA.dominioPagoPorDefecto] : splitPaymentDomains(crudo);

  return {
    tz: env.TZ ?? DEFAULTS_PLATAFORMA.tz,

    razonSocial: sanearIdentidadLegal(env.LEGAL_RAZON_SOCIAL ?? ''),
    condusef: sanearIdentidadLegal(env.LEGAL_CONDUSEF_REGISTRO ?? ''),
    dominiosPermitidos: dominios,
    horaInicio: Number(env.SEND_WINDOW_START ?? DEFAULTS_PLATAFORMA.horaInicio),
    horaFin: Number(env.SEND_WINDOW_END ?? DEFAULTS_PLATAFORMA.horaFin),
    maxContactos24h: Number(env.MAX_CONTACTS_PER_DAY ?? DEFAULTS_PLATAFORMA.maxContactos24h),
    montoToleranciaCents: Number(
      env.LEGAL_MONTO_TOLERANCIA_CENTS ?? DEFAULTS_PLATAFORMA.montoToleranciaCents
    ),
    horarioEnRespuestas:
      (env.LEGAL_HORARIO_EN_RESPUESTAS ?? String(DEFAULTS_PLATAFORMA.horarioEnRespuestas)) ===
      'true',

    rateLimitRpm: Number(env.RATE_LIMIT_RPM ?? DEFAULTS_PLATAFORMA.rateLimitRpm),
    dedupeWindowHours: Number(env.DEDUPE_WINDOW_HOURS ?? DEFAULTS_PLATAFORMA.dedupeWindowHours),
    scoreAmountCeilingCents: Number(
      env.SCORE_AMOUNT_CEILING_CENTS ?? DEFAULTS_PLATAFORMA.scoreAmountCeilingCents
    ),
    agentMode: env.AGENT_MODE ?? DEFAULTS_PLATAFORMA.agentMode,
    agentAutoThresholdCents: Number(
      env.AGENT_AUTO_THRESHOLD_CENTS ?? DEFAULTS_PLATAFORMA.agentAutoThresholdCents
    ),
    dryRun: env.DRY_RUN === 'true',
    cronAutoFire: (env.CRON_AUTO_FIRE ?? String(DEFAULTS_PLATAFORMA.cronAutoFire)) === 'true',

    recording: {
      enabled: env.RECORDING_ENABLED === 'true',
      announcement: (env.RECORDING_ANNOUNCEMENT || '').trim(),
      retentionDays: Number(env.RECORDING_RETENTION_DAYS || 0),
      consentRequired: (env.RECORDING_CONSENT_REQUIRED ?? 'true') === 'true',
      privacyNoticeUrl: (env.RECORDING_PRIVACY_NOTICE_URL || '').trim(),
    },
  };
}

/**
 * Configuración tomada de la fila del tenant.
 *
 * Sin herencia del entorno (salvo el freno de ensayo global): una cadena vacía
 * en `allowed_payment_domains` significa "ningún link permitido" (fail-closed),
 * no "usa el valor por defecto".
 */
export function configDesdeFila(env: Env, tenant: Tenant): TenantConfig {
  return {
    tz: tenant.tz,

    razonSocial: sanearIdentidadLegal(tenant.razon_social),
    condusef: sanearIdentidadLegal(tenant.condusef_registro),
    dominiosPermitidos: splitPaymentDomains(tenant.allowed_payment_domains),
    horaInicio: tenant.send_window_start,
    horaFin: tenant.send_window_end,
    maxContactos24h: tenant.max_contacts_per_day,
    montoToleranciaCents: tenant.legal_monto_tolerancia_cents,
    horarioEnRespuestas: tenant.legal_horario_en_respuestas === 1,

    rateLimitRpm: tenant.rate_limit_rpm,
    dedupeWindowHours: tenant.dedupe_window_hours,
    scoreAmountCeilingCents: tenant.score_amount_ceiling_cents,
    agentMode: tenant.agent_mode,
    agentAutoThresholdCents: tenant.agent_auto_threshold_cents,
    dryRun: tenant.dry_run === 1 || env.DRY_RUN === 'true',
    cronAutoFire: tenant.cron_auto_fire === 1,

    recording: {
      enabled: tenant.recording_enabled === 1,
      announcement: (tenant.recording_announcement || '').trim(),
      retentionDays: Number(tenant.recording_retention_days || 0),
      consentRequired: tenant.recording_consent_required !== 0, // default required if undefined?
      privacyNoticeUrl: (tenant.recording_privacy_notice_url || '').trim(),
    },
  };
}

/** Configuración efectiva del tenant según su modo. */
export function resolveTenantConfig(env: Env, tenant: Tenant): TenantConfig {
  return tenant.config_mode === 'platform_env'
    ? configDesdeEntorno(env)
    : configDesdeFila(env, tenant);
}

/**
 * ¿El tenant puede operar en modo `db`?
 *
 * Sin razón social el motor legal bloquea todos los mensajes (regla 1.1,
 * fail-closed): es mejor decirlo explícito que dejar de enviar en silencio.
 * Se evalúa sobre la configuración **efectiva**: un tenant en `platform_env`
 * puede tener su identidad en el entorno y no en la fila.
 */
export function tenantListoParaOperar(config: TenantConfig): boolean {
  return config.razonSocial.length > 0;
}

/**
 * ¿El tenant puede grabar audio de llamadas conforme a LFPDPPP?
 *
 * Fail-closed: requiere grabación habilitada explícitamente, locución de aviso
 * no vacía, política de retención en días > 0 y aviso de privacidad. Sin todo
 * esto, `startRecordingGoverned` bloquea el `record_start` aunque se invoque.
 */
export function tenantListoParaGrabar(config: TenantConfig): boolean {
  const r = config.recording;
  if (!r) return false;
  return (
    r.enabled === true &&
    r.announcement.trim().length > 0 &&
    r.retentionDays > 0 &&
    r.privacyNoticeUrl.trim().length > 0
  );
}
