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

export const api = {
  todayCases: () =>
    request<{ ok: boolean; date: string; count: number; total_cents: number; cases: CaseRow[] }>(
      '/api/v1/cases/today'
    ),

  todayMetrics: () =>
    request<{ ok: boolean; date: string; metrics: DailyMetrics }>('/api/v1/metrics/today'),

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
};
