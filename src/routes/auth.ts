import type { Env } from '../types/env';
import { safeCompare } from '../lib/crypto';

export function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return request.headers.get('x-admin-token') ?? request.headers.get('x-intake-token');
}

export function isAdmin(request: Request, env: Env): boolean {
  const token = extractToken(request);
  return safeCompare(token, env.ADMIN_TOKEN);
}

export function isIntake(request: Request, env: Env): boolean {
  const token = extractToken(request);
  if (safeCompare(token, env.INTAKE_TOKEN)) return true;
  return safeCompare(token, env.ADMIN_TOKEN);
}

export function isAgent(request: Request, env: Env): boolean {
  const token = extractToken(request);
  if (env.GROK_BOT_TOKEN && safeCompare(token, env.GROK_BOT_TOKEN)) return true;
  return safeCompare(token, env.ADMIN_TOKEN);
}
