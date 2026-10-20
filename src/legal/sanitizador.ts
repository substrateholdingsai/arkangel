/**
 * Sanitizador de mensajes: repara lo que se puede reparar (SANITIZE) y deja
 * el resto para que el motor lo bloquee (BLOCK).
 *
 * Política: preferimos **eliminar la frase completa** que contiene la
 * conducta prohibida, no dejar fragmentos sin sentido en un mensaje que ve
 * el cliente.
 */

export interface ResultadoSaneo {
  texto: string;
  removidos: string[];
}

export const PATRONES_AMENAZA: RegExp[] = [
  /\bembargar(?:e|emos|án|an)?\b/gi,
  /\bembargo\b/gi,
  /\bjuici[oa]l?s?\b/gi,
  /\bpolic[ií]a\b/gi,
  /\bministerio p[uú]blico\b/gi,
  /\bdemandar\b/gi,
  /\bdemanda judicial\b/gi,
  /\bcobranza judicial\b/gi,
  /\bcondena(?:do|da)?\b/gi,
  /\bse le (?:requerir[aá]|trasladar[aá])\b/gi,
  /\bconsecuencias? (?:legales?|jur[ií]dicas?)\b/gi,
  /\bdeclarar(?:lo)?\s+en\s+cartera\b/gi,
];

export const PATRONES_ROL_LEGAL: RegExp[] = [
  /\babogad[oa]s?\b/gi,
  /\bdespacho jur[ií]dico\b/gi,
  /\basesor(?:es)? jur[ií]dic[oa]s?\b/gi,
  /\bc[eé]dula profesional\b/gi,
  /\bpoder notarial\b/gi,
  /\bministro de justicia\b/gi,
];

export const PATRONES_EXTORSION: RegExp[] = [
  /\b(?:tus|sus) contactos\b/gi,
  /\bcontactos? de referencia\b/gi,
  /\bfamiliares?\b/gi,
  /\b(?:tus|sus) (?:amigos|conocidos)\b/gi,
  /\bdifundir(?:e|iremos|ir)?\b/gi,
  /\bhacemos saber a\b/gi,
  /\bmandaremos (?:el |la )?(?:nombre|cobranza)\b/gi,
  /\bcartel\b/gi,
  /\bpresionar(?:emos)?\b/gi,
];

export const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
export const CLABE_REGEX = /\b\d{16,18}\b/g;

export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function coincideAlguna(texto: string, patrones: RegExp[]): string | null {
  for (const patron of patrones) {
    const match = patron.exec(texto);
    if (match) return match[0];
    patron.lastIndex = 0;
  }
  return null;
}

export function contieneAlguna(texto: string, patrones: RegExp[]): string | null {
  for (const patron of patrones) {
    patron.lastIndex = 0;
    const match = patron.exec(texto);
    if (match) return match[0];
  }
  return null;
}

/** Divide en segmentos oracionales conservando saltos de línea. */
function segmentar(texto: string): string[] {
  return texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function quitarSegmentos(texto: string, patrones: RegExp[]): ResultadoSaneo {
  const removidos: string[] = [];
  const fragmentos: string[] = [];

  for (const segmento of segmentar(texto)) {
    const coincidencia = contieneAlguna(segmento, patrones);
    if (coincidencia) {
      removidos.push(`${coincidencia} → "${segmento.slice(0, 80)}"`);
      continue;
    }
    fragmentos.push(segmento);
  }

  const textoLimpio = fragmentos
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { texto: textoLimpio, removidos };
}

export function sanearAmenazas(texto: string): ResultadoSaneo {
  return quitarSegmentos(texto, PATRONES_AMENAZA);
}

export function sanearRolLegal(texto: string): ResultadoSaneo {
  return quitarSegmentos(texto, PATRONES_ROL_LEGAL);
}

export function sanearExtorsion(texto: string): ResultadoSaneo {
  return quitarSegmentos(texto, PATRONES_EXTORSION);
}

export function extraerDominios(texto: string): string[] {
  const matches = texto.match(URL_REGEX) ?? [];
  return matches.map((url) => {
    const limpio = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const host = limpio.split(/[/?#]/)[0] ?? limpio;
    return host.toLowerCase();
  });
}

export function esDominioPermitido(dominio: string, permitidos: string[]): boolean {
  return permitidos.some((permitido) => dominio === permitido || dominio.endsWith(`.${permitido}`));
}

/** Elimina links cuyo dominio no esté en la allowlist (regla 3.1). */
export function sanearLinks(texto: string, permitidos: string[]): ResultadoSaneo {
  const removidos: string[] = [];
  const limpio = texto.replace(URL_REGEX, (url) => {
    const dominio = extraerDominios(url)[0] ?? '';
    if (esDominioPermitido(dominio, permitidos)) return url;
    removidos.push(`${dominio || url} → "${url}"`);
    return '';
  });
  return { texto: limpio.replace(/\s{2,}/g, ' ').trim(), removidos };
}

export function extraerClabes(texto: string): string[] {
  return (texto.match(CLABE_REGEX) ?? []).filter((c) => c.length >= 16);
}

/** Pie legal obligatorio: razón social + registro CONDUSEF (regla 1.1). */
export function pieLegal(nombreLegal: string, condusef: string): string {
  const partes: string[] = [];
  if (nombreLegal) partes.push(nombreLegal);
  if (condusef) partes.push(`Reg. CONDUSEF ${condusef}`);
  if (partes.length === 0) return '';
  return `— ${partes.join(' · ')}. Para pagar, usa únicamente el medio de pago de tu contrato.`;
}

/** ¿El mensaje ya identifica al emisor con la razón social registrada? */
export function contieneIdentidadLegal(texto: string, nombreLegal: string): boolean {
  if (!nombreLegal) return false;
  const textoNormal = normalizar(texto);
  const legalNormal = normalizar(nombreLegal);
  if (!legalNormal) return false;
  if (textoNormal.includes(legalNormal)) return true;

  // Comparación tolerante: "Arkelangel, S.A. de C.V." vs "Arkelangel SA de CV"
  const tolerant = legalNormal
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return tolerant.length > 3 && textoNormal.replace(/[^a-z0-9 ]/g, '').includes(tolerant);
}

/** Saneo completo: amenazas → roles legales → extorsión → links → pie legal. */
export function sanearMensaje(
  texto: string,
  opciones: { dominiosPermitidos: string[]; pie: string }
): ResultadoSaneo {
  const removidos: string[] = [];
  let actual = texto;

  const pasos = [sanearAmenazas(actual), sanearRolLegal(actual), sanearExtorsion(actual)];

  for (const paso of pasos) {
    removidos.push(...paso.removidos);
    actual = paso.texto;
  }

  const links = sanearLinks(actual, opciones.dominiosPermitidos);
  removidos.push(...links.removidos);
  actual = links.texto;

  if (opciones.pie && !contieneIdentidadLegal(actual, opciones.pie)) {
    actual = `${actual}\n\n${opciones.pie}`.trim();
  }

  return { texto: actual, removidos };
}
