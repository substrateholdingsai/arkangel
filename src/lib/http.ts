// Cliente HTTP con timeout, reintentos y backoff exponencial.

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  idempotencyKey?: string;
}

export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  raw?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<JsonResponse<T>> {
  const {
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 400,
    headers = {},
    method = 'GET',
    body,
    idempotencyKey,
  } = options;

  let lastError = 'unknown error';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      const raw = await response.text();
      let data: T | null = null;
      if (raw) {
        try {
          data = JSON.parse(raw) as T;
        } catch {
          data = null;
        }
      }

      if (response.ok) {
        return { ok: true, status: response.status, data, raw };
      }

      lastError = `${response.status} ${raw.slice(0, 500)}`;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        return { ok: false, status: response.status, data, error: lastError, raw };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === retries) {
        return { ok: false, status: 0, data: null, error: lastError };
      }
    } finally {
      clearTimeout(timer);
    }

    const backoff = retryDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  return { ok: false, status: 0, data: null, error: lastError };
}
