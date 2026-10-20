/**
 * Reconciliación contable — cortes que quedaron a medio camino.
 *
 * Flujo de dos fases (la respuesta a la pregunta de fuego del code review):
 *
 *   1. `alegra_sync` se inserta con `status = 'pending'` ANTES de llamar a
 *      Alegra, junto con el `idempotency_key` del corte.
 *   2. `alegra.create_journal_entry` responde OK con un `journal_id`.
 *   3. `alegra_journal_lines` guarda una fila por asiento (con su
 *      `alegra_journal_id`) ANTES de actualizar `alegra_sync`.
 *   4. `alegra_sync` se actualiza a `status = 'sent'`.
 *
 * Si el paso 4 falla (D1 caído, timeout), la fila queda en `pending` pero las
 * líneas YA están escritas. En la siguiente corrida este job:
 *
 *   · pregunta a Alegra qué asientos existen para ese `idempotency_key`
 *     (`alegra.list_journal_entries`);
 *   · si todos existen → marca el corte `reconciled`, sin duplicar nada;
 *   · si falta alguno → re-crea sólo ese asiento (el resto se omite porque su
 *     línea ya existe);
 *   · si no puede confirmar (el MCP no responde o la lista viene vacía) →
 *     **no** re-asienta: deja el corte pendiente y avisa al humano.
 */

import type { Env } from '../types/env';
import { logger } from '../lib/logger';
import { logEvent } from '../services/eventos';
import { crearClienteAlegra, type AlegraApi } from '../contabilidad/alegraClient';
import {
  actualizarSync,
  listarLineas,
  listarSyncPendientes,
  leerPayloadDesdeR2,
  sendToAlegra,
  type LineaRow,
  type SyncRow,
} from '../contabilidad/sendToAlegra';
import type { AccountingPayload } from '../contabilidad/schemas';

export interface ResultadoReconciliacion {
  revisados: number;
  reconciliados: number;
  reenviados: number;
  sinConfirmar: number;
}

export interface OpcionesReconciliacion {
  /** Cliente MCP inyectable (pruebas). */
  cliente?: AlegraApi;
  /** Máximo de cortes a reconciliar por corrida. */
  limite?: number;
}

/**
 * Revisa los cortes pendientes/fallidos y los deja en un estado consistente
 * con lo que realmente hay en Alegra. Nunca duplica asientos.
 */
