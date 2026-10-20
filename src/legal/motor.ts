import { logger } from '../lib/logger';
import { REGLAS } from './reglas';
import type { AccionLegal, ContextoLegal, ResultadoLegal, Violacion } from './tipos';

function aViolacion(
  regla: {
    id: string;
    seccion: string;
    conducta: string;
    ley: string;
    articulo: string;
    castigo: string;
  },
  accion: AccionLegal,
  detalle: string,
  evidencia: string,
  removidos?: string[]
): Violacion {
  return {
    reglaId: regla.id,
    seccion: regla.seccion,
    conducta: regla.conducta,
    ley: regla.ley,
    articulo: regla.articulo,
    castigo: regla.castigo,
    accion,
    detalle,
    evidencia: removidos?.length ? `${evidencia} | removido: ${removidos.join('; ')}` : evidencia,
  };
}

/**
 * Motor de cumplimiento.
 *
 * 1. Primero se intenta **reparar** (SANITIZE): lo que la IA redactó se corrige
 *    (amenazas fuera de proceso, rol de abogado, links apócrifos, identidad legal).
 * 2. Después se **verifica** sobre el mensaje final: si una conducta persiste
 *    tras la reparación, la acción sube a BLOCK.
 * 3. El resto de reglas (BLOCK/WARN/ESCALATE) se evalúan siempre.
 *
 * Fail-closed: si la identidad legal no está configurada, el motor bloquea.
 */
export function evaluarMensaje(ctx: ContextoLegal): ResultadoLegal {
  let mensaje = ctx.mensaje;
  const violaciones: Violacion[] = [];

  // ── Fase 1: detección sobre el mensaje original ──
  // Se evalúan TODAS las reglas reparables contra el texto original para que la
  // bitácora registre cada conducta detectada, aunque una sola reparación
  // (por ejemplo, borrar la frase completa) elimine varias a la vez.
  const reparables = REGLAS.filter((r) => r.accion === 'SANITIZE');
  const detectadas = reparables
    .map((regla) => ({ regla, detalle: regla.evaluar({ ...ctx, mensaje }) }))
    .filter(
      (entry): entry is { regla: (typeof reparables)[number]; detalle: string } =>
        entry.detalle !== null
    );

  // ── Fase 2: reparación ──
  const removidosPorRegla = new Map<string, string[]>();
  for (const { regla } of detectadas) {
    const saneo = regla.sanear?.({ ...ctx, mensaje });
    if (!saneo) continue;
    mensaje = saneo.texto;
    if (saneo.removidos.length > 0) {
      removidosPorRegla.set(regla.id, [
        ...(removidosPorRegla.get(regla.id) ?? []),
        ...saneo.removidos,
      ]);
    }
  }

  // ── Fase 3: verificación post-reparación ──
  for (const { regla, detalle } of detectadas) {
    const persiste = regla.evaluar({ ...ctx, mensaje });
    const accion: AccionLegal = persiste ? 'BLOCK' : 'SANITIZE';
    violaciones.push(
      aViolacion(regla, accion, detalle, ctx.mensaje, removidosPorRegla.get(regla.id))
    );
  }

  // ── Fase 4: reglas no reparables sobre el mensaje final ──
  for (const regla of REGLAS.filter((r) => r.accion !== 'SANITIZE')) {
    const detalle = regla.evaluar({ ...ctx, mensaje });
    if (!detalle) continue;
    violaciones.push(aViolacion(regla, regla.accion, detalle, mensaje));
  }

  const bloqueantes = violaciones.filter((v) => v.accion === 'BLOCK');
  const escala = violaciones.some((v) => v.accion === 'ESCALATE');

  if (bloqueantes.length > 0) {
    logger.warn('Mensaje bloqueado por el motor legal', {
      reglas: bloqueantes.map((v) => v.reglaId),
      caseId: ctx.caseId,
    });
  }

  return {
    permitido: bloqueantes.length === 0,
    mensaje,
    violaciones,
    bloqueadoPor: bloqueantes[0]?.reglaId ?? null,
    requiereHumano: escala || bloqueantes.length > 0,
  };
}

export interface ResumenRegla {
  id: string;
  seccion: string;
  conducta: string;
  ley: string;
  articulo: string;
  castigo: string;
  accion: AccionLegal;
}

export function catalogoReglas(): ResumenRegla[] {
  return REGLAS.map((regla) => ({
    id: regla.id,
    seccion: regla.seccion,
    conducta: regla.conducta,
    ley: regla.ley,
    articulo: regla.articulo,
    castigo: regla.castigo,
    accion: regla.accion,
  }));
}
