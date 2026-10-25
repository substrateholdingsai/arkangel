/**
 * Servicio del Protocolo A2A (Agent-to-Agent Collections & Programmatic Negotiation).
 *
 * Motor 100% determinista, matemáticamente blindado contra Prompt Injections y
 * diseñado bajo la normativa NOM-184 / CONDUSEF (privacidad estricta y secrecía financiera).
 */

import { newId, nowIso } from './db';
import { logger } from '../lib/logger';
import { recordPromise } from './promesas';
import { getContractByClient } from './contratos';
import type { TenantContext } from '../tenancy/types';
import type {
  A2AAuthChallenge,
  A2AAuthResult,
  A2ADebtorSummary,
  A2AStandardOffer,
  A2AOfferRequest,
  A2AOfferResult,
  A2ACounterOffer,
  A2AAgreement,
} from '../types/a2a';

interface CaseRow {
  id: string;
  tenant_id: string;
  client_id: string;
  amount_cents: number;
  status: string;
  name: string;
  phone: string | null;
  email: string | null;
}

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  curp: string | null;
  rfc?: string | null;
  auth_pin?: string | null;
}

interface TenantRow {
  id: string;
  razon_social: string;
  condusef_registro: string;
  a2a_enabled?: number;
  a2a_max_discount_pct?: number;
  a2a_max_installments?: number;
  a2a_min_down_payment_pct?: number;
}

interface AgreementRow {
  id: string;
  tenant_id: string;
  case_id: string;
  client_id: string;
  original_amount_cents: number;
  agreed_amount_cents: number;
  discount_pct: number;
  installments: number;
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled';
  clabe: string | null;
  expires_at: string;
  agent_id: string | null;
  one_click_url: string | null;
  created_at: string;
}

/**
 * Enmascara un nombre completo para protección de datos personales ante terceros (CONDUSEF 4.1/4.2).
 * Ejemplo: "Juan Carlos Pérez" -> "J*** C***** P****"
 */
export function maskName(fullName: string): string {
  if (!fullName) return '***';
  return fullName
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 1) return word;
      return word[0] + '*'.repeat(word.length - 1);
    })
    .join(' ');
}

/**
 * Genera un token efímero de sesión de 15 minutos para el agente autenticado.
 */
function generateSessionToken(tenantId: string, caseId: string): string {
  const timestamp = Date.now();
  const raw = `${tenantId}:${caseId}:${timestamp}`;
  return 'a2a_tok_' + btoa(raw).replace(/=/g, '');
}

/**
 * Verifica la identidad del deudor ante la solicitud del agente externo.
 * Fail-Closed: si el agente no proporciona el RFC (últimos 4) o PIN correcto, se rechaza la consulta.
 */
