/**
 * Cliente HTTP del panel.
 *
 * La identidad viaja en la cookie `ark_session`: el navegador la manda sola en
 * cada petición (`credentials: 'include'`), así que aquí no hay token que
 * gestionar, ni que renovar, ni que se pueda leer desde JavaScript.
 *
 * Lo único que este módulo sí lleva es el **tenant activo**: la cabecera
 * `X-Tenant-Id` elige en cuál de los despachos del usuario se opera. Nunca
 * amplía el alcance: el Worker comprueba que el usuario sea miembro de ese
 * despacho y, si no, responde 403.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Sesión inválida o ausente. Inicia sesión de nuevo.',
  forbidden: 'No tienes permiso para realizar esta acción.',
  tenant_forbidden: 'Ese despacho no es tuyo. Cambia de despacho o pide acceso.',
  tenant_mismatch: 'El despacho seleccionado no corresponde al usuario.',
  sin_membresia: 'Tu usuario no tiene ningún despacho asignado.',
  sin_acceso: 'No tienes acceso a este recurso.',
  tenant_not_found: 'El despacho solicitado no existe.',
};

let activeTenantId: string | null = null;

/** Fija el despacho activo (el que se manda en `X-Tenant-Id`). */
export function setActiveTenantId(tenantId: string | null): void {
  activeTenantId = tenantId;
}

/** Despacho activo en este momento. */
export function getActiveTenantId(): string | null {
  return activeTenantId;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (activeTenantId) {
    headers.set('X-Tenant-Id', activeTenantId);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const code = (data as { error?: string }).error ?? response.statusText;
    const message = MESSAGES[code] ?? code;
    throw new ApiError(response.status, code, message);
  }

  return data as T;
}

/* ── Sesión ────────────────────────────────────────────────────────────────── */

export type MembershipRole = 'owner' | 'admin' | 'member';

export interface AuthTenant {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
}

export interface AuthSession {
  user: AuthUser;
  tenants: AuthTenant[];
  platformRole: 'user' | 'super_admin';
}

export const auth = {
  /** Sesión actual (401 si no hay cookie válida). */
  session: () => request<AuthSession>('/api/auth/session'),

  login: (email: string, password: string) =>
    request<AuthSession>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (input: { email: string; password: string; fullName: string; tenantName?: string }) =>
    request<AuthSession>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        full_name: input.fullName,
        tenant_name: input.tenantName,
      }),
    }),

  logout: () => request<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  requestPasswordReset: (email: string) =>
    request<{ success: boolean; message: string }>('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<{ success: boolean; message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean; message: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
};

/* ── Panel ─────────────────────────────────────────────────────────────────── */

export interface CaseRow {
  id: string;
  client_id?: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  monto: string;
  monto_cents: number;
  estado: string;
  estado_label: string;
  banda: string;
  score: number;
  ultimo_canal: string | null;
  intencion: string | null;
  proxima_accion: string;
}

export interface ConversationMessage {
  id: string;
  case_id: string;
  client_id: string;
  channel: 'whatsapp' | 'sms' | 'email';
  direction: 'outbound' | 'inbound';
  provider_id: string | null;
  body: string;
  status: string;
  error: string | null;
  meta: string | null;
  created_at: string;
}

export interface ContractDetail {
  id: string;
  client_id: string;
  monto_pactado_cents: number;
  tasa_pct: number | null;
  clabe: string | null;
  nombre_legal: string | null;
  condusef: string | null;
}

export interface CaseWorkspace {
  ok: boolean;
  case: {
    id: string;
    case_date: string;
    client_id: string;
    debt_id: string | null;
    name: string;
    phone: string | null;
    email: string | null;
    amount_cents: number;
    status: string;
    score: number;
    score_band: string;
  };
  client: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    curp: string | null;
    do_not_disturb: number;
  } | null;
  debts: Array<{
    id: string;
    amount_cents: number;
    due_date: string;
    status: string;
  }>;
  contract: ContractDetail | null;
  messages: ConversationMessage[];
  notes?: Array<{
    id: string;
    note: string;
    actor: string;
    created_at: string;
  }>;
  ai_diagnostic?: {
    headline: string;
    reason: string;
    payment_status: 'paid' | 'promised' | 'claimed_paid' | 'pending';
    recommended_action: string;
    intention: string | null;
    confidence: number;
  };
  contactos_24h: number;
  legal: {
    nombre_legal: string | null;
    condusef: string | null;
    ventana: { inicio: number; fin: number };
    max_contactos_24h: number;
  };
}

