/**
 * Helpers de autenticaci�n para las rutas.
 */

export function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return (
    request.headers.get('x-admin-token') ??
    request.headers.get('x-intake-token') ??
    request.headers.get('x-grok-bot-token')
  );
}
