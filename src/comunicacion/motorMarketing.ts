/**
 * Motor de Comunicación de Arkangel (marketing, eventos, avisos, transaccional).
 *
 * Módulo independiente y puro. No depende de `src/legal` ni de `src/orquestacion`.
 * Todas las evaluaciones son deterministas y fail-closed: ante la falta de cualquier
 * dato requerido, el envío es bloqueado o diferido.
 */

import { isWithinQuietHours, calcularSiguienteApertura } from './horarios';
import { renderizarPlantilla } from './plantillas';
import { type ContextoEnvio, type ResultadoEvaluacion, esPublicidad, categoriaDe } from './tipos';

/**
 * Evalúa un intento de envío en comunicación general aplicando todas las reglas
 * fail-closed.
 */
export function evaluarEnvio(ctx: ContextoEnvio): ResultadoEvaluacion {
  const reglasAplicadas: string[] = [];

  // 1. Selección explícita de motor (fail-closed)
  reglasAplicadas.push('R1_MOTOR_DECLARADO');
  if (!ctx.motor) {
    return {
      decision: 'excluir',
      motivos: ['motor_no_declarado'],
      reglasAplicadas,
    };
  }
  if (ctx.motor !== 'comunicacion') {
    return {
      decision: 'excluir',
      motivos: ['motor_incorrecto'],
      reglasAplicadas,
    };
  }

  // 2. Destinatario válido
  if (!ctx.contacto || !ctx.contacto.trim()) {
    return {
      decision: 'excluir',
      motivos: ['contacto_invalido'],
      reglasAplicadas,
    };
  }

  // 3. Identificación obligatoria de la marca comercial (LFPC Art. 17)
  reglasAplicadas.push('R8_IDENTIFICACION_MARCA');
  if (!ctx.marca || !ctx.marca.trim()) {
    return {
      decision: 'excluir',
      motivos: ['marca_faltante'],
      reglasAplicadas,
    };
  }

  // 4. Coherencia de cartera: exclusión de destinatarios en cobranza activa
  reglasAplicadas.push('R9_COBRANZA_ACTIVA');
  if (ctx.cobranzaActiva) {
    return {
      decision: 'excluir',
      motivos: ['cobranza_activa'],
      reglasAplicadas,
    };
  }

  // 5. Lista de supresión / desuscripción (Opt-out directo)
  reglasAplicadas.push('R3_OPT_OUT_SUPRESION');
  if (ctx.suprimido) {
    return {
      decision: 'excluir',
      motivos: ['suprimido'],
      reglasAplicadas,
    };
  }

  // 6. Consentimiento previo verificable (Opt-in) con fecha y fuente
  reglasAplicadas.push('R2_OPT_IN_VERIFICADO');
  if (!ctx.consentimiento || !ctx.consentimiento.optInAt || !ctx.consentimiento.optInSource) {
    return {
      decision: 'excluir',
      motivos: ['sin_consentimiento'],
      reglasAplicadas,
    };
  }
  if (ctx.consentimiento.revokedAt) {
    return {
      decision: 'excluir',
      motivos: ['consentimiento_revocado'],
      reglasAplicadas,
    };
  }

  // 7. Consulta a lista REPEP (PROFECO) si es publicidad/marketing
  if (esPublicidad(ctx.proposito)) {
    reglasAplicadas.push('R4_REPEP_PROFECO');
    if (!ctx.repep.listaVigente) {
      return {
        decision: 'excluir',
        motivos: ['repep_lista_no_vigente'],
        reglasAplicadas,
      };
    }
    if (ctx.repep.registrado) {
      return {
        decision: 'excluir',
        motivos: ['repep_registrado'],
        reglasAplicadas,
      };
    }
  }

  // 8. Quiet Hours (21:00 a 08:00) en hora local del destinatario
  if (ctx.modo === 'campana') {
    reglasAplicadas.push('R5_QUIET_HOURS');
    const { inQuietHours } = isWithinQuietHours(ctx.ahora, ctx.tzContacto);
    if (inQuietHours) {
      const diferirHasta = calcularSiguienteApertura(ctx.ahora, ctx.tzContacto);
      return {
        decision: 'diferir',
        motivos: [],
        reglasAplicadas,
        diferirHasta: diferirHasta.toISOString(),
      };
    }
  }

  // 9. Límite de frecuencia semanal por marca + número
  if (ctx.frecuencia) {
    reglasAplicadas.push('R6_FREQUENCY_CAP');
    if (ctx.frecuencia.enviadosVentana >= ctx.frecuencia.maximo) {
      return {
        decision: 'excluir',
        motivos: ['frecuencia_excedida'],
        reglasAplicadas,
      };
    }
  }

  // 10. Validación de plantilla HSM vs texto libre
  reglasAplicadas.push('R7_PLANTILLA_META');
  let textoFinal: string | undefined = undefined;

  if (ctx.modo === 'campana') {
    if (!ctx.plantilla) {
      return {
        decision: 'excluir',
        motivos: ['plantilla_no_aprobada'],
        reglasAplicadas,
      };
    }
    if (ctx.plantilla.status !== 'APPROVED') {
      return {
        decision: 'excluir',
        motivos: ['plantilla_no_aprobada'],
        reglasAplicadas,
      };
    }
    if (ctx.plantilla.channel !== ctx.canal) {
      return {
        decision: 'excluir',
        motivos: ['plantilla_canal_incorrecto'],
        reglasAplicadas,
      };
    }
    if (ctx.plantilla.categoria !== categoriaDe(ctx.proposito)) {
      return {
        decision: 'excluir',
        motivos: ['plantilla_categoria_incorrecta'],
        reglasAplicadas,
      };
    }

    const render = renderizarPlantilla(ctx.plantilla, ctx.variables, ctx.marca);
    if (!render.ok) {
      return {
        decision: 'excluir',
        motivos: ['plantilla_variables_faltantes'],
        reglasAplicadas,
      };
    }
    textoFinal = render.texto;
  } else {
    // Modo respuesta 1:1
    if (ctx.canal === 'whatsapp') {
      if (!ctx.ultimaRespuestaAt) {
        return {
          decision: 'excluir',
          motivos: ['texto_libre_fuera_de_ventana'],
          reglasAplicadas,
        };
      }
      const transcurridoMs = ctx.ahora.getTime() - new Date(ctx.ultimaRespuestaAt).getTime();
      const ventana24hMs = 24 * 60 * 60 * 1000;
      if (transcurridoMs > ventana24hMs || transcurridoMs < 0) {
        return {
          decision: 'excluir',
          motivos: ['texto_libre_fuera_de_ventana'],
          reglasAplicadas,
        };
      }
    }

    if (!ctx.textoLibre || !ctx.textoLibre.trim()) {
      return {
        decision: 'excluir',
        motivos: ['texto_libre_en_campana'],
        reglasAplicadas,
      };
    }
    textoFinal = ctx.textoLibre.trim();
  }

  return {
    decision: 'enviar',
    motivos: [],
    reglasAplicadas,
    textoRenderizado: textoFinal,
  };
}