export interface LegalViolacion {
  reglaId: string;
  conducta: string;
  ley: string;
  articulo: string;
  castigo: string;
  accion: string;
  evidencia: string;
}

export interface DailyMetrics {
  total: number;
  enviadas: number;
  contestadas: number;
  promesas: number;
  monto_prometido_cents: number;
  monto_cobrado_cents: number;
  csv_received_at: string | null;
  csv_name: string | null;
  por_estado: Record<string, number>;
}

export interface LegalRegla {
  id: string;
  seccion: string;
  conducta: string;
  ley: string;
  articulo: string;
  castigo: string;
  accion: string;
}

export interface LegalResumen {
  total: number;
  bloqueos: number;
  saneos: number;
  escalados: number;
  porRegla: Record<string, number>;
}

export interface LegalEstado {
  ok: boolean;
  date: string;
  identidad_configurada: boolean;
  nombre_legal: string | null;
  condusef: string | null;
  dominios_permitidos: string[];
  max_contactos_24h: number;
  ventana: { inicio: number; fin: number };
  resumen: LegalResumen;
}

export interface SystemStatus {
  ok: boolean;
  timestamp: string;
  d1: {
    ok: boolean;
    latency_ms: number;
    clients_total: number;
  };
  workers_ai: {
    ok: boolean;
    model: string;
    dry_run: boolean;
  };
  queue: {
    ok: boolean;
    ready: number;
    sending: number;
  };
  legal_engine: {
    ok: boolean;
    reglas_activas: number;
    conductas_auditadas: number;
    razon_social: string | null;
    condusef: string | null;
    bloqueos_hoy: number;
  };
  ventana: {
    inicio: number;
    fin: number;
    tz: string;
    hora_local: number;
    abierta_ahora: boolean;
  };
  rate_limit: {
    whatsapp_rpm: number;
    max_rpm: number;
    enviados_hoy: number;
  };
}

export interface TenantSettings {
  tenant_id: string;
  slug: string;
  nombre: string;
  config_mode: 'db' | 'platform_env';
  razon_social: string;
  condusef_registro: string;
  allowed_payment_domains: string;
  tz: string;
  send_window_start: number;
  send_window_end: number;
  max_contacts_per_day: number;
  rate_limit_rpm: number;
  agent_mode: string;
  agent_auto_threshold_cents: number;
  dry_run: boolean;
}

export interface TenantWebhooks {
  conekta: string;
  cobre: string;
  whatsapp: string;
  telnyx: string;
  resend: string;
}

export interface TenantMember {
  userId: string;
  email: string;
  fullName: string;
  role: MembershipRole;
  active: boolean;
  createdAt: number;
}

export interface AccountingMapRule {
  regla_id: string;
  cuenta_debito: string;
  cuenta_credito: string;
  tipo_asiento: 'provision' | 'gasto' | 'contingencia';
  descripcion: string;
}

export interface AccountingAsiento {
  cuenta_debito: string;
  cuenta_credito: string;
  concepto: string;
  monto: number;
  tipo_asiento: 'provision' | 'gasto' | 'contingencia';
  regla_id: string;
  ley: string;
  articulo: string;
  castigo: string;
  referencia_ledger: string;
  cfdi_relacionado: string | null;
  legal_audit_id: string;
}

export interface AccountingLivePayload {
  ok: boolean;
  source: 'live' | 'r2';
  fecha_corte: string;
  idempotency_key: string;
  ledger_integrity: {
    hash_primer_registro: string;
    hash_ultimo_registro: string;
    total_registros: number;
    verificado: boolean;
  };
  resumen: {
    ingresos_reconocidos: number;
    ingresos_no_reconocidos_por_bloqueo: number;
    provision_cartera_ilegal: number;
    iva_trasladado: number;
    iva_acreditable_estimado: number;
  };
  asientos: AccountingAsiento[];
}

