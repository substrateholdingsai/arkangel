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

  // ── Tokens de acceso (no son secretos de proveedor, pero sí protegidos) ──
  ADMIN_TOKEN: string;
  INTAKE_TOKEN: string;
  GROK_BOT_TOKEN?: string;

  // ── Resend (email) ──
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;

  // ── WhatsApp Cloud API (Meta) ──
  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANG?: string;

  // ── Telnyx (SMS) ──
  TELNYX_API_KEY: string;
  TELNYX_MESSAGING_PROFILE_ID: string;
  TELNYX_FROM_NUMBER: string;
  TELNYX_WEBHOOK_PUBLIC_KEY?: string;

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

  // ── Clerk (identidad) ─────────────────────────────────────────────────────
  // Opcionales para que el Worker arranque sin Clerk configurado: en ese caso
  // `clerkActivo(env)` devuelve false y la verificación cae a null (flujo normal).
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  /** PEM público: verificación de JWT sin red (no llama a la API de Clerk). */
  CLERK_JWT_KEY?: string;
  /** CSV de orígenes permitidos (claim `azp` del JWT). */
  CLERK_AUTHORIZED_PARTIES?: string;
}

export interface CobranzaQueueMessage {
  type: 'cobranza.disparar';
  caseId: string;
  clientId: string;
  channel?: string;
  attempt?: number;
  enqueuedAt: number;
  /** Tenant al que pertenece el caso. Opcional mientras siga el tenant único. */
  tenantId?: string;
}

/** Reintento del módulo contable: reencola el mismo payload (misma idempotency_key). */
export interface ContabilidadRetryMessage {
  type: 'contabilidad.reintento';
  fechaCorte: string;
  idempotencyKey: string;
  attempt: number;
  enqueuedAt: number;
}
