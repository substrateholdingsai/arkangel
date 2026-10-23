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
  // Conducta 2.3 del Mapa Legal: amenazas alegando acceso directo al dispositivo / spyware
  /\bacceso(?:\s+directo)?\s+a\s+(?:tu|su)\s+(?:dispositivo|celular|tel[eé]fono|galer[ií]a|c[aá]mara|ubicaci[oó]n)\b/gi,
  /\b(?:descargamos|extrajimos|tenemos)\s+(?:tus|sus)\s+(?:fotos|archivos|conversaciones)\b/gi,
  /\b(?:hackear|clonar|intervenir)\s+(?:tu|su)\s+(?:celular|tel[eé]fono|dispositivo)\b/gi,
  /\brastreamos\s+(?:tu|su)\s+(?:ubicaci[oó]n|gps)\b/gi,
];

export const PATRONES_ROL_LEGAL: RegExp[] = [
  /\babogad[oa]s?\b/gi,
  /\bdespacho jur[ií]dico\b/gi,
  /\basesor(?:es)? jur[ií]dic[oa]s?\b/gi,
  /\bc[eé]dula profesional\b/gi,
  /\bpoder notarial\b/gi,
  /\bministro de justicia\b/gi,
  // Conductas 1.2, 1.5 y 8.8 del Mapa Legal: usurpación de Institución de Crédito o reguladores
  /\binstituci[oó]n de cr[eé]dito\b/gi,
  /\bentidad bancaria autorizada\b/gi,
  /\binspector(?:es)? de profeco\b/gi,
  /\bauditor(?:es)? del sat\b/gi,
  /\bagente(?:s)? ministerial(?:es)?\b/gi,
  /\bfiscal[ií]a general\b/gi,
];

export const PATRONES_EXTORSION: RegExp[] = [
  /\b(?:tus|sus) contactos\b/gi,
  /\bcontactos? de referencia\b/gi,
  /\bfamiliares?\b/gi,
  /\b(?:tus|sus) (?:amigos|conocidos|vecinos)\b/gi,
  /\bdifundir(?:e|iremos|ir)?\b/gi,
  /\bhacemos saber a\b/gi,
  /\bmandaremos (?:el |la )?(?:nombre|cobranza)\b/gi,
  /\bcartel\b/gi,
  /\bpresionar(?:emos)?\b/gi,
  // Conductas 2.4 y 2.6 del Mapa Legal: boletines y exhibición en trabajo / redes
  /\bbolet[ií]n(?:es|ar|ado|aremos)?\b/gi,
  /\bficha de deudor\b/gi,
  /\blista negra\b/gi,
  /\b(?:tu|su) (?:trabajo|jefe|empleador)\b/gi,
  /\brecursos humanos\b/gi,
  /\bcompa[ñn]eros de trabajo\b/gi,
  /\bredes sociales\b/gi,
  /\bpublicar(?:emos)? en facebook\b/gi,
];

/** Conducta 3.1 del Mapa Legal: plantillas de smishing suplantando marcas. */
export const PATRONES_SMISHING: RegExp[] = [
  /\bppro\*microsoft\b/gi,
  /\bplatacard\s+retiro\b/gi,
  /\bcargo\s+no\s+reconocido\s+(?:microsoft|amazon|apple|netflix)\b/gi,
];

/** Conductas 3.5, 3.6 y 7.1 del Mapa Legal: desvío a cuentas personales / 2º nivel. */
export const PATRONES_DESVIO_PAGO: RegExp[] = [
  /\bdeposita(?:r)?\s+en\s+oxxo\b/gi,
  /\btarjeta\s+saldazo\b/gi,
  /\bspin\s+by\s+oxxo\b/gi,
  /\bcuenta\s+personal\b/gi,
  /\ba\s+nombre\s+del\s+(?:licenciado|ejecutivo|gestor|asesor)\b/gi,
  /\bfuera\s+de\s+la\s+app\b/gi,
];

export const URL_REGEX =
  /\b(?:(?:https?:\/\/|www\.)[^\s<>"']+|(?:bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rebrand\.ly|shorturl\.at)\/[a-zA-Z0-9_-]+)/gi;

export const CLABE_REGEX = /\b\d{16,18}\b/g;
const CLABE_SEPARADA_REGEX = /\b(?:\d[\s-]?){15,17}\d\b/g;

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

/** Elimina links cuyo dominio no esté en la allowlist y plantillas de smishing (regla 3.1). */
export function sanearLinks(texto: string, permitidos: string[]): ResultadoSaneo {
  const removidos: string[] = [];
  const sinSmishing = quitarSegmentos(texto, PATRONES_SMISHING);
  removidos.push(...sinSmishing.removidos);

  const limpio = sinSmishing.texto.replace(URL_REGEX, (url) => {
    const dominio = extraerDominios(url)[0] ?? '';
    if (esDominioPermitido(dominio, permitidos)) return url;
    removidos.push(`${dominio || url} → "${url}"`);
    return '';
  });
  return { texto: limpio.replace(/\s{2,}/g, ' ').trim(), removidos };
}

/**
 * Extrae números de cuenta/tarjeta/CLABE de 16 a 18 dígitos, incluso cuando el
 * operador los separa con espacios o guiones (`4152 3133 4455 6677`) para evadir el filtro.
 */
export function extraerClabes(texto: string): string[] {
  const directas = (texto.match(CLABE_REGEX) ?? []).filter((c) => c.length >= 16);
  const separadas = (texto.match(CLABE_SEPARADA_REGEX) ?? [])
    .map((m) => m.replace(/[\s-]/g, ''))
    .filter((c) => c.length >= 16 && c.length <= 18);
  return Array.from(new Set([...directas, ...separadas]));
}

export interface TasaMencionada {
  valorPct: number;
  esDiaria: boolean;
  textoOriginal: string;
}

/**
 * Extrae porcentajes de interés o mora mencionados en el texto
 * (ej. "mora del 3% diario", "interés de 25%").
 */
export function extraerTasasMentadas(texto: string): TasaMencionada[] {
  const regex = /(\d+(?:\.\d+)?)\s*%\s*(diario|por\s*d[ií]a|mensual|anual)?/gi;
  const tasas: TasaMencionada[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(texto)) !== null) {
    const valorPct = Number.parseFloat(match[1] ?? '0');
    if (Number.isNaN(valorPct) || valorPct <= 0) continue;
    const periodo = (match[2] ?? '').toLowerCase();
    tasas.push({
      valorPct,
      esDiaria: periodo.includes('diario') || periodo.includes('día') || periodo.includes('dia'),
      textoOriginal: match[0].trim(),
    });
  }
  return tasas;
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