export interface DailyExecutiveReport {
  date: string;
  tenant: {
    id: string;
    nombre: string;
    razon_social: string | null;
    condusef: string | null;
  };
  operacion: {
    total_casos: number;
    mensajes_enviados: number;
    casos_contestados: number;
    promesas_registradas: number;
    monto_prometido_cents: number;
    monto_cobrado_cents: number;
    escalados_humano: number;
    en_cola_ready: number;
  };
  cumplimiento_legal: {
    total_auditorias: number;
    bloqueos: number;
    saneos: number;
    escalados: number;
    por_regla: Record<string, number>;
  };
  contabilidad: {
    idempotency_key: string;
    ledger_verificado: boolean;
    ledger_hash_ultimo: string;
    ledger_total_registros: number;
    ingresos_reconocidos_mxn: number;
    provision_cartera_ilegal_mxn: number;
    ingresos_bloqueados_mxn: number;
    iva_trasladado_mxn: number;
    iva_acreditable_estimado_mxn: number;
    total_asientos: number;
  };
}

export const api = {
  todayCases: () =>
    request<{ ok: boolean; date: string; count: number; total_cents: number; cases: CaseRow[] }>(
      '/api/v1/cases/today'
    ),

  todayMetrics: () =>
    request<{ ok: boolean; date: string; metrics: DailyMetrics }>('/api/v1/metrics/today'),

  systemStatus: () => request<SystemStatus>('/api/v1/system/status'),

  legalEstado: () => request<LegalEstado>('/api/v1/legal/hoy'),

  legalCatalogo: () => request<{ ok: boolean; reglas: LegalRegla[] }>('/api/v1/legal/catalogo'),

  ingestCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{
      ok: boolean;
      total: number;
      accepted: number;
      skipped: number;
      preview: { nombre: string; tel: string; monto: string }[];
    }>('/api/v1/ingest/csv', { method: 'POST', body: form });
  },

  disparar: () =>
    request<{ ok: boolean; queued: number; skipped: number }>('/api/v1/disparar', {
      method: 'POST',
    }),

  caseWorkspace: (caseId: string) =>
    request<CaseWorkspace>(`/api/v1/cases/${encodeURIComponent(caseId)}/workspace`),

  replyCase: (
    caseId: string,
    input: { channel: 'whatsapp' | 'sms' | 'email'; body: string; subject?: string }
  ) =>
    request<{
      ok: boolean;
      message: ConversationMessage;
      sanitized_body: string;
      violaciones: LegalViolacion[];
    }>(`/api/v1/cases/${encodeURIComponent(caseId)}/reply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  resolveCase: (
    caseId: string,
    input: {
      action: 'promise' | 'paid' | 'return_ai' | 'dnd';
      promised_date?: string;
      promised_amount_cents?: number;
    }
  ) =>
    request<{ ok: boolean; status: string; promised_date?: string; do_not_disturb?: boolean }>(
      `/api/v1/cases/${encodeURIComponent(caseId)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    ),

  callCase: (
    caseId: string,
    input:
      | { phase: 'start' }
      | { phase: 'complete'; duration_seconds: number; outcome: string; notes: string }
  ) =>
    request<{
      ok: boolean;
      call_id?: string;
      phone?: string | null;
      guion_obligatorio?: string;
      clabe_autorizada?: string | null;
      message?: ConversationMessage;
    }>(`/api/v1/cases/${encodeURIComponent(caseId)}/call`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  copilotChat: (input: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    active_case_id?: string | null;
  }) =>
    request<{
      ok: boolean;
      reply: string;
      suggested_draft: string | null;
      context_summary: {
        tenantName: string;
        condusef: string | null;
        windowOpen: boolean;
        humanCasesCount: number;
        readyCasesCount: number;
        activeCaseName: string | null;
      };
    }>('/api/v1/copilot/chat', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  addCaseNote: (caseId: string, note: string) =>
    request<{
      ok: boolean;
      note: { note: string; actor: string; created_at: string };
    }>(`/api/v1/cases/${encodeURIComponent(caseId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  reconcilePaymentsCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{
      ok: boolean;
      mode: string;
      total: number;
      reconciled: number;
      duplicate: number;
      unmatched: number;
      totalReconciledCents: number;
    }>('/api/v1/payments/reconcile', {
      method: 'POST',
      body: form,
    });
  },

  reconcileCobreSpei: (input: {
    clabe?: string | null;
    reference?: string | null;
    amount_cents: number;
    tracking_key: string;
  }) =>
    request<{
      ok: boolean;
      mode: string;
      total: number;
      reconciled: number;
      duplicate: number;
      unmatched: number;
      totalReconciledCents: number;
    }>('/api/v1/payments/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        event: 'money_movements.status.completed',
        data: {
          virtual_clabe: input.clabe,
          reference: input.reference,
          amount_cents: input.amount_cents,
          cep_tracking_key: input.tracking_key,
          completed_at: new Date().toISOString(),
        },
      }),
    }),

  reconcileConektaSpei: (input: {
    clabe?: string | null;
    case_id?: string | null;
    amount_cents: number;
    order_id: string;
  }) =>
    request<{
      ok: boolean;
      mode: string;
      total: number;
      reconciled: number;
      duplicate: number;
      unmatched: number;
      totalReconciledCents: number;
    }>('/api/v1/payments/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        type: 'order.paid',
        data: {
          object: {
            id: input.order_id,
            amount: input.amount_cents,
            currency: 'MXN',
            payment_status: 'paid',
            metadata: {
              case_id: input.case_id,
            },
            charges: {
              data: [
                {
                  id: `chg_${input.order_id}`,
                  status: 'paid',
                  amount: input.amount_cents,
                  payment_method: {
                    type: 'spei',
                    clabe: input.clabe,
                    reference: input.order_id,
                  },
                },
              ],
            },
          },
        },
      }),
    }),

  getTenantSettings: () =>
    request<{
      ok: boolean;
      settings: TenantSettings;
      webhooks: TenantWebhooks;
    }>('/api/v1/tenant/settings'),

  updateTenantSettings: (input: Partial<TenantSettings>) =>
    request<{
      ok: boolean;
      settings: TenantSettings;
    }>('/api/v1/tenant/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  listTenantMembers: () =>
    request<{
      ok: boolean;
      members: TenantMember[];
    }>('/api/v1/tenant/members'),

  inviteTenantMember: (input: { email: string; full_name: string; role: MembershipRole }) =>
    request<{
      ok: boolean;
      invited: {
        user_id: string;
        email: string;
        full_name: string;
        role: MembershipRole;
        is_new_user: boolean;
      };
      email_sent: boolean;
      invite_url: string;
      members: TenantMember[];
    }>('/api/v1/tenant/members/invite', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeTenantMember: (userId: string) =>
    request<{
      ok: boolean;
      members: TenantMember[];
    }>(`/api/v1/tenant/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),

  getAccountingLive: (fecha?: string) =>
    request<AccountingLivePayload>(
      `/api/v1/contabilidad/resumen?live=1${fecha ? `&fecha=${encodeURIComponent(fecha)}` : ''}`
    ),

  getAccountingMap: () =>
    request<{
      ok: boolean;
      tenant_id: string;
      rules: AccountingMapRule[];
    }>('/api/v1/tenant/accounting-map'),

  updateAccountingMap: (rules: AccountingMapRule[]) =>
    request<{
      ok: boolean;
      tenant_id: string;
      updated: number;
      rules: AccountingMapRule[];
    }>('/api/v1/tenant/accounting-map', {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    }),

  getDailyReport: (date?: string) =>
    request<{
      ok: boolean;
      report: DailyExecutiveReport;
    }>(`/api/v1/reports/daily${date ? `?date=${encodeURIComponent(date)}` : ''}`),

  sendDailyReport: (input: { date?: string; to?: string }) =>
    request<{
      ok: boolean;
      email_sent: boolean;
      recipients: string[];
      report: DailyExecutiveReport;
    }>('/api/v1/reports/daily/send', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
