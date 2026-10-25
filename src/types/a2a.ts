/**
 * Tipos para el protocolo A2A (Agent-to-Agent Collections & Programmatic Negotiation).
 * Permite que agentes de software que representan al deudor interactúen de forma segura,
 * verifiquen identidad, negocien quitas y reciban instrucciones de liquidación SPEI.
 */

export interface A2AAuthChallenge {
  caseId: string;
  phone?: string;
  /** Últimos 4 caracteres del RFC con homoclave (ej: "A18", "9012") */
  rfcLast4?: string;
  /** PIN de 4 a 6 dígitos asignado o enviado al cliente */
  pin?: string;
}

export interface A2AAuthResult {
  verified: boolean;
  error?: 'case_not_found' | 'auth_failed' | 'missing_challenge' | 'account_closed';
  debtorSummary?: A2ADebtorSummary;
  /** Token de sesión efímero de negociación (15 min) */
  sessionToken?: string;
}

export interface A2AStandardOffer {
  type: 'single_payment' | 'installments';
  discountPct: number;
  totalCents: number;
  installmentsCount: number;
  installmentCents: number;
  description: string;
  suggestedDeadlineDays: number;
}

export interface A2ADebtorSummary {
  caseId: string;
  maskedName: string; // Ej: "J*** P***" para protección de privacidad
  creditor: {
    razonSocial: string;
    condusefRegistro: string;
    redecoFolio?: string;
  };
  totalDebtCents: number;
  currency: string;
  maxDiscountPct: number;
  minSettlementCents: number;
  standardOffers: A2AStandardOffer[];
}

export interface A2AOfferRequest {
  caseId: string;
  proposedAmountCents: number;
  installments?: number;
  promiseDate?: string;
  agentId?: string; // Ej: "claude-assistant-v1", "grok-agent-mx"
  notes?: string;
}

export interface A2ACounterOffer {
  minSinglePaymentCents: number;
  minSinglePaymentDiscountPct: number;
  maxInstallments: number;
  installmentOptions: {
    count: number;
    centsPerInstallment: number;
    totalCents: number;
  }[];
  explanation: string;
}

export interface A2AAgreement {
  id: string;
  tenantId: string;
  caseId: string;
  clientId: string;
  originalAmountCents: number;
  agreedAmountCents: number;
  discountPct: number;
  installments: number;
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled';
  clabe: string;
  expiresAt: string;
  agentId: string | null;
  oneClickConfirmationUrl: string;
  createdAt: string;
}

export interface A2AOfferResult {
  accepted: boolean;
  status: 'agreement_accepted' | 'counter_offer' | 'rejected_below_floor';
  agreement?: A2AAgreement;
  counterOffer?: A2ACounterOffer;
  reason?: string;
}