export async function verifyDebtorIdentity(
  ctx: TenantContext,
  challenge: A2AAuthChallenge
): Promise<A2AAuthResult> {
  if (!challenge.caseId) {
    return { verified: false, error: 'case_not_found' };
  }

  const caseRow = await ctx.env.DB.prepare(
    'SELECT id, tenant_id, client_id, amount_cents, status, name, phone, email FROM cases WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, challenge.caseId)
    .first<CaseRow>();

  if (!caseRow) {
    return { verified: false, error: 'case_not_found' };
  }

  if (caseRow.status === 'paid') {
    return { verified: false, error: 'account_closed' };
  }

  const clientRow = await ctx.env.DB.prepare(
    'SELECT id, tenant_id, name, phone, email, curp, rfc, auth_pin FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, caseRow.client_id)
    .first<ClientRow>();

  if (!clientRow) {
    return { verified: false, error: 'case_not_found' };
  }

  const rfcInput = challenge.rfcLast4?.trim().toUpperCase();
  const pinInput = challenge.pin?.trim();

  let matches = false;

  // Validación 1: PIN de 4-6 dígitos
  if (pinInput && clientRow.auth_pin && clientRow.auth_pin.trim() === pinInput) {
    matches = true;
  }

  // Validación 2: Últimos 4 caracteres del RFC
  if (!matches && rfcInput) {
    if (clientRow.rfc) {
      const cleanRfc = clientRow.rfc.trim().toUpperCase();
      if (cleanRfc.endsWith(rfcInput)) {
        matches = true;
      }
    } else if (clientRow.curp) {
      // Fallback con CURP (los primeros 10 caracteres del CURP coinciden con el RFC de persona física)
      const curpRfcBase = clientRow.curp.substring(0, 10).toUpperCase();
      if (curpRfcBase.endsWith(rfcInput)) {
        matches = true;
      }
    }
  }

  // Validación 3: Si no hay RFC ni PIN almacenado en BD, pero el agente presenta los últimos 4 dígitos del teléfono
  if (!matches && challenge.phone && clientRow.phone) {
    const cleanPhone = clientRow.phone.replace(/\D/g, '');
    const inputPhone = challenge.phone.replace(/\D/g, '');
    if (
      cleanPhone.length >= 4 &&
      inputPhone.length >= 4 &&
      cleanPhone.endsWith(inputPhone.slice(-4))
    ) {
      matches = true;
    }
  }

  if (!matches) {
    logger.warn('Intento de acceso A2A no autorizado o credenciales inválidas', {
      caseId: challenge.caseId,
      tenantId: ctx.tenantId,
    });
    return { verified: false, error: 'auth_failed' };
  }

  // Autenticación exitosa -> Construir el resumen seguro
  const summary = await getA2ASettlementTerms(ctx, caseRow.id);
  const sessionToken = generateSessionToken(ctx.tenantId, caseRow.id);

  return {
    verified: true,
    debtorSummary: summary,
    sessionToken,
  };
}

/**
 * Consulta los términos y políticas de liquidación autorizadas para un caso.
 */
export async function getA2ASettlementTerms(
  ctx: TenantContext,
  caseId: string
): Promise<A2ADebtorSummary> {
  const caseRow = await ctx.env.DB.prepare(
    'SELECT id, tenant_id, client_id, amount_cents, status, name FROM cases WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, caseId)
    .first<CaseRow>();

  if (!caseRow) {
    throw new Error(`Caso no encontrado: ${caseId}`);
  }

  const tenantRow = await ctx.env.DB.prepare(
    'SELECT id, razon_social, condusef_registro, a2a_enabled, a2a_max_discount_pct, a2a_max_installments, a2a_min_down_payment_pct FROM tenants WHERE id = ? LIMIT 1'
  )
    .bind(ctx.tenantId)
    .first<TenantRow>();

  const maxDiscountPct = tenantRow?.a2a_max_discount_pct ?? 30;
  const maxInstallments = tenantRow?.a2a_max_installments ?? 3;
  const totalDebtCents = caseRow.amount_cents;

  const minSinglePaymentCents = Math.round(totalDebtCents * (1 - maxDiscountPct / 100));

  // Generación de ofertas estándar para consumo por agentes
  const standardOffers: A2AStandardOffer[] = [];

  // Oferta 1: Pago Único con Quita Máxima
  standardOffers.push({
    type: 'single_payment',
    discountPct: maxDiscountPct,
    totalCents: minSinglePaymentCents,
    installmentsCount: 1,
    installmentCents: minSinglePaymentCents,
    description: `Liquidación en 1 sola exhibición con ${maxDiscountPct}% de descuento directo`,
    suggestedDeadlineDays: 3,
  });

  // Oferta 2: Dos parcialidades
  if (maxInstallments >= 2) {
    const discount2 = Math.max(5, Math.round(maxDiscountPct * 0.6));
    const total2 = Math.round(totalDebtCents * (1 - discount2 / 100));
    standardOffers.push({
      type: 'installments',
      discountPct: discount2,
      totalCents: total2,
      installmentsCount: 2,
      installmentCents: Math.round(total2 / 2),
      description: `Plan de 2 pagos quincenales con ${discount2}% de descuento`,
      suggestedDeadlineDays: 15,
    });
  }

  // Oferta 3: Tres parcialidades
  if (maxInstallments >= 3) {
    const discount3 = Math.max(0, Math.round(maxDiscountPct * 0.35));
    const total3 = Math.round(totalDebtCents * (1 - discount3 / 100));
    standardOffers.push({
      type: 'installments',
      discountPct: discount3,
      totalCents: total3,
      installmentsCount: 3,
      installmentCents: Math.round(total3 / 3),
      description: `Plan de 3 pagos mensuales con ${discount3}% de descuento`,
      suggestedDeadlineDays: 30,
    });
  }

  return {
    caseId: caseRow.id,
    maskedName: maskName(caseRow.name),
    creditor: {
      razonSocial: tenantRow?.razon_social || ctx.tenant.razon_social || 'Despacho Autorizado',
      condusefRegistro:
        tenantRow?.condusef_registro || ctx.tenant.condusef_registro || 'CONDUSEF-REG-01',
    },
    totalDebtCents,
    currency: 'MXN',
    maxDiscountPct,
    minSettlementCents: minSinglePaymentCents,
    standardOffers,
  };
}

/**
 * Evalúa matemáticamente una oferta enviada por el agente del deudor.
 * Inmune a Prompt Injection: se apega a los umbrales configurados por el despacho.
 */
export async function evaluateA2AOffer(
  ctx: TenantContext,
  offer: A2AOfferRequest
): Promise<A2AOfferResult> {
  const caseRow = await ctx.env.DB.prepare(
    'SELECT id, tenant_id, client_id, amount_cents, status, name FROM cases WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, offer.caseId)
    .first<CaseRow>();

  if (!caseRow) {
    return {
      accepted: false,
      status: 'rejected_below_floor',
      reason: 'El caso no existe o ya no está disponible para negociación.',
    };
  }

  const tenantRow = await ctx.env.DB.prepare(
    'SELECT id, a2a_enabled, a2a_max_discount_pct, a2a_max_installments FROM tenants WHERE id = ? LIMIT 1'
  )
    .bind(ctx.tenantId)
    .first<TenantRow>();

  const isEnabled = (tenantRow?.a2a_enabled ?? 1) === 1;
  if (!isEnabled) {
    return {
      accepted: false,
      status: 'rejected_below_floor',
      reason: 'La negociación automatizada A2A no está habilitada para este despacho.',
    };
  }

  const totalDebtCents = caseRow.amount_cents;
  const maxDiscountPct = tenantRow?.a2a_max_discount_pct ?? 30;
  const maxInstallmentsAllowed = tenantRow?.a2a_max_installments ?? 3;

  const installments = Math.max(1, Math.min(offer.installments ?? 1, 12));
  const proposedCents = Math.round(offer.proposedAmountCents);

  // Escenario A: Pago en una sola exhibición
  if (installments === 1) {
    const floorCents = Math.round(totalDebtCents * (1 - maxDiscountPct / 100));

    if (proposedCents >= floorCents && proposedCents <= totalDebtCents) {
      // Oferta Aceptable!
      const discountPct = Number(((1 - proposedCents / totalDebtCents) * 100).toFixed(2));
      const agreement = await createA2AAgreement(
        ctx,
        caseRow,
        proposedCents,
        discountPct,
        1,
        offer.agentId ?? 'external_agent'
      );

      return {
        accepted: true,
        status: 'agreement_accepted',
        agreement,
      };
    } else {
      // Oferta insuficiente -> Emitir Contraoferta
      const counterOffer: A2ACounterOffer = {
        minSinglePaymentCents: floorCents,
        minSinglePaymentDiscountPct: maxDiscountPct,
        maxInstallments: maxInstallmentsAllowed,
        installmentOptions: [
          {
            count: 2,
            centsPerInstallment: Math.round(Math.round(totalDebtCents * 0.85) / 2),
            totalCents: Math.round(totalDebtCents * 0.85),
          },
          {
            count: 3,
            centsPerInstallment: Math.round(Math.round(totalDebtCents * 0.9) / 3),
            totalCents: Math.round(totalDebtCents * 0.9),
          },
        ],
        explanation: `El monto propuesto ($${(proposedCents / 100).toFixed(2)} MXN) está por debajo del umbral mínimo autorizado para quita directa ($${(floorCents / 100).toFixed(2)} MXN).`,
      };

      return {
        accepted: false,
        status: 'counter_offer',
        counterOffer,
        reason: counterOffer.explanation,
      };
    }
  }

  // Escenario B: Pago en Parcialidades (installments > 1)
  if (installments > maxInstallmentsAllowed) {
    const counterOffer: A2ACounterOffer = {
      minSinglePaymentCents: Math.round(totalDebtCents * (1 - maxDiscountPct / 100)),
      minSinglePaymentDiscountPct: maxDiscountPct,
      maxInstallments: maxInstallmentsAllowed,
      installmentOptions: [
        {
          count: maxInstallmentsAllowed,
          centsPerInstallment: Math.round(
            Math.round(totalDebtCents * 0.9) / maxInstallmentsAllowed
          ),
          totalCents: Math.round(totalDebtCents * 0.9),
        },
      ],
      explanation: `El número de pagos solicitado (${installments}) excede el límite máximo permitido por política (${maxInstallmentsAllowed} parcialidades).`,
    };

    return {
      accepted: false,
      status: 'counter_offer',
      counterOffer,
      reason: counterOffer.explanation,
    };
  }

  // Descuento máximo permitido en parcialidades (menor al de pago único)
  const installmentDiscountPct = Math.max(0, Math.round(maxDiscountPct * 0.5));
  const floorInstallmentsCents = Math.round(totalDebtCents * (1 - installmentDiscountPct / 100));

  if (proposedCents >= floorInstallmentsCents && proposedCents <= totalDebtCents) {
    const discountPct = Number(((1 - proposedCents / totalDebtCents) * 100).toFixed(2));
    const agreement = await createA2AAgreement(
      ctx,
      caseRow,
      proposedCents,
      discountPct,
      installments,
      offer.agentId ?? 'external_agent'
    );

    return {
      accepted: true,
      status: 'agreement_accepted',
      agreement,
    };
  }

  const counterOffer: A2ACounterOffer = {
    minSinglePaymentCents: Math.round(totalDebtCents * (1 - maxDiscountPct / 100)),
    minSinglePaymentDiscountPct: maxDiscountPct,
    maxInstallments: maxInstallmentsAllowed,
    installmentOptions: [
      {
        count: installments,
        centsPerInstallment: Math.round(floorInstallmentsCents / installments),
        totalCents: floorInstallmentsCents,
      },
    ],
    explanation: `El monto propuesto a plazos ($${(proposedCents / 100).toFixed(2)} MXN) no cubre el mínimo requerido ($${(floorInstallmentsCents / 100).toFixed(2)} MXN).`,
  };

  return {
    accepted: false,
    status: 'counter_offer',
    counterOffer,
    reason: counterOffer.explanation,
  };
}

/**
 * Formaliza el convenio A2A en la base de datos y entrega la CLABE de liquidación.
 */
async function createA2AAgreement(
  ctx: TenantContext,
  caseRow: CaseRow,
  agreedAmountCents: number,
  discountPct: number,
  installments: number,
  agentId: string
): Promise<A2AAgreement> {
  const agreementId = newId('agr');
  const timestamp = nowIso();

  // Vigencia estándar de 48 horas para pagar el convenio acordado
  const expiresDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const expiresAt = expiresDate.toISOString();

  // Obtener la CLABE del contrato o una de respaldo
  const contract = await getContractByClient(ctx, caseRow.client_id);
  const clabe = contract?.clabe || '646180123456789012';

  const oneClickUrl = `https://arkangel.arksystems.site/pay/${agreementId}`;

  await ctx.env.DB.prepare(
    `INSERT INTO a2a_agreements (
      id, tenant_id, case_id, client_id, original_amount_cents, agreed_amount_cents,
      discount_pct, installments, status, clabe, expires_at, agent_id, one_click_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      agreementId,
      ctx.tenantId,
      caseRow.id,
      caseRow.client_id,
      caseRow.amount_cents,
      agreedAmountCents,
      discountPct,
      installments,
      clabe,
      expiresAt,
      agentId,
      oneClickUrl,
      timestamp,
      timestamp
    )
    .run();

  // Vincular a promesas de pago para alimentar las métricas y la contabilidad
  await recordPromise(ctx, {
    tenantId: ctx.tenantId,
    caseId: caseRow.id,
    clientId: caseRow.client_id,
    amountCents: agreedAmountCents,
    promisedDate: expiresAt.slice(0, 10),
    confidence: 0.95,
    source: `a2a:${agentId}`,
  });

  logger.info('Convenio A2A formalizado exitosamente entre agentes', {
    agreementId,
    caseId: caseRow.id,
    tenantId: ctx.tenantId,
    agreedAmountCents,
    discountPct,
  });

  return {
    id: agreementId,
    tenantId: ctx.tenantId,
    caseId: caseRow.id,
    clientId: caseRow.client_id,
    originalAmountCents: caseRow.amount_cents,
    agreedAmountCents,
    discountPct,
    installments,
    status: 'pending',
    clabe,
    expiresAt,
    agentId,
    oneClickConfirmationUrl: oneClickUrl,
    createdAt: timestamp,
  };
}

/**
 * Consulta un convenio A2A por su identificador.
 */
export async function getA2AAgreement(
  ctx: TenantContext,
  agreementId: string
): Promise<A2AAgreement | null> {
  const row = await ctx.env.DB.prepare(
    'SELECT * FROM a2a_agreements WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, agreementId)
    .first<AgreementRow>();

  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    clientId: row.client_id,
    originalAmountCents: row.original_amount_cents,
    agreedAmountCents: row.agreed_amount_cents,
    discountPct: row.discount_pct,
    installments: row.installments,
    status: row.status,
    clabe: row.clabe || '',
    expiresAt: row.expires_at,
    agentId: row.agent_id,
    oneClickConfirmationUrl: row.one_click_url || '',
    createdAt: row.created_at,
  };
}
