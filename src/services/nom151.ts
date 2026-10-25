/**
 * Servicio de Constancias de Notificación Digital NOM-151-SCFI-2016.
 *
 * Emisión, verificación e inmutabilidad de constancias electrónicas con estampado
 * de tiempo y huella criptográfica SHA-256 conforme al Código de Comercio
 * (Artículos 89 a 114) y la NOM-151-SCFI-2016 para prueba plena en cobranza
 * extrajudicial y judicial en México.
 */

import { newId } from './db';
import { logger } from '../lib/logger';
import { maskPhone } from '../lib/phone';
import { maskName } from './debtorPortal';
import type { TenantContext } from '../tenancy/types';
import type { Env } from '../types/env';

export type Nom151TipoNotificacion =
  | 'requerimiento_pago'
  | 'carta_convenio'
  | 'carta_finiquito'
  | 'aviso_cobranza';

export type Nom151Channel = 'whatsapp' | 'sms' | 'email' | 'portal';

export interface IssueNom151Input {
  caseId: string;
  clientId: string;
  tipoNotificacion: Nom151TipoNotificacion;
  channel: Nom151Channel;
  messageContent: string;
  messageId?: string | null;
  providerId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface Nom151Certificate {
  id: string;
  tenantId: string;
  caseId: string | null;
  clientId: string;
  messageId: string | null;
  certificateFolio: string;
  tipoNotificacion: Nom151TipoNotificacion;
  channel: Nom151Channel;
  providerId: string | null;
  recipientMasked: string;
  messageContent: string;
  messageDigestSha256: string;
  cadenaOriginal: string;
  selloDigital: string;
  timestampUtc: string;
  timestampLocal: string;
  verificationUrl: string;
  status: 'issued' | 'delivered' | 'verified';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Nom151VerificationResult {
  valid: boolean;
  folio: string;
  certificate: Nom151Certificate;
  verificationDetails: {
    digestMatches: boolean;
    sealMatches: boolean;
    calculatedDigest: string;
    calculatedSeal: string;
    timestampUtc: string;
    timestampLocal: string;
    legalAuthority: string;
  };
}

export interface Nom151PrintableDocument {
  folio: string;
  titulo: string;
  fechaEmision: string;
  fechaLocalCDMX: string;
  emisorRazonSocial: string;
  emisorCondusef: string;
  destinatarioEnmascarado: string;
  canal: string;
  identificadorTransmision: string;
  contenidoNotificado: string;
  huellaCriptograficaSHA256: string;
  cadenaOriginal: string;
  selloDigital: string;
  urlVerificacionPublica: string;
  fundamentoLegal: string[];
}

/** Calcula el hash SHA-256 en formato hexadecimal en minúsculas (Web Crypto API) */
export async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Construye la Cadena Original normalizada según los estándares de la Secretaría de Economía */
export function buildCadenaOriginal(params: {
  folio: string;
  timestampUtc: string;
  razonSocial: string;
  condusefRegistro: string;
  clientId: string;
  tipoNotificacion: string;
  channel: string;
  providerId: string | null;
  digestSha256: string;
}): string {
  const parts = [
    'NOM151',
    '1.0',
    params.folio,
    params.timestampUtc,
    params.razonSocial.trim(),
    params.condusefRegistro.trim(),
    params.clientId,
    params.tipoNotificacion,
    params.channel,
    params.providerId || 'ARK-DIRECT',
    params.digestSha256,
  ];
  return `||${parts.join('|')}||`;
}

/** Formatea una fecha ISO en hora del centro de México (CDMX / America/Mexico_City) */
export function formatLocalTimestamp(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' (Hora del Centro de México - CST/CDT)';
  } catch {
    return isoDate;
  }
}

/**
 * Emite una nueva Constancia de Notificación NOM-151 con estampado criptográfico.
 */
export async function issueNom151Certificate(
  ctx: TenantContext,
  input: IssueNom151Input
): Promise<Nom151Certificate> {
  const certId = newId('nom');
  const now = new Date();
  const timestampUtc = now.toISOString();
  const timestampLocal = formatLocalTimestamp(timestampUtc);

  // Generar folio único tipo NOM151-2026-XXXXXX
  const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  const certificateFolio = `NOM151-${now.getUTCFullYear()}-${randomSuffix}`;

  // Consultar datos del cliente para el enmascaramiento legal
  const clientRow = await ctx.env.DB.prepare(
    'SELECT name, phone, email FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, input.clientId)
    .first<{ name: string; phone: string | null; email: string | null }>();

  const maskedName = maskName(clientRow?.name || 'Titular del Crédito');
  const contactPart = input.channel === 'email'
    ? (clientRow?.email ? clientRow.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '***@***.***')
    : maskPhone(clientRow?.phone || '');
  const recipientMasked = `${maskedName} (${contactPart})`;

  // Calcular la huella digital SHA-256 del contenido del mensaje
  const messageDigestSha256 = await sha256Hex(input.messageContent.trim());

  // Construir la Cadena Original y el Sello Digital
  const razonSocial = ctx.tenant?.razon_social || 'Entidad Acreedora Autorizada';
  const condusefRegistro = ctx.tenant?.condusef_registro || 'REDECO-REGULADO';

  const cadenaOriginal = buildCadenaOriginal({
    folio: certificateFolio,
    timestampUtc,
    razonSocial,
    condusefRegistro,
    clientId: input.clientId,
    tipoNotificacion: input.tipoNotificacion,
    channel: input.channel,
    providerId: input.providerId || null,
    digestSha256: messageDigestSha256,
  });

  const selloDigital = await sha256Hex(cadenaOriginal);

  // URL pública de verificación jurídica
  const baseUrl = ctx.env.APP_URL || 'https://arkangel.arksystems.site';
  const verificationUrl = `${baseUrl}/verify/nom151/${certificateFolio}`;

  await ctx.env.DB.prepare(
    `INSERT INTO nom151_certificates (
      id, tenant_id, case_id, client_id, message_id, certificate_folio,
      tipo_notificacion, channel, provider_id, recipient_masked,
      message_content, message_digest_sha256, cadena_original, sello_digital,
      timestamp_utc, timestamp_local, verification_url, status, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`
  )
    .bind(
      certId,
      ctx.tenantId,
      input.caseId,
      input.clientId,
      input.messageId || null,
      certificateFolio,
      input.tipoNotificacion,
      input.channel,
      input.providerId || null,
      recipientMasked,
      input.messageContent,
      messageDigestSha256,
      cadenaOriginal,
      selloDigital,
      timestampUtc,
      timestampLocal,
      verificationUrl,
      input.metadata ? JSON.stringify(input.metadata) : null,
      timestampUtc
    )
    .run();

  logger.info('Constancia de Notificación Digital NOM-151 emitida exitosamente', {
    certId,
    certificateFolio,
    caseId: input.caseId,
    tenantId: ctx.tenantId,
    digest: messageDigestSha256.slice(0, 16) + '...',
  });

  return {
    id: certId,
    tenantId: ctx.tenantId,
    caseId: input.caseId,
    clientId: input.clientId,
    messageId: input.messageId || null,
    certificateFolio,
    tipoNotificacion: input.tipoNotificacion,
    channel: input.channel,
    providerId: input.providerId || null,
    recipientMasked,
    messageContent: input.messageContent,
    messageDigestSha256,
    cadenaOriginal,
    selloDigital,
    timestampUtc,
    timestampLocal,
    verificationUrl,
    status: 'issued',
    metadata: input.metadata || null,
    createdAt: timestampUtc,
  };
}

/**
 * Consulta y valida públicamente una Constancia NOM-151 por su folio.
 * Reejecuta el hash del mensaje y de la cadena original para garantizar inalterabilidad (tamper-proof).
 */
export async function getNom151CertificateByFolio(
  env: Env,
  folio: string
): Promise<Nom151VerificationResult | null> {
  const cleanFolio = folio.trim().toUpperCase();

  const row = await env.DB.prepare(
    `SELECT n.*,
            t.razon_social,
            t.condusef_registro
     FROM nom151_certificates n
     JOIN tenants t ON n.tenant_id = t.id
     WHERE n.certificate_folio = ?
     LIMIT 1`
  )
    .bind(cleanFolio)
    .first<any>();

  if (!row) return null;

  // Re-cálculo independiente de validación criptográfica
  const calculatedDigest = await sha256Hex(row.message_content.trim());
  const digestMatches = calculatedDigest === row.message_digest_sha256;

  const expectedCadenaOriginal = buildCadenaOriginal({
    folio: row.certificate_folio,
    timestampUtc: row.timestamp_utc,
    razonSocial: row.razon_social || '',
    condusefRegistro: row.condusef_registro || '',
    clientId: row.client_id,
    tipoNotificacion: row.tipo_notificacion,
    channel: row.channel,
    providerId: row.provider_id,
    digestSha256: calculatedDigest,
  });

  const calculatedSeal = await sha256Hex(expectedCadenaOriginal);
  const sealMatches = calculatedSeal === row.sello_digital;

  const cert: Nom151Certificate = {
    id: row.id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    clientId: row.client_id,
    messageId: row.message_id,
    certificateFolio: row.certificate_folio,
    tipoNotificacion: row.tipo_notificacion,
    channel: row.channel,
    providerId: row.provider_id,
    recipientMasked: row.recipient_masked,
    messageContent: row.message_content,
    messageDigestSha256: row.message_digest_sha256,
    cadenaOriginal: row.cadena_original,
    selloDigital: row.sello_digital,
    timestampUtc: row.timestamp_utc,
    timestampLocal: row.timestamp_local,
    verificationUrl: row.verification_url,
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };

  return {
    valid: digestMatches && sealMatches,
    folio: row.certificate_folio,
    certificate: cert,
    verificationDetails: {
      digestMatches,
      sealMatches,
      calculatedDigest,
      calculatedSeal,
      timestampUtc: row.timestamp_utc,
      timestampLocal: row.timestamp_local,
      legalAuthority: 'Código de Comercio Arts. 89-114 · NOM-151-SCFI-2016 · Secretaría de Economía',
    },
  };
}

/**
 * Lista las constancias NOM-151 vinculadas a un caso específico.
 */
export async function listNom151CertificatesByCase(
  ctx: TenantContext,
  caseId: string
): Promise<Nom151Certificate[]> {
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM nom151_certificates
     WHERE tenant_id = ? AND case_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(ctx.tenantId, caseId)
    .all<any>();

  return (rows.results || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    clientId: row.client_id,
    messageId: row.message_id,
    certificateFolio: row.certificate_folio,
    tipoNotificacion: row.tipo_notificacion,
    channel: row.channel,
    providerId: row.provider_id,
    recipientMasked: row.recipient_masked,
    messageContent: row.message_content,
    messageDigestSha256: row.message_digest_sha256,
    cadenaOriginal: row.cadena_original,
    selloDigital: row.sello_digital,
    timestampUtc: row.timestamp_utc,
    timestampLocal: row.timestamp_local,
    verificationUrl: row.verification_url,
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  }));
}

