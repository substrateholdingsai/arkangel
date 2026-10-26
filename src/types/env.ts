/**
 * Bindings y variables de entorno del Worker Arkangel.
 * Secrets reales vía `wrangler secret put`; los no secretos en `wrangler.jsonc` -> vars.
 */

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  // ── Plataforma ──
  ENVIRONMENT: string;
  AI: AiBinding;
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  COBRANZA_QUEUE: Queue<CobranzaQueueMessage | ContabilidadRetryMessage>;
  CALL_LOCK: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  /** DO del spike de voz: uno por llamada. */
  CALL_SESSION: DurableObjectNamespace;
  /** DO para microVMs Firecracker del Agente Hermes (Plano 2). */
  HERMES_SANDBOX?: DurableObjectNamespace;
  /** Bucket R2 para persistencia episódica de /home/hermes. */
  HERMES_MEMORY_BUCKET?: R2Bucket;

  // ── Tokens de acceso (no son secretos de proveedor, pero sí protegidos) ──
  ADMIN_TOKEN: string;
  INTAKE_TOKEN: string;
  GROK_BOT_TOKEN?: string;

  // ── Resend (email) ──
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  /** Remitente de correos de acceso (p. ej. `Arkangel <auth@arksystems.site>`). */
  AUTH_FROM_EMAIL?: string;
  /** URL publica del panel, base de los enlaces de los correos de auth. */
  APP_URL?: string;

  // ── WhatsApp (Telnyx API v2 / Meta Graph heredado) ──
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANG?: string;

  // ── Telnyx (SMS & WhatsApp Business API & Voice AI) ──
  TELNYX_API_KEY: string;
  TELNYX_MESSAGING_PROFILE_ID: string;
  TELNYX_FROM_NUMBER: string;
  TELNYX_WHATSAPP_FROM?: string;
  TELNYX_WEBHOOK_PUBLIC_KEY?: string;
  TELNYX_CONNECTION_ID?: string;
  TELNYX_ASSISTANT_ID?: string;

  // ── Ajustes operativos (vars) ──
  AI_MODEL?: string;
  DEDUPE_WINDOW_HOURS?: string;
  RATE_LIMIT_RPM?: string;
  SEND_WINDOW_START?: string;
  SEND_WINDOW_END?: string;
  TZ?: string;
  SCORE_AMOUNT_CEILING_CENTS?: string;
  CRON_AUTO_FIRE?: string;
  DRY_RUN?: string;
  AGENT_MODE?: string;
  AGENT_AUTO_THRESHOLD_CENTS?: string;

  // ── Spike de voz (EXPERIMENTAL, apagado por defecto) ──
  /** Flag del spike: si no es 'true', /spike/* no existe (404). */
  SPIKE_VOZ_ENABLED?: string;
  /** Workers AI (Deepgram Nova-3 / Aura) por WebSocket: token con `Workers AI: Read/Edit`. */
  CF_AI_API_TOKEN?: string;
  /** Cuenta de Cloudflare donde viven los modelos de Workers AI. */
  CF_AI_ACCOUNT_ID?: string;
  /** Modelo de transcripción (Workers AI). */
  SPIKE_STT_MODEL?: string;
  /** Modelo de síntesis (Workers AI Aura). */
  SPIKE_TTS_MODEL?: string;
  /** Hablante de síntesis (Aura en español, `estrella` es el de México). */
  SPIKE_TTS_VOICE?: string;
  /** Modelo de LLM para la fase de voz (más rápido que el 70B). */
  SPIKE_VOZ_MODEL?: string;
  /** Cloudflare Realtime (el producto que hoy sustituye a Cloudflare Calls). */
  CF_REALTIME_API_TOKEN?: string;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_ACCOUNT_ID?: string;
  CF_REALTIME_PRESET_NAME?: string;

  // ── Cumplimiento legal ──
  LEGAL_RAZON_SOCIAL?: string;
  LEGAL_CONDUSEF_REGISTRO?: string;
  ALLOWED_PAYMENT_DOMAINS?: string;
  MAX_CONTACTS_PER_DAY?: string;
  LEGAL_MONTO_TOLERANCIA_CENTS?: string;
  LEGAL_HORARIO_EN_RESPUESTAS?: string;

  // ── Módulo contable (Alegra vía MCP) ──
  ALEGRA_MCP_URL?: string;
  ALEGRA_MCP_TOKEN?: string;
  ALEGRA_MCP_TIMEOUT_MS?: string;
  /** Salt de la idempotency key: evita colisiones y claves predecibles. */
  ALEGRA_IDEMPOTENCY_SALT?: string;
  ALEGRA_IVA_PCT?: string;
  ALEGRA_CUENTA_CONTINGENCIA?: string;
  ALEGRA_CUENTA_CONTINGENCIA_CREDITO?: string;

  // ── Infraestructura de Pagos Modernos (Cobre Enterprise & Conekta Mid-Market · SPEI) ──
  COBRE_BASE_URL?: string;
  COBRE_USER_ID?: string;
  COBRE_SECRET?: string;
  COBRE_WEBHOOK_SECRET?: string;
  CONEKTA_API_KEY?: string;
  CONEKTA_WEBHOOK_PUBLIC_KEY?: string;
}

export interface CobranzaQueueMessage {
  type: 'cobranza.disparar';
  caseId: string;
  clientId: string;
  channel?: string;
  attempt?: number;
  enqueuedAt: number;
  /** Tenant al que pertenece el caso. */
  tenantId: string;
  /** Trace context for observability. */
  traceId?: string;
  spanId?: string;
}

/** Reintento del módulo contable: reencola el mismo payload (misma idempotency_key). */
export interface ContabilidadRetryMessage {
  type: 'contabilidad.reintento';
  fechaCorte: string;
  idempotencyKey: string;
  attempt: number;
  enqueuedAt: number;
  tenantId: string;
  /** Trace context for observability. */
  traceId?: string;
  spanId?: string;
}
