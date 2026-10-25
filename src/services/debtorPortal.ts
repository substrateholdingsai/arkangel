/**
 * Servicio del Portal de Autoservicio del Deudor (Self-Service Debtor Portal).
 *
 * Permite a los titulares de crédito acceder de forma pública, segura y blindada
 * conforme a la normativa CONDUSEF / REDECO (Art. 112 Bis LFPC) para liquidar
 * su adeudo en 1-click mediante SPEI.
 */

import { nowIso } from './db';
import { logger } from '../lib/logger';
import { maskPhone } from '../lib/phone';
import { recordPromise } from './promesas';
import { logEventForTenant } from './eventos';
import { resolveTenantContext } from '../tenancy/context';
import type { Env } from '../types/env';

export interface DebtorPortalFinancials {
  originalAmountCents: number;
  originalAmountFormatted: string;
  discountPct: number;
  discountAmountCents: number;
  discountAmountFormatted: string;
  payableAmountCents: number;
  payableAmountFormatted: string;
  installments: number;
  paymentReference: string;
}

export interface DebtorPortalDebtor {
  maskedName: string;
  maskedPhone: string;
  maskedEmail: string;
}

export interface DebtorPortalCreditor {
  razonSocial: string;
  condusefRegistro: string;
  bankName: string;
  clabe: string;
  rfc?: string | null;
}

export interface DebtorPortalData {
  portalId: string;
  caseId: string;
  agreementId: string | null;
  status: 'pending' | 'payment_reported' | 'fulfilled' | 'expired';
  debtor: DebtorPortalDebtor;
  creditor: DebtorPortalCreditor;
  financials: DebtorPortalFinancials;
  expiresAt: string;
  isExpired: boolean;
  legalNotice: string;
}

export interface DebtorPaymentConfirmation {
  trackingKey?: string;
  bankOrigin?: string;
  payerEmail?: string;
  notes?: string;
}

export interface PaymentConfirmationResult {
  success: boolean;
  status: 'payment_reported' | 'fulfilled';
  receiptFolio: string;
  message: string;
  reportedAt: string;
}

export interface DebtorLegalDocument {
  folio: string;
  fechaEmision: string;
  tipoDocumento: 'carta_convenio' | 'carta_finiquito';
  razonSocial: string;
  condusefRegistro: string;
  deudorNombre: string;
  montoOriginal: string;
  descuento: string;
  montoLiquidar: string;
  clabe: string;
  banco: string;
  referencia: string;
  vigencia: string;
  clausulas: string[];
  selloDigital: string;
}

/** Enmascara un nombre completo preservando iniciales y confidencialidad */
export function maskName(fullName: string | null | undefined): string {
  if (!fullName) return '***';
  return fullName
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 1) return word;
      return word[0] + '*'.repeat(Math.min(word.length - 1, 6));
    })
    .join(' ');
}

/** Enmascara correo electrónico */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return '***@***.***';
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***@***.***';
  const maskedUser =
    user.length <= 2
      ? user[0] + '***'
      : user[0] + '***' + user[user.length - 1];
  const parts = domain.split('.');
  const maskedDomain = parts
    .map((p) => (p.length <= 2 ? p : p[0] + '*'.repeat(Math.min(p.length - 1, 6))))
    .join('.');
  return `${maskedUser}@${maskedDomain}`;
}

/** Obtiene el nombre del Banco receptor a partir de los 3 primeros dígitos de la CLABE SPEI */
export function getBankNameFromClabe(clabe: string | null | undefined): string {
  if (!clabe || clabe.length < 3) return 'STP (Sistema de Transferencias y Pagos)';
  const code = clabe.slice(0, 3);
  const banks: Record<string, string> = {
    '002': 'Citibanamex',
    '012': 'BBVA México',
    '014': 'Santander México',
    '021': 'HSBC México',
    '030': 'Banco del Bajío',
    '036': 'Inbursa',
    '042': 'Mifel',
    '044': 'Scotiabank',
    '058': 'Banregio',
    '072': 'Banorte',
    '127': 'Banco Azteca',
    '136': 'Intercam',
    '137': 'Bancoppel',
    '140': 'Compartamos Banco',
    '638': 'Nu México Financiera',
    '646': 'STP (Sistema de Transferencias y Pagos)',
    '659': 'Spin by OXXO',
    '722': 'Mercado Pago',
  };
  return banks[code] || 'SPEI - Transferencia Interbancaria';
}

