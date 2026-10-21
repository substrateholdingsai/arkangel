import { scoreShermanV2 } from '../lib/score';
import { logger } from '../lib/logger';
import { normalizePhone } from '../lib/phone';
import { formatMXNShort } from '../lib/money';
import type { CsvRow } from '../lib/csv';
import type { Env } from '../types/env';
import { upsertCase } from './casos';
import { findOrCreateClient } from './clientes';
import { createDebt, listPendingDebts } from './deudas';
import { logEvent } from './eventos';
import { newId, nowIso, todayIso } from './db';

export interface IntakePreviewRow {
  nombre: string;
  tel: string;
  monto: string;
}

export interface IntakeResult {
  intakeId: string;
  total: number;
  accepted: number;
  skipped: number;
  preview: IntakePreviewRow[];
}

export interface IntakeOptions {
  source?: string;
  fileName?: string | null;
  caseDate?: string;
  /** Zona horaria del tenant al que se ingiere. */
  tz?: string;
  /** Techo de monto del scoring (banda "alto") para el tenant. */
  scoreCeilingCents?: number;
}

/**
 * Convierte filas de CSV en clientes + deudas + casos del día.
 * Idempotente por (cliente, fecha): reprocesar el mismo archivo no duplica casos.
 */
export async function ingestRows(
  env: Env,
  rows: CsvRow[],
  options: IntakeOptions = {}
): Promise<IntakeResult> {
  const source = options.source ?? 'csv';
  const caseDate = options.caseDate ?? todayIso(options.tz ?? env.TZ);
  const intakeId = newId('int');

  const seen = new Map<string, CsvRow>();
  let skipped = 0;

  for (const row of rows) {
    const phone = normalizePhone(row.telefono);
    if (!phone) {
      skipped++;
      continue;
    }
    seen.set(phone, row);
  }

  let accepted = 0;
  const preview: IntakePreviewRow[] = [];

  for (const [phone, row] of seen) {
    try {
      const client = await findOrCreateClient(env, {
        name: row.nombre,
        phone,
        email: row.email,
        source,
      });

      const dueDate = row.vencimiento ?? caseDate;
      const amountCents = row.montoCents;

      const pending = await listPendingDebts(env, client.id);
      const sameDebt = pending.find(
        (debt) => debt.amount_cents === amountCents && debt.due_date === dueDate
      );

      if (!sameDebt) {
        await createDebt(env, {
          clientId: client.id,
          amountCents,
          dueDate,
          description: row.ref ? `Ref ${row.ref}` : null,
          source,
        });
      }

      const totalCents = pending
        .filter((debt) => !sameDebt || debt.id !== sameDebt.id)
        .reduce((sum, debt) => sum + debt.amount_cents, amountCents);

      const score = scoreShermanV2({
        amountCents: totalCents,
        dueDate,
        now: new Date(),
        ceilingCents: options.scoreCeilingCents ?? Number(env.SCORE_AMOUNT_CEILING_CENTS ?? 200000),
      });

      await upsertCase(env, {
        caseDate,
        clientId: client.id,
        debtId: sameDebt?.id ?? null,
        name: client.name,
        phone: client.phone,
        email: client.email,
        amountCents: totalCents,
        score: score.score,
        scoreBand: score.band,
        source,
      });

      accepted++;

      if (preview.length < 5) {
        preview.push({
          nombre: client.name.slice(0, 28),
          tel: phone,
          monto: formatMXNShort(totalCents),
        });
      }
    } catch (error) {
      skipped++;
      logger.error('Fila de ingesta falló', {
        phone,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await env.DB.prepare(
    'INSERT INTO intakes (id, source, file_name, rows_total, rows_accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(intakeId, source, options.fileName ?? null, rows.length, accepted, nowIso())
    .run();

  await logEvent(env, 'intake.csv', {
    payload: { intakeId, total: rows.length, accepted, skipped, fileName: options.fileName },
  });

  logger.info('Ingesta completada', { intakeId, total: rows.length, accepted, skipped });

  return { intakeId, total: rows.length, accepted, skipped, preview };
}
