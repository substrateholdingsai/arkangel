type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;

export function setTokenProvider(p: TokenProvider): void {
  tokenProvider = p;
}

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
  tenant_mismatch: 'La organización seleccionada no corresponde al tenant.',
  org_sin_tenant: 'La organización o el usuario no están dados de alta.',
  sin_acceso: 'No tienes acceso a este recurso.',
  tenant_not_found: 'El tenant solicitado no existe.',
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = await tokenProvider();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const code = (data as { error?: string }).error ?? response.statusText;
    const message = MESSAGES[code] ?? code;
    throw new ApiError(response.status, code, message);
  }

  return data as T;
}

export interface CaseRow {
  id: string;
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
};