export async function reconciliarCortesPendientes(
  env: Env,
  opciones: OpcionesReconciliacion = {}
): Promise<ResultadoReconciliacion> {
  const resultado: ResultadoReconciliacion = {
    revisados: 0,
    reconciliados: 0,
    reenviados: 0,
    sinConfirmar: 0,
  };

  const pendientes = await listarSyncPendientes(env);
  const limite = opciones.limite ?? 20;
  const cliente = opciones.cliente ?? crearClienteAlegra(env);

  for (const corte of pendientes.slice(0, limite)) {
    resultado.revisados += 1;

    try {
      const lineas = await listarLineas(env, corte.idempotency_key);

      // Sin líneas: no se creó nada en Alegra → se reenvía el corte completo.
      if (lineas.length === 0) {
        const reenviado = await reenviarCorte(env, corte, cliente);
        if (reenviado) resultado.reenviados += 1;
        continue;
      }

      // Con líneas: se pregunta a Alegra qué existe realmente.
      if (!cliente.listJournalEntries) {
        await registrarSinConfirmar(env, corte, 'el cliente MCP no expone list_journal_entries');
        resultado.sinConfirmar += 1;
        continue;
      }

      const existentes = await cliente.listJournalEntries(corte.idempotency_key);
      if (existentes.length === 0) {
        await registrarSinConfirmar(
          env,
          corte,
          'Alegra no devolvió asientos para esta idempotency key: no se re-asienta'
        );
        resultado.sinConfirmar += 1;
        continue;
      }

      const ids = new Set(existentes.map((asiento) => asiento.id));
      const faltantes = lineas.filter((linea) => !ids.has(linea.alegra_journal_id));

      if (faltantes.length === 0) {
        await actualizarSync(
          env,
          corte.idempotency_key,
          'reconciled',
          lineas[0]?.alegra_journal_id ?? corte.alegra_journal_id,
          null
        );
        await logEvent(env, 'alegra_sync', {
          payload: {
            fecha_corte: corte.fecha_corte,
            idempotency_key: corte.idempotency_key,
            status: 'reconciled',
            asientos: lineas.length,
            aviso: 'los asientos ya existían en Alegra: no se duplicó ninguno',
          },
        });
        resultado.reconciliados += 1;
        continue;
      }

      // Sólo falta(n) algunos: se re-crean esos y el resto se omite.
      const payload = await leerPayloadDesdeR2(env, corte.fecha_corte);
      if (!payload) {
        await registrarSinConfirmar(env, corte, 'payload no encontrado en R2');
        resultado.sinConfirmar += 1;
        continue;
      }

      for (const linea of faltantes) {
        const asiento = payload.asientos.find(
          (item) => item.legal_audit_id === linea.legal_audit_id
        );
        if (!asiento) continue;
        const creado = await cliente.createJournalEntry(asiento, payload);
        await actualizarLinea(env, corte.idempotency_key, linea, creado.id);
      }

      await actualizarSync(
        env,
        corte.idempotency_key,
        'reconciled',
        lineas[0]?.alegra_journal_id ?? corte.alegra_journal_id,
        null
      );
      await logEvent(env, 'alegra_sync', {
        payload: {
          fecha_corte: corte.fecha_corte,
          idempotency_key: corte.idempotency_key,
          status: 'reconciled',
          recreados: faltantes.length,
        },
      });
      resultado.reconciliados += 1;
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await logEvent(env, 'alegra_sync', {
        payload: {
          fecha_corte: corte.fecha_corte,
          idempotency_key: corte.idempotency_key,
          status: 'reconciliacion_fallida',
          error: mensaje,
        },
      });
      logger.error('Falló la reconciliación de un corte', {
        fecha_corte: corte.fecha_corte,
        error: mensaje,
      });
    }
  }

  if (resultado.revisados > 0) {
    logger.info('Reconciliación contable terminada', { ...resultado });
  }

  return resultado;
}

/** Reenvía un corte que no llegó a crear ningún asiento. */
async function reenviarCorte(env: Env, corte: SyncRow, cliente: AlegraApi): Promise<boolean> {
  const payload = await leerPayloadDesdeR2(env, corte.fecha_corte);
  if (!payload) {
    await registrarSinConfirmar(env, corte, 'payload no encontrado en R2');
    return false;
  }
  const resultado = await sendToAlegra(payload as AccountingPayload, env, { cliente });
  return resultado.ok;
}

async function registrarSinConfirmar(env: Env, corte: SyncRow, motivo: string): Promise<void> {
  await logEvent(env, 'alegra_reconciliacion_sin_confirmacion', {
    payload: {
      fecha_corte: corte.fecha_corte,
      idempotency_key: corte.idempotency_key,
      status: corte.status,
      motivo,
      accion_requerida: 'Revisar manualmente el corte en Alegra',
    },
  });
  logger.warn('Reconciliación sin confirmación: no se re-asienta', {
    fecha_corte: corte.fecha_corte,
    motivo,
  });
}

const SQL_ACTUALIZAR_LINEA = `UPDATE alegra_journal_lines
  SET alegra_journal_id = ?
  WHERE idempotency_key = ? AND legal_audit_id = ?`;

/** Actualiza el journal id de una línea (el asiento sí existía pero cambió de id). */
async function actualizarLinea(
  env: Env,
  idempotencyKey: string,
  linea: LineaRow,
  journalId: string
): Promise<void> {
  await env.DB.prepare(SQL_ACTUALIZAR_LINEA)
    .bind(journalId, idempotencyKey, linea.legal_audit_id)
    .run();
}
