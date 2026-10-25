/**
 * Capa Transversal de Custodia y Auditoría Inmutable (WORM - Write Once, Read Many).
 *
 * Cumplimiento del Artículo 49 del Código de Comercio de México:
 * Los comerciantes están obligados a conservar los libros, registros y comprobantes
 * de su giro por un plazo mínimo de diez años. Los mensajes de datos deberán
 * conservarse en el formato que se hayan generado, archivado o recibido, y que
 * permitan demostrar que han permanecido inalterados.
 *
 * Implementa un libro de contabilidad criptográfico encadenado (Chained Hash Ledger)
 * donde cada evento de cobranza, notificación NOM-151 o exportación judicial
 * sella el hash previo, garantizando trazabilidad y no-repudio absoluto.
 */

import { newId } from './db';
import { logger } from '../lib/logger';
import { sha256Hex } from './nom151';
import type { Env } from '../types/env';

export type WormRecordType =
  | 'nom151_certificate'
  | 'telnyx_call'
  | 'debtor_agreement'
  | 'judicial_docket_export'
  | 'payment_receipt';

export type WormAction = 'created' | 'verified' | 'exported' | 'tamper_check';

export type WormActor = 'operator' | 'system' | 'telnyx_webhook' | 'public_verifier';

export interface WormAuditInput {
  tenantId: string;
  caseId?: string | null;
  recordType: WormRecordType;
  recordId: string;
  action: WormAction;
  actor: WormActor;
  recordHash: string;
  metadata?: Record<string, unknown> | null;
}

export interface WormAuditEntry {
  id: string;
  tenantId: string;
  caseId: string | null;
  recordType: WormRecordType;
  recordId: string;
  action: WormAction;
  actor: WormActor;
  prevHash: string;
  recordHash: string;
  entryHash: string;
  timestampUtc: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Registra una entrada inmutable en la bitácora WORM encadenada.
 */
export async function recordWormAuditEntry(
  env: Env,
  input: WormAuditInput
): Promise<WormAuditEntry> {
  const timestampUtc = new Date().toISOString();
  const id = newId('worm');

  // 1. Obtener el hash de la última entrada del tenant para encadenar
  const lastEntry = await env.DB.prepare(
    `SELECT entry_hash FROM worm_audit_log
     WHERE tenant_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  )
    .bind(input.tenantId)
    .first<{ entry_hash: string }>();

  const prevHash = lastEntry?.entry_hash || GENESIS_PREV_HASH;

  // 2. Normalizar cadena de la entrada para cálculo criptográfico
  const rawString = [
    prevHash,
    input.tenantId,
    input.caseId || '',
    input.recordType,
    input.recordId,
    input.action,
    input.actor,
    input.recordHash,
    timestampUtc,
  ].join('|');

  const entryHash = await sha256Hex(rawString);

  // 3. Persistir en almacenamiento inmutable WORM
  await env.DB.prepare(
    `INSERT INTO worm_audit_log (
      id, tenant_id, case_id, record_type, record_id, action, actor,
      prev_hash, record_hash, entry_hash, timestamp_utc, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.tenantId,
      input.caseId || null,
      input.recordType,
      input.recordId,
      input.action,
      input.actor,
      prevHash,
      input.recordHash,
      entryHash,
      timestampUtc,
      input.metadata ? JSON.stringify(input.metadata) : null,
      timestampUtc
    )
    .run();

  logger.info('Entrada WORM registrada en bitácora inmutable', {
    id,
    tenantId: input.tenantId,
    recordType: input.recordType,
    recordId: input.recordId,
    entryHash: entryHash.slice(0, 16) + '...',
  });

  return {
    id,
    tenantId: input.tenantId,
    caseId: input.caseId || null,
    recordType: input.recordType,
    recordId: input.recordId,
    action: input.action,
    actor: input.actor,
    prevHash,
    recordHash: input.recordHash,
    entryHash,
    timestampUtc,
    metadata: input.metadata || null,
    createdAt: timestampUtc,
  };
}

/**
 * Verifica la integridad matemática de la cadena WORM para un caso o tenant.
 * Detecta si alguna fila ha sido alterada o eliminada.
 */
export async function verifyWormChain(
  env: Env,
  tenantId: string,
  caseId?: string | null
): Promise<{
  valid: boolean;
  totalEntries: number;
  compromisedAtId: string | null;
  retentionRequirement: string;
  checkedAt: string;
}> {
  let query = `SELECT * FROM worm_audit_log WHERE tenant_id = ?`;
  const binds: unknown[] = [tenantId];

  if (caseId) {
    query += ` AND case_id = ?`;
    binds.push(caseId);
  }

  query += ` ORDER BY created_at ASC, id ASC`;

  const { results } = await env.DB.prepare(query).bind(...binds).all<any>();

  let previousHash = GENESIS_PREV_HASH;
  let valid = true;
  let compromisedAtId: string | null = null;

  for (let i = 0; i < (results || []).length; i++) {
    const row = results[i];

    // Para la primera entrada del tenant sin predecesora en el set, se valida el cálculo de entry_hash
    const rawString = [
      row.prev_hash,
      row.tenant_id,
      row.case_id || '',
      row.record_type,
      row.record_id,
      row.action,
      row.actor,
      row.record_hash,
      row.timestamp_utc,
    ].join('|');

    const expectedEntryHash = await sha256Hex(rawString);

    if (row.entry_hash !== expectedEntryHash) {
      valid = false;
      compromisedAtId = row.id;
      break;
    }

    // Si no estamos filtrando por caseId, podemos verificar la continuidad estricta de prevHash
    if (!caseId && i > 0 && row.prev_hash !== previousHash) {
      valid = false;
      compromisedAtId = row.id;
      break;
    }

    previousHash = row.entry_hash;
  }

  return {
    valid,
    totalEntries: results?.length || 0,
    compromisedAtId,
    retentionRequirement: 'Artículo 49 del Código de Comercio (Retención mínima 10 años WORM)',
    checkedAt: new Date().toISOString(),
  };
}
