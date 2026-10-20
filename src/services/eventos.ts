import type { Env } from '../types/env';
import { newId, nowIso } from './db';

export async function logEvent(
  env: Env,
  type: string,
  options: { caseId?: string | null; clientId?: string | null; payload?: unknown } = {}
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO events (id, type, case_id, client_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(
      newId('evt'),
      type,
      options.caseId ?? null,
      options.clientId ?? null,
      options.payload ? JSON.stringify(options.payload) : null,
      nowIso()
    )
    .run();
}
