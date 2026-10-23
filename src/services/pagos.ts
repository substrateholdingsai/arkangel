import { parseCsvRows } from '../lib/csv';
import { formatMXN, parseAmountToCents } from '../lib/money';
import { normalizePhone } from '../lib/phone';
import type { TenantContext } from '../tenancy/types';
import { nowIso } from './db';
import { listPendingDebts, markDebtStatus } from './deudas';
import { logEvent } from './eventos';
import { recordMessage } from './mensajes';

export type PaymentSource =
  'cobre_spei' | 'conekta_spei' | 'csv_legacy' | 'api_webhook' | 'manual_operator';

export interface CanonicalPaymentInput {
  /** Clave de rastreo SPEI, movement_id de Cobre o folio único bancario (idempotencia). */
  trackingKey?: string | null;
  /** CLABE de 18 dígitos (match 100% determinista contra contracts.clabe). */
  clabe?: string | null;
  /** Folio de factura, referencia de deuda o ID de caso. */
  reference?: string | null;
  /** Teléfono del deudor. */
  phone?: string | null;
  /** Correo electrónico del deudor. */
  email?: string | null;
  /** Monto pagado en centavos MXN. */
  amountCents: number;
  /** Origen del pago. */
  source: PaymentSource;
  /** Fecha/hora ISO del pago. */
  paidAt?: string | null;
}

export interface ReconcileResult {
  status: 'reconciled' | 'duplicate' | 'unmatched';
  clientId: string | null;
  clientName: string | null;
  caseId: string | null;
  matchedBy: 'clabe' | 'reference' | 'phone' | 'email' | null;
  appliedCents: number;
  remainingCents: number;
  fullyPaid: boolean;
  trackingKey: string | null;
}

export interface BatchReconcileSummary {
  total: number;
  reconciled: number;
  duplicate: number;
  unmatched: number;
  totalReconciledCents: number;
  results: ReconcileResult[];
}

/**
 * Concilia un pago canónico contra contratos (CLABE), deudas (referencia), teléfono o email.
 * Es idempotente por `trackingKey`: si el mismo SPEI de Cobre o fila de CSV llega dos veces,
 * la segunda llamada devuelve `duplicate` sin alterar saldos.
 */
