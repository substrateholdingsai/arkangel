/**
 * Servicio de Ingesta y Verificación REPEP (PROFECO).
 *
 * Fundamento:
 *  - Ley Federal de Protección al Consumidor (LFPC) Arts. 18 y 18 Bis.
 *  - Ningún consumidor inscrito en el Registro Público para Evitar Publicidad
 *    puede recibir llamadas salientes o mensajes de texto publicitarios.
 *  - Almacenamiento seguro en edge: solo se almacenan hashes SHA-256 de números en E.164.
 *  - Vigencia fail-closed: si la lista tiene más de 35 días sin actualización,
 *    el motor de marketing bloquea llamadas y SMS comerciales preventivamente.
 */

import { bytesToHex } from '../lib/crypto';
import { normalizePhone } from '../lib/phone';
import type { Env } from '../types/env';

export const DIAS_MAXIMOS_VIGENCIA_REPEP = 35;

/**
 * Calcula el hash SHA-256 del teléfono en formato canónico E.164.
 */
export async function hashTelefonoSha256(rawPhone: string): Promise<string | null> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return null;

  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

export interface IniciarVersionParams {
  listDate: string; // YYYY-MM-DD
  source: string; // ej. "descarga_profeco_portal_2026_10"
}

/**
 * Inicia una nueva versión de la lista REPEP en estado 'loading'.
 */
export async function iniciarVersionRepep(env: Env, params: IniciarVersionParams): Promise<string> {
  const versionId = `rep_${Date.now()}`;
  await env.DB.prepare(
    `INSERT INTO comm_repep_versions (id, list_date, total, source, status)
     VALUES (?, ?, 0, ?, 'loading')`
  )
    .bind(versionId, params.listDate, params.source)
    .run();

  return versionId;
}

/**
 * Inserta un lote de números en comm_repep_numbers bajo la versión en carga.
 * Omite números inválidos o duplicados.
 */
export async function insertarLoteRepep(
  env: Env,
  versionId: string,
  telefonos: string[]
): Promise<number> {
  const hashes = new Set<string>();
  for (const tel of telefonos) {
    const h = await hashTelefonoSha256(tel);
    if (h) hashes.add(h);
  }

  if (hashes.size === 0) return 0;

  // Insertar en D1 en sentencias por lotes
  const values = Array.from(hashes);
  const batchSize = 50;

  for (let i = 0; i < values.length; i += batchSize) {
    const chunk = values.slice(i, i + batchSize);
    const statements = chunk.map((hash) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO comm_repep_numbers (phone_hash, version_id) VALUES (?, ?)'
      ).bind(hash, versionId)
    );
    await env.DB.batch(statements);
  }

  return hashes.size;
}

/**
 * Promueve la versión cargada a 'active' y marca la anterior como 'superseded' de forma atómica.
 */
export async function activarVersionRepep(
  env: Env,
  versionId: string,
  totalRegistros: number
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE comm_repep_versions SET status = 'superseded' WHERE status = 'active'"),
    env.DB.prepare("UPDATE comm_repep_versions SET status = 'active', total = ? WHERE id = ?").bind(
      totalRegistros,
      versionId
    ),
  ]);
}

export interface EstadoVigenciaRepep {
  listaVigente: boolean;
  versionActiva?: string;
  listDate?: string;
  total?: number;
  diasAntiguedad?: number;
  motivo?: 'sin_lista' | 'lista_caducada' | 'al_dia';
}

/**
 * Consulta la vigencia de la lista REPEP activa conforme al criterio fail-closed.
 */
export async function consultarVigenciaRepep(env: Env): Promise<EstadoVigenciaRepep> {
  const row = await env.DB.prepare(
    `SELECT id, list_date, total, status
     FROM comm_repep_versions
     WHERE status = 'active'
     ORDER BY loaded_at DESC LIMIT 1`
  ).first<{ id: string; list_date: string; total: number; status: string }>();

  if (!row) {
    return {
      listaVigente: false,
      motivo: 'sin_lista',
    };
  }

  const fechaCorte = new Date(row.list_date).getTime();
  const hoy = Date.now();
  const diffDias = Math.floor((hoy - fechaCorte) / (24 * 60 * 60 * 1000));

  if (diffDias > DIAS_MAXIMOS_VIGENCIA_REPEP || diffDias < 0) {
    return {
      listaVigente: false,
      versionActiva: row.id,
      listDate: row.list_date,
      total: Number(row.total),
      diasAntiguedad: diffDias,
      motivo: 'lista_caducada',
    };
  }

  return {
    listaVigente: true,
    versionActiva: row.id,
    listDate: row.list_date,
    total: Number(row.total),
    diasAntiguedad: diffDias,
    motivo: 'al_dia',
  };
}

/**
 * Consulta si un teléfono está inscrito en el REPEP activo.
 */
export async function estaEnRepep(
  env: Env,
  rawPhone: string,
  versionIdActiva?: string
): Promise<boolean> {
  const hash = await hashTelefonoSha256(rawPhone);
  if (!hash) return false;

  let vid = versionIdActiva;
  if (!vid) {
    const vigencia = await consultarVigenciaRepep(env);
    if (!vigencia.versionActiva) return false;
    vid = vigencia.versionActiva;
  }

  const row = await env.DB.prepare(
    `SELECT 1 FROM comm_repep_numbers
     WHERE phone_hash = ? AND version_id = ?
     LIMIT 1`
  )
    .bind(hash, vid)
    .first();

  return Boolean(row);
}