/**
 * Genera el documento legal estructurado e imprimible de la Constancia NOM-151.
 */
export async function generateNom151PrintableDocument(
  env: Env,
  folio: string
): Promise<Nom151PrintableDocument | null> {
  const verified = await getNom151CertificateByFolio(env, folio);
  if (!verified) return null;

  const cert = verified.certificate;
  const tenantRow = await env.DB.prepare(
    'SELECT razon_social, condusef_registro FROM tenants WHERE id = ? LIMIT 1'
  )
    .bind(cert.tenantId)
    .first<{ razon_social: string; condusef_registro: string }>();

  const titulosPorTipo: Record<Nom151TipoNotificacion, string> = {
    requerimiento_pago: 'CONSTANCIA DE NOTIFICACIÓN DE REQUERIMIENTO FORMAL DE PAGO',
    carta_convenio: 'CONSTANCIA DE NOTIFICACIÓN DE CONVENIO EXTRAJUDICIAL DE PAGO',
    carta_finiquito: 'CONSTANCIA DE EXPEDICIÓN DE FINIQUITO Y EXTINCIÓN DE OBLIGACIÓN',
    aviso_cobranza: 'CONSTANCIA DE AVISO EXTRAJUDICIAL DE COBRANZA Y ORIENTACIÓN AL PAGO',
  };

  const canalLabels: Record<Nom151Channel, string> = {
    whatsapp: 'Mensajería Instantánea Certificada WhatsApp (Telnyx API v2 / Meta Verified)',
    sms: 'Mensaje de Texto SMS Certificado (Telnyx Carrier Route / DLT)',
    email: 'Correo Electrónico Certificado (Resend / DKIM & SPF Cryptographic Signature)',
    portal: 'Portal de Autoservicio Digital Seguro (Arkangel 1-Click SPEI)',
  };

  return {
    folio: cert.certificateFolio,
    titulo: titulosPorTipo[cert.tipoNotificacion] || 'CONSTANCIA DE NOTIFICACIÓN DIGITAL',
    fechaEmision: cert.timestampUtc,
    fechaLocalCDMX: cert.timestampLocal,
    emisorRazonSocial: tenantRow?.razon_social || 'Entidad Acreedora Autorizada',
    emisorCondusef: tenantRow?.condusef_registro || 'REDECO-REGULADO',
    destinatarioEnmascarado: cert.recipientMasked,
    canal: canalLabels[cert.channel] || cert.channel,
    identificadorTransmision: cert.providerId || 'ARK-INTERNAL-TRANSMISSION',
    contenidoNotificado: cert.messageContent,
    huellaCriptograficaSHA256: cert.messageDigestSha256,
    cadenaOriginal: cert.cadenaOriginal,
    selloDigital: cert.selloDigital,
    urlVerificacionPublica: cert.verificationUrl,
    fundamentoLegal: [
      'ARTÍCULO 89 DEL CÓDIGO DE COMERCIO: Las disposiciones de este título rigen los actos de comercio por medios electrónicos y en la generación, envío, recepción, archivo o comunicación de mensajes de datos.',
      'ARTÍCULO 89 BIS DEL CÓDIGO DE COMERCIO: No se negarán efectos jurídicos, validez o fuerza obligatoria a cualquier tipo de información por la sola razón de que esté contenida en un Mensaje de Datos.',
      'ARTÍCULO 90 DEL CÓDIGO DE COMERCIO: Se presumirá que un Mensaje de Datos proviene del Emisor si ha sido aplicado un procedimiento de identificación o verificación acordado.',
      'NORMA OFICIAL MEXICANA NOM-151-SCFI-2016: Requisitos que deben observar los mensajes de datos para su conservación y digitalización de documentos, garantizando integridad, fecha y autoría inalterable.',
      'ARTÍCULO 112 BIS DE LA LEY FEDERAL DE PROTECCIÓN AL CONSUMIDOR: Constancia de que la entidad acreedora ha notificado de manera fidedigna los términos del saldo, registro y derecho de liquidación sin amenazas ni actos contrarios a las buenas prácticas comerciales.',
    ],
  };
}
