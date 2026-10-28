// Verificación de firmas de webhooks (Telnyx usa Ed25519).

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifica la firma Ed25519 de Telnyx.
 * La carga firmada es `${timestamp}.${rawBody}` y la llave arrives en base64.
 * Devuelve false si el runtime no soporta Ed25519 o la llave está mal formada.
 */
export async function verifyEd25519(
  publicKeyBase64: string,
  signatureBase64: string,
  timestamp: string,
  rawBody: string
): Promise<boolean> {
  try {
    const keyBytes = base64ToBytes(publicKeyBase64);
    const signature = base64ToBytes(signatureBase64);
    const data = new TextEncoder().encode(`${timestamp}.${rawBody}`);

    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature as BufferSource,
      data as BufferSource
    );
  } catch {
    return false;
  }
}

/** Constante de tiempo para tokens de API/admin. Hashea ambas entradas para que
 *  la comparación sea siempre de longitud fija y no filtre la longitud del secreto. */
export async function safeCompare(
  a: string | null | undefined,
  b: string | null | undefined
): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return timingSafeEqual(bytesToHex(new Uint8Array(ha)), bytesToHex(new Uint8Array(hb)));
}
