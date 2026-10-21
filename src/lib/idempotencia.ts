// Idempotency helpers backed by KV: evita disparos duplicados por caso/canal.

import { tenantKvKey } from '../tenancy/keys';

export class IdempotencyKey {
  /**
   * Llave **legacy** (sin tenant). Se sigue consultando durante la ventana de
   * transición al namespace con prefijo de tenant, para no reiniciar las
   * ventanas de dedupe ya reservadas.
   */
  static forCase(caseId: string, channel: string): string {
    return `cobranza:${caseId}:${channel}`;
  }

  static forIngest(source: string, ref: string): string {
    return `ingesta:${source}:${ref}`;
  }

  /**
   * Llave **legacy** (sin tenant). Se sigue consultando durante la ventana de
   * transición al namespace con prefijo de tenant.
   */
  static forInbound(provider: string, providerId: string): string {
    return `inbound:${provider}:${providerId}`;
  }

  static forDay(scope: string, day: string): string {
    return `dia:${scope}:${day}`;
  }

  // ── Variantes por tenant ──
  // Mismo significado que las de arriba, pero con el prefijo `t:{tenantId}:`.
  // El prefijo es lo único que impide que el dedupe de un cliente bloquee al
  // otro, y que el throttle RPM de uno consuma el cupo del otro.

  static forTenantCase(tenantId: string, caseId: string, channel: string): string {
    return tenantKvKey(tenantId, 'cobranza', caseId, channel);
  }

  static forTenantInbound(tenantId: string, provider: string, providerId: string): string {
    return tenantKvKey(tenantId, 'inbound', provider, providerId);
  }

  static forTenantRateLimit(tenantId: string, channel: string, minute: number): string {
    return tenantKvKey(tenantId, 'rl', channel, String(minute));
  }

  static hash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}

export interface IdempotencyResult<T> {
  isNew: boolean;
  data?: T;
  existingKey?: string;
}

export async function checkAndReserve<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds = 3600
): Promise<IdempotencyResult<T>> {
  const existing = await kv.get(key, 'json');

  if (existing && existing !== 'processing') {
    return { isNew: false, data: existing as T, existingKey: key };
  }

  if (existing === 'processing') {
    return { isNew: false, existingKey: key };
  }

  await kv.put(key, 'processing', { expirationTtl: ttlSeconds });
  return { isNew: true };
}

export async function confirmIdempotency<T>(
  kv: KVNamespace,
  key: string,
  data: T,
  ttlSeconds = 7776000
): Promise<void> {
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
}

export async function releaseIdempotency(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

/**
 * Ejecuta `operation` una sola vez por clave. Si ya corrió, devuelve el resultado cacheado.
 */
export async function withIdempotency<T>(
  kv: KVNamespace,
  key: string,
  operation: () => Promise<T>,
  options: { reservationTtl?: number; confirmTtl?: number } = {}
): Promise<T> {
  const { reservationTtl = 3600, confirmTtl = 7776000 } = options;

  const check = await checkAndReserve<T>(kv, key, reservationTtl);
  if (!check.isNew) {
    if (check.data) return check.data as T;
    throw new Error('Operation already in progress');
  }

  try {
    const result = await operation();
    await confirmIdempotency(kv, key, result, confirmTtl);
    return result;
  } catch (error) {
    await releaseIdempotency(kv, key);
    throw error;
  }
}

/**
 * Marca una clave como "ya enviada" durante la ventana de dedupe.
 * Devuelve false si ya estaba marcada (no se debe reenviar).
 */
export async function reserveOnce(
  kv: KVNamespace,
  key: string,
  windowSeconds: number,
  payload?: unknown
): Promise<boolean> {
  const existing = await kv.get(key);
  if (existing !== null) return false;
  await kv.put(key, JSON.stringify(payload ?? { at: Date.now() }), {
    expirationTtl: Math.max(60, windowSeconds),
  });
  return true;
}

/**
 * Reserva una llave teniendo en cuenta su equivalente **legacy** (sin tenant).
 *
 * Al migrar el namespace de claves de KV, las reservas hechas antes del
 * despliegue siguen vivas (24 h para el envío, 7 días para el inbound) pero el
 * código nuevo ya no las vería: la ventana de dedupe se reiniciaría y podría
 * mandarse un segundo mensaje al mismo deudor. Esta función consulta la llave
 * vieja antes de reservar la nueva.
 *
 * La llave legacy se consulta primero a propósito: si se reservara la nueva y
 * después se encontrara la vieja, habría que liberar la nueva.
 */
export async function reserveOnceConLegado(
  kv: KVNamespace,
  key: string,
  legacyKey: string,
  windowSeconds: number,
  payload?: unknown
): Promise<boolean> {
  const previo = await kv.get(legacyKey);
  if (previo !== null) return false;
  return reserveOnce(kv, key, windowSeconds, payload);
}