export async function reconcilePayment(
  ctx: TenantContext,
  input: CanonicalPaymentInput
): Promise<ReconcileResult> {
  const trackingKey = input.trackingKey?.trim() || null;
  const amountCents = Math.max(0, Math.round(input.amountCents));

  if (amountCents <= 0) {
    return {
      status: 'unmatched',
      clientId: null,
      clientName: null,
      caseId: null,
      matchedBy: null,
      appliedCents: 0,
      remainingCents: 0,
      fullyPaid: false,
      trackingKey,
    };
  }

  // 1. Idempotencia por trackingKey en la tabla events
  if (trackingKey) {
    const existing = await ctx.env.DB.prepare(
      `SELECT id FROM events WHERE tenant_id = ? AND type = 'pago.conciliado' AND payload LIKE ? LIMIT 1`
    )
      .bind(ctx.tenantId, `%"trackingKey":"${trackingKey.replace(/"/g, '')}"%`)
      .first<{ id: string }>();

    if (existing) {
      return {
        status: 'duplicate',
        clientId: null,
        clientName: null,
        caseId: null,
        matchedBy: null,
        appliedCents: 0,
        remainingCents: 0,
        fullyPaid: false,
        trackingKey,
      };
    }
  }

  // 2. Resolución determinista del cliente: CLABE -> Referencia -> Teléfono -> Email
  let clientId: string | null = null;
  let matchedBy: ReconcileResult['matchedBy'] = null;

  const cleanClabe = input.clabe?.replace(/[\s-]/g, '').trim() || null;
  if (cleanClabe && /^\d{16,18}$/.test(cleanClabe)) {
    const contractRow = await ctx.env.DB.prepare(
      'SELECT client_id FROM contracts WHERE tenant_id = ? AND clabe = ? ORDER BY updated_at DESC LIMIT 1'
    )
      .bind(ctx.tenantId, cleanClabe)
      .first<{ client_id: string }>();
    if (contractRow?.client_id) {
      clientId = contractRow.client_id;
      matchedBy = 'clabe';
    }
  }

  const cleanRef = input.reference?.trim() || null;
  if (!clientId && cleanRef) {
    const caseRow = await ctx.env.DB.prepare(
      'SELECT client_id FROM cases WHERE tenant_id = ? AND id = ? LIMIT 1'
    )
      .bind(ctx.tenantId, cleanRef)
      .first<{ client_id: string }>();
    if (caseRow?.client_id) {
      clientId = caseRow.client_id;
      matchedBy = 'reference';
    } else {
      const debtRow = await ctx.env.DB.prepare(
        'SELECT client_id FROM debts WHERE tenant_id = ? AND description LIKE ? ORDER BY updated_at DESC LIMIT 1'
      )
        .bind(ctx.tenantId, `%${cleanRef}%`)
        .first<{ client_id: string }>();
      if (debtRow?.client_id) {
        clientId = debtRow.client_id;
        matchedBy = 'reference';
      }
    }
  }

  const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;
  if (!clientId && normalizedPhone) {
    const clientRow = await ctx.env.DB.prepare(
      'SELECT id FROM clients WHERE tenant_id = ? AND phone = ? LIMIT 1'
    )
      .bind(ctx.tenantId, normalizedPhone)
      .first<{ id: string }>();
    if (clientRow?.id) {
      clientId = clientRow.id;
      matchedBy = 'phone';
    }
  }

  const cleanEmail = input.email?.trim().toLowerCase() || null;
  if (!clientId && cleanEmail) {
    const clientRow = await ctx.env.DB.prepare(
      'SELECT id FROM clients WHERE tenant_id = ? AND lower(email) = ? LIMIT 1'
    )
      .bind(ctx.tenantId, cleanEmail)
      .first<{ id: string }>();
    if (clientRow?.id) {
      clientId = clientRow.id;
      matchedBy = 'email';
    }
  }

  if (!clientId) {
    return {
      status: 'unmatched',
      clientId: null,
      clientName: null,
      caseId: null,
      matchedBy: null,
      appliedCents: 0,
      remainingCents: 0,
      fullyPaid: false,
      trackingKey,
    };
  }

  const clientInfo = await ctx.env.DB.prepare(
    'SELECT name FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1'
  )
    .bind(ctx.tenantId, clientId)
    .first<{ name: string }>();
  const clientName = clientInfo?.name ?? 'Cliente';

  // 3. Aplicación del pago sobre deudas pendientes (FIFO por fecha de vencimiento)
  const pendingDebts = await listPendingDebts(ctx, clientId);
  let remainingPayment = amountCents;
  let remainingDebtCents = 0;

  for (const debt of pendingDebts) {
    if (remainingPayment >= debt.amount_cents) {
      remainingPayment -= debt.amount_cents;
      await markDebtStatus(ctx, debt.id, 'paid');
    } else if (remainingPayment > 0) {
      const newDebtAmount = debt.amount_cents - remainingPayment;
      remainingPayment = 0;
      remainingDebtCents += newDebtAmount;
      await ctx.env.DB.prepare(
        'UPDATE debts SET amount_cents = ?, updated_at = ? WHERE tenant_id = ? AND id = ?'
      )
        .bind(newDebtAmount, nowIso(), ctx.tenantId, debt.id)
        .run();
    } else {
      remainingDebtCents += debt.amount_cents;
    }
  }

  const fullyPaid = remainingDebtCents === 0;

  // Si fue pago parcial, sincronizamos el contrato para que Regla 8.1 valide el nuevo saldo insoluto
  if (!fullyPaid && remainingDebtCents > 0) {
    await ctx.env.DB.prepare(
      'UPDATE contracts SET monto_pactado_cents = ?, updated_at = ? WHERE tenant_id = ? AND client_id = ?'
    )
      .bind(remainingDebtCents, nowIso(), ctx.tenantId, clientId)
      .run();
  }

  // 4. Actualizar el caso más reciente del cliente (sacarlo de la cola si ya pagó)
  const activeCase = await ctx.env.DB.prepare(
    'SELECT id, status, amount_cents FROM cases WHERE tenant_id = ? AND client_id = ? ORDER BY case_date DESC LIMIT 1'
  )
    .bind(ctx.tenantId, clientId)
    .first<{ id: string; status: string; amount_cents: number }>();

  let caseId: string | null = null;
  if (activeCase) {
    caseId = activeCase.id;
    if (fullyPaid) {
      await ctx.env.DB.prepare(
        "UPDATE cases SET status = 'paid', updated_at = ? WHERE tenant_id = ? AND id = ?"
      )
        .bind(nowIso(), ctx.tenantId, activeCase.id)
        .run();
    } else {
      await ctx.env.DB.prepare(
        'UPDATE cases SET amount_cents = ?, updated_at = ? WHERE tenant_id = ? AND id = ?'
      )
        .bind(remainingDebtCents, nowIso(), ctx.tenantId, activeCase.id)
        .run();
    }
  }

  // 5. Cerrar promesas abiertas como cumplidas (fulfilled) si liquidó
  if (fullyPaid) {
    await ctx.env.DB.prepare(
      "UPDATE promises SET status = 'fulfilled' WHERE tenant_id = ? AND client_id = ? AND status = 'open'"
    )
      .bind(ctx.tenantId, clientId)
      .run();
  }

  // 6. Registrar mensaje de sistema en el historial y evento de auditoría
  const sourceLabel =
    input.source === 'cobre_spei'
      ? 'Cobre SPEI Webhook'
      : input.source === 'conekta_spei'
        ? 'Conekta SPEI Webhook (order.paid)'
        : input.source === 'csv_legacy'
          ? 'Conciliación CSV Bancario'
          : input.source === 'manual_operator'
            ? 'Conciliación Manual'
            : 'Webhook de Pago';

  if (caseId) {
    await recordMessage(ctx, {
      caseId,
      clientId,
      channel: 'whatsapp',
      direction: 'inbound',
      providerId: trackingKey ? `pay_${trackingKey}` : `pay_${Date.now()}`,
      body: `[✅ ${sourceLabel}] Pago conciliado por ${formatMXN(amountCents)}${trackingKey ? ` · Rastreo: ${trackingKey}` : ''} (Match por ${matchedBy}). ${fullyPaid ? 'Cuenta liquidada — cliente retirado de la cola de cobranza.' : `Saldo restante: ${formatMXN(remainingDebtCents)}.`}`,
      status: 'received',
      meta: {
        payment_reconciled: true,
        source: input.source,
        tracking_key: trackingKey,
        amount_cents: amountCents,
        fully_paid: fullyPaid,
      },
    });
  }

  await logEvent(ctx, 'pago.conciliado', {
    caseId,
    clientId,
    payload: {
      source: input.source,
      trackingKey,
      matchedBy,
      amountCents,
      remainingCents: remainingDebtCents,
      fullyPaid,
      paidAt: input.paidAt ?? nowIso(),
    },
  });

  return {
    status: 'reconciled',
    clientId,
    clientName,
    caseId,
    matchedBy,
    appliedCents: amountCents,
    remainingCents: remainingDebtCents,
    fullyPaid,
    trackingKey,
  };
}