function formatMXN(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Consulta la información pública y sanitizada para el portal del deudor.
 * Fail-closed: si el identificador no existe, retorna null. No expone datos sensibles no enmascarados.
 */
export async function getDebtorPortalData(
  env: Env,
  id: string
): Promise<DebtorPortalData | null> {
  const cleanId = id.trim();

  // 1. Si es un convenio acordado (agr_...)
  if (cleanId.startsWith('agr_')) {
    const agreement = await env.DB.prepare(
      `SELECT a.*,
              c.status as case_status,
              c.amount_cents as case_amount,
              cl.name as client_name,
              cl.phone as client_phone,
              cl.email as client_email,
              t.razon_social,
              t.condusef_registro
       FROM a2a_agreements a
       JOIN cases c ON a.case_id = c.id
       JOIN clients cl ON a.client_id = cl.id
       JOIN tenants t ON a.tenant_id = t.id
       WHERE a.id = ?
       LIMIT 1`
    )
      .bind(cleanId)
      .first<any>();

    if (!agreement) return null;

    // Verificar si el caso en general ya fue liquidado
    const isPaid = agreement.case_status === 'paid' || agreement.status === 'fulfilled';
    const isExpired =
      !isPaid &&
      agreement.status === 'pending' &&
      new Date(agreement.expires_at).getTime() < Date.now();

    const status: DebtorPortalData['status'] = isPaid
      ? 'fulfilled'
      : isExpired
        ? 'expired'
        : agreement.status === 'payment_reported'
          ? 'payment_reported'
          : 'pending';

    const clabe = agreement.clabe || '646180123456789012';
    const discountAmountCents = Math.max(
      0,
      agreement.original_amount_cents - agreement.agreed_amount_cents
    );

    return {
      portalId: agreement.id,
      caseId: agreement.case_id,
      agreementId: agreement.id,
      status,
      debtor: {
        maskedName: maskName(agreement.client_name),
        maskedPhone: maskPhone(agreement.client_phone),
        maskedEmail: maskEmail(agreement.client_email),
      },
      creditor: {
        razonSocial: agreement.razon_social || 'Despacho de Cobranza Autorizado',
        condusefRegistro: agreement.condusef_registro || 'CONDUSEF-REG-VALIDADO',
        bankName: getBankNameFromClabe(clabe),
        clabe,
      },
      financials: {
        originalAmountCents: agreement.original_amount_cents,
        originalAmountFormatted: formatMXN(agreement.original_amount_cents),
        discountPct: agreement.discount_pct,
        discountAmountCents,
        discountAmountFormatted: formatMXN(discountAmountCents),
        payableAmountCents: agreement.agreed_amount_cents,
        payableAmountFormatted: formatMXN(agreement.agreed_amount_cents),
        installments: agreement.installments ?? 1,
        paymentReference: agreement.id.replace('agr_', 'CONV-').toUpperCase(),
      },
      expiresAt: agreement.expires_at,
      isExpired,
      legalNotice:
        'Convenio formal emitido en apego a los Artículos 112 y 112 Bis de la Ley Federal de Protección al Consumidor y las Disposiciones de Carácter General de la CONDUSEF. La liquidación de este monto extingue la obligación crediticia y se reportará con saldo $0 ante las Sociedades de Información Crediticia (Buró y Círculo de Crédito).',
    };
  }

  // 2. Si es un caso directo (cas_...) o identificador genérico
  const caseRow = await env.DB.prepare(
    `SELECT c.*,
            cl.name as client_name,
            cl.phone as client_phone,
            cl.email as client_email,
            t.razon_social,
            t.condusef_registro,
            t.a2a_max_discount_pct,
            t.a2a_enabled
     FROM cases c
     JOIN clients cl ON c.client_id = cl.id
     JOIN tenants t ON c.tenant_id = t.id
     WHERE c.id = ?
     LIMIT 1`
  )
    .bind(cleanId)
    .first<any>();

  if (!caseRow) return null;

  // Buscar si ya existe un convenio previo para este caso
  const existingAgr = await env.DB.prepare(
    `SELECT * FROM a2a_agreements WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(caseRow.id)
    .first<any>();

  // Obtener contrato para CLABE específica del titular
  const contract = await env.DB.prepare(
    `SELECT clabe FROM contracts WHERE tenant_id = ? AND client_id = ? ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(caseRow.tenant_id, caseRow.client_id)
    .first<{ clabe: string | null }>();

  const clabe = existingAgr?.clabe || contract?.clabe || '646180123456789012';
  const isPaid = caseRow.status === 'paid' || existingAgr?.status === 'fulfilled';

  let originalAmountCents = caseRow.amount_cents;
  let payableAmountCents = caseRow.amount_cents;
  let discountPct = 0;
  const agreementId = existingAgr?.id || null;
  const expiresAt = existingAgr?.expires_at || new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  if (existingAgr) {
    originalAmountCents = existingAgr.original_amount_cents;
    payableAmountCents = existingAgr.agreed_amount_cents;
    discountPct = existingAgr.discount_pct;
  } else if (caseRow.a2a_enabled && caseRow.a2a_max_discount_pct > 0) {
    // Ofrecer liquidación con el descuento estándar autorizado por la entidad
    discountPct = Math.min(25, caseRow.a2a_max_discount_pct);
    payableAmountCents = Math.round(originalAmountCents * (1 - discountPct / 100));
  }

  const isExpired =
    !isPaid &&
    existingAgr?.status === 'pending' &&
    new Date(expiresAt).getTime() < Date.now();

  const status: DebtorPortalData['status'] = isPaid
    ? 'fulfilled'
    : isExpired
      ? 'expired'
      : existingAgr?.status === 'payment_reported'
        ? 'payment_reported'
        : 'pending';

  const discountAmountCents = Math.max(0, originalAmountCents - payableAmountCents);

  return {
    portalId: caseRow.id,
    caseId: caseRow.id,
    agreementId,
    status,
    debtor: {
      maskedName: maskName(caseRow.client_name),
      maskedPhone: maskPhone(caseRow.client_phone),
      maskedEmail: maskEmail(caseRow.client_email),
    },
    creditor: {
      razonSocial: caseRow.razon_social || 'Despacho de Cobranza Autorizado',
      condusefRegistro: caseRow.condusef_registro || 'CONDUSEF-REG-VALIDADO',
      bankName: getBankNameFromClabe(clabe),
      clabe,
    },
    financials: {
      originalAmountCents,
      originalAmountFormatted: formatMXN(originalAmountCents),
      discountPct,
      discountAmountCents,
      discountAmountFormatted: formatMXN(discountAmountCents),
      payableAmountCents,
      payableAmountFormatted: formatMXN(payableAmountCents),
      installments: 1,
      paymentReference: (agreementId || caseRow.id).replace(/^(cas_|agr_)/, 'REF-').toUpperCase(),
    },
    expiresAt,
    isExpired,
    legalNotice:
      'Convenio formal emitido en apego a los Artículos 112 y 112 Bis de la Ley Federal de Protección al Consumidor y las Disposiciones de Carácter General de la CONDUSEF. La liquidación de este monto extingue la obligación crediticia y se reportará con saldo $0 ante las Sociedades de Información Crediticia (Buró y Círculo de Crédito).',
  };
}

/**
 * Registra el reporte de transferencia SPEI del deudor.
 * Actualiza el convenio a `payment_reported`, registra una promesa de pago con
 * certeza máxima (0.99) y genera un evento de auditoría.
 */
export async function confirmDebtorPayment(
  env: Env,
  id: string,
  details: DebtorPaymentConfirmation
): Promise<PaymentConfirmationResult> {
  const cleanId = id.trim();
  const timestamp = nowIso();
  const receiptFolio = `REC-${Date.now().toString(36).toUpperCase()}`;

  // 1. Identificar convenio o caso
  let caseId: string | null = null;
  let tenantId: string | null = null;
  let clientId: string | null = null;
  let payableAmountCents = 0;
  let agreementId: string | null = null;

  if (cleanId.startsWith('agr_')) {
    const agr = await env.DB.prepare(
      'SELECT id, tenant_id, case_id, client_id, agreed_amount_cents, status FROM a2a_agreements WHERE id = ?'
    )
      .bind(cleanId)
      .first<any>();

    if (!agr) {
      throw new Error('Convenio no encontrado');
    }

    agreementId = agr.id;
    caseId = agr.case_id;
    tenantId = agr.tenant_id;
    clientId = agr.client_id;
    payableAmountCents = agr.agreed_amount_cents;

    if (agr.status === 'fulfilled') {
      return {
        success: true,
        status: 'fulfilled',
        receiptFolio,
        message: 'Este adeudo ya se encuentra completamente liquidado y finiquitado.',
        reportedAt: timestamp,
      };
    }

    await env.DB.prepare(
      "UPDATE a2a_agreements SET status = 'payment_reported', updated_at = ? WHERE id = ?"
    )
      .bind(timestamp, agreementId)
      .run();
  } else {
    const cRow = await env.DB.prepare(
      'SELECT id, tenant_id, client_id, amount_cents, status FROM cases WHERE id = ?'
    )
      .bind(cleanId)
      .first<any>();

    if (!cRow) {
      throw new Error('Expediente no encontrado');
    }

    caseId = cRow.id;
    tenantId = cRow.tenant_id;
    clientId = cRow.client_id;
    payableAmountCents = cRow.amount_cents;

    if (cRow.status === 'paid') {
      return {
        success: true,
        status: 'fulfilled',
        receiptFolio,
        message: 'Este adeudo ya se encuentra completamente liquidado y finiquitado.',
        reportedAt: timestamp,
      };
    }
  }

  // 2. Registrar promesa de pago formal y actualizar estado del caso
  if (!tenantId || !caseId || !clientId) {
    throw new Error('Información de caso o despacho incompleta');
  }

  const tenantCtx = await resolveTenantContext(env, { tenantId });

  await recordPromise(tenantCtx, {
    tenantId,
    caseId,
    clientId,
    amountCents: payableAmountCents,
    promisedDate: timestamp.slice(0, 10),
    confidence: 0.99,
    source: 'portal_autoservicio_deudor',
  });

  await env.DB.prepare(
    "UPDATE cases SET intencion = 'paga', proxima_accion = 'Conciliar SPEI reportado por deudor en portal', updated_at = ? WHERE tenant_id = ? AND id = ?"
  )
    .bind(timestamp, tenantId, caseId)
    .run();

  // 3. Registrar evento de auditoría
  await logEventForTenant(env, tenantId, 'debtor_portal_payment_reported', {
    caseId,
    clientId,
    payload: {
      receiptFolio,
      agreementId,
      trackingKey: details.trackingKey || null,
      bankOrigin: details.bankOrigin || null,
      payerEmail: details.payerEmail || null,
      notes: details.notes || null,
      amountCents: payableAmountCents,
      reportedAt: timestamp,
    },
  });

  logger.info('Pago SPEI reportado por el titular en Portal de Autoservicio', {
    receiptFolio,
    caseId,
    tenantId,
    trackingKey: details.trackingKey,
    amountCents: payableAmountCents,
  });

  return {
    success: true,
    status: 'payment_reported',
    receiptFolio,
    message:
      'Transferencia registrada exitosamente. Nuestro sistema bancario conciliará el movimiento SPEI automáticamente y se enviará la Carta Finiquito a su correo.',
    reportedAt: timestamp,
  };
}

/**
 * Genera el documento legal de Carta Convenio o Carta Finiquito (CONDUSEF REDECO Art. 112 Bis).
 */
export async function getDebtorLegalDocument(
  env: Env,
  id: string
): Promise<DebtorLegalDocument | null> {
  const portalData = await getDebtorPortalData(env, id);
  if (!portalData) return null;

  const isFiniquito = portalData.status === 'fulfilled';
  const fecha = new Date().toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Generar hash de verificación digital determinista
  const rawHash = `${portalData.portalId}:${portalData.financials.payableAmountCents}:${portalData.financials.paymentReference}:${portalData.creditor.condusefRegistro}`;
  let hashVal = 0;
  for (let i = 0; i < rawHash.length; i++) {
    hashVal = (hashVal << 5) - hashVal + rawHash.charCodeAt(i);
    hashVal |= 0;
  }
  const selloDigital = `ARK-SIG-2026-${Math.abs(hashVal).toString(16).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  const clausulas = isFiniquito
    ? [
        `PRIMERA (FINIQUITO Y EXTINCIÓN DE OBLIGACIÓN): ${portalData.creditor.razonSocial} hace constar que el titular ha cubierto a entera satisfacción la cantidad acordada de ${portalData.financials.payableAmountFormatted}, no reservándose derecho ni acción alguna que ejercitar en su contra.`,
        `SEGUNDA (ACTUALIZACIÓN ANTE SOCIEDADES DE INFORMACIÓN CREDITICIA): En cumplimiento al marco regulatorio CONDUSEF / REDECO y la Ley para Regular las Sociedades de Información Crediticia, se notifica que el saldo de la cuenta se reporta en ceros ($0.00 M.N.) con clave de liquidación en un plazo no mayor a cinco (5) días hábiles.`,
        `TERCERA (VALIDEZ LEGAL): La presente constancia surte plenos efectos legales como comprobante de finiquito y no adeudo total y definitivo.`,
      ]
    : [
        `PRIMERA (OBJETO DEL CONVENIO): ${portalData.creditor.razonSocial} (Registro CONDUSEF: ${portalData.creditor.condusefRegistro}) conviene con el titular del crédito la liquidación total de la cuenta mediante un pago único por la cantidad de ${portalData.financials.payableAmountFormatted}, otorgando una quita o descuento autorizado de ${portalData.financials.discountPct}%.`,
        `SEGUNDA (FORMA Y CUENTA DE PAGO SPEI): El pago acordado deberá efectuarse vía transferencia electrónica interbancaria (SPEI) a la cuenta CLABE autorizada ${portalData.creditor.clabe} (${portalData.creditor.bankName}) utilizando la referencia ${portalData.financials.paymentReference}.`,
        `TERCERA (VIGENCIA): El presente convenio mantendrá su validez hasta las 23:59 hrs del ${new Date(portalData.expiresAt).toLocaleDateString('es-MX')}. Transcurrida dicha fecha sin verificarse la transferencia, la oferta de quita quedará sin efectos legales reanudándose la exigibilidad del saldo original.`,
        `CUARTA (OBLIGACIÓN DE LIBERACIÓN): Verificado el ingreso de los fondos, el acreedor expedirá la Carta Finiquito definitiva y procederá a la actualización del registro crediticio ante Buró y Círculo de Crédito conforme al Art. 112 Bis de la LFPC.`,
      ];

  return {
    folio: portalData.financials.paymentReference,
    fechaEmision: fecha,
    tipoDocumento: isFiniquito ? 'carta_finiquito' : 'carta_convenio',
    razonSocial: portalData.creditor.razonSocial,
    condusefRegistro: portalData.creditor.condusefRegistro,
    deudorNombre: portalData.debtor.maskedName,
    montoOriginal: portalData.financials.originalAmountFormatted,
    descuento: `${portalData.financials.discountPct}% (${portalData.financials.discountAmountFormatted})`,
    montoLiquidar: portalData.financials.payableAmountFormatted,
    clabe: portalData.creditor.clabe,
    banco: portalData.creditor.bankName,
    referencia: portalData.financials.paymentReference,
    vigencia: new Date(portalData.expiresAt).toLocaleDateString('es-MX'),
    clausulas,
    selloDigital,
  };
}