export async function reconcilePaymentBatch(
  ctx: TenantContext,
  items: CanonicalPaymentInput[]
): Promise<BatchReconcileSummary> {
  const results: ReconcileResult[] = [];
  let reconciled = 0;
  let duplicate = 0;
  let unmatched = 0;
  let totalReconciledCents = 0;

  for (const item of items) {
    const res = await reconcilePayment(ctx, item);
    results.push(res);
    if (res.status === 'reconciled') {
      reconciled++;
      totalReconciledCents += res.appliedCents;
    } else if (res.status === 'duplicate') {
      duplicate++;
    } else {
      unmatched++;
    }
  }

  return {
    total: items.length,
    reconciled,
    duplicate,
    unmatched,
    totalReconciledCents,
    results,
  };
}

/**
 * Parser agnóstico para CSV de pagos bancarios legacy (BBVA, Banorte, Santander, STP, Excel).
 * Detecta columnas como: clabe, monto/importe/abono, rastreo/referencia/folio, telefono, email.
 */
export function parsePaymentCsv(csvText: string): CanonicalPaymentInput[] {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return [];

  const first = (rows[0] ?? []).map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
  );

  const findIdx = (keywords: string[]) =>
    first.findIndex((h) => keywords.some((k) => h.includes(k)));

  const clabeIdx = findIdx(['clabe', 'cuenta', 'destino']);
  const montoIdx = findIdx(['monto', 'importe', 'abono', 'pagado', 'valor', 'amount']);
  const trackingIdx = findIdx(['rastreo', 'tracking', 'cep', 'transaccion', 'tx', 'movimiento']);
  const refIdx = findIdx(['referencia', 'folio', 'concepto', 'factura', 'caso']);
  const phoneIdx = findIdx(['tel', 'celular', 'phone', 'whatsapp']);
  const emailIdx = findIdx(['email', 'correo', 'mail']);

  const hasHeader =
    [clabeIdx, montoIdx, trackingIdx, refIdx, phoneIdx].filter((i) => i >= 0).length >= 2;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const output: CanonicalPaymentInput[] = [];

  for (const cells of dataRows) {
    const get = (idx: number) => (idx >= 0 ? (cells[idx] ?? '').trim() : '');

    const rawClabe = hasHeader ? get(clabeIdx) : (cells[0] ?? '').trim();
    const rawMonto = hasHeader ? get(montoIdx) : (cells[1] ?? '').trim();
    const rawTracking = hasHeader ? get(trackingIdx) : (cells[2] ?? '').trim();
    const rawRef = hasHeader ? get(refIdx) : (cells[3] ?? '').trim();
    const rawPhone = hasHeader ? get(phoneIdx) : '';
    const rawEmail = hasHeader ? get(emailIdx) : '';

    const amountCents = parseAmountToCents(rawMonto);
    if (!amountCents || amountCents <= 0) continue;

    output.push({
      clabe: rawClabe || null,
      amountCents,
      trackingKey: rawTracking || null,
      reference: rawRef || null,
      phone: rawPhone || null,
      email: rawEmail || null,
      source: 'csv_legacy',
    });
  }

  return output;
}
