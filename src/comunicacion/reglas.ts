/**
 * Catálogo de reglas del Motor de Comunicación.
 *
 * Cada regla tiene:
 *   - id: identificador corto
 *   - nombre: nombre legible para el operador
 *   - descripcion: qué valida
 *   - baseLegal: fundamento normativo (LFPC, LFPDPPP, NOM-184, Política de Meta)
 *   - argumentoValor: texto persuasivo para el reporte post-campaña explicando
 *                     por qué la exclusión protege la reputación y canal de la cámara.
 */

import type { MotivoExclusion } from './tipos';

export interface FichaRegla {
  id: string;
  motivo: MotivoExclusion;
  nombre: string;
  descripcion: string;
  baseLegal: string;
  argumentoValor: string;
}

export const CATALOGO_REGLAS: Record<string, FichaRegla> = {
  R1_MOTOR_DECLARADO: {
    id: 'R1_MOTOR_DECLARADO',
    motivo: 'motor_no_declarado',
    nombre: 'Selección explícita de motor',
    descripcion:
      'El operador debe declarar explícitamente "cobranza" o "comunicacion". Sin selección el botón de disparo está deshabilitado.',
    baseLegal: 'Aislamiento de dominios Arkangel / Gobernanza de Canales',
    argumentoValor:
      'Evita la contaminación del tono y previene activar erróneamente normas financieras o de marketing.',
  },
  R2_OPT_IN_VERIFICADO: {
    id: 'R2_OPT_IN_VERIFICADO',
    motivo: 'sin_consentimiento',
    nombre: 'Consentimiento previo verificable (Opt-in)',
    descripcion:
      'Requiere registro explícito con fecha (opt_in_at) y fuente (opt_in_source) por marca, canal y categoría.',
    baseLegal: 'LFPDPPP Art. 8 / LFPC Art. 17 / Política Comercial de Meta WhatsApp Business',
    argumentoValor:
      'Protege contra denuncias por comunicaciones no solicitadas y mantiene la tasa de reporte de spam en ceros.',
  },
  R3_OPT_OUT_SUPRESION: {
    id: 'R3_OPT_OUT_SUPRESION',
    motivo: 'suprimido',
    nombre: 'Lista de supresión / Desuscripción (Opt-out)',
    descripcion:
      'Bloquea envíos a números que solicitaron baja (BAJA, STOP) o que presentaron rebote/bloqueo.',
    baseLegal: 'LFPC Art. 17 Bis / Términos de Meta Cloud API',
    argumentoValor:
      'Respeta la voluntad del consumidor al instante, evitando bloqueos forzosos del número oficial de la cámara.',
  },
  R4_REPEP_PROFECO: {
    id: 'R4_REPEP_PROFECO',
    motivo: 'repep_registrado',
    nombre: 'Exclusión Registro Público para Evitar Publicidad (REPEP)',
    descripcion:
      'Consulta obligatoria a la lista REPEP de PROFECO para números de consumidores antes de emitir publicidad.',
    baseLegal: 'Ley Federal de Protección al Consumidor Art. 18 y 18 Bis',
    argumentoValor:
      'Evita multas millonarias de PROFECO y blinda jurídicamente a los comercios afiliados y a la cámara.',
  },
  R5_QUIET_HOURS: {
    id: 'R5_QUIET_HOURS',
    motivo: 'frecuencia_excedida', // en caso de ser diferido se usa acción diferir
    nombre: 'Horario permitido de contacto (Quiet Hours)',
    descripcion:
      'Prohíbe envíos de marketing de 21:00 a 08:00 hora local del destinatario. Encola para las 08:00 si cae fuera de horario.',
    baseLegal: 'LFPC Art. 18 / NOM-184-SCFI / Prácticas comerciales responsables',
    argumentoValor:
      'Garantiza que ningún socio ni cliente reciba mensajes en horas de descanso, cuidando la imagen de la marca.',
  },
  R6_FREQUENCY_CAP: {
    id: 'R6_FREQUENCY_CAP',
    motivo: 'frecuencia_excedida',
    nombre: 'Límite de frecuencia por marca y contacto',
    descripcion:
      'Tope semanal de impactos comerciales por número y por marca. Bloquea colisiones entre campañas simultáneas.',
    baseLegal: 'Políticas de Calidad y Calificación de Plantillas de WhatsApp',
    argumentoValor:
      'Evita la saturación del cliente y protege la calificación verde (High Quality) del trunk telefónico y de WhatsApp.',
  },
  R7_PLANTILLA_META: {
    id: 'R7_PLANTILLA_META',
    motivo: 'plantilla_no_aprobada',
    nombre: 'Plantilla HSM pre-aprobada por Meta',
    descripcion:
      'Las campañas masivas únicamente pueden disparar plantillas aprobadas. Texto libre sólo dentro de 24h post-respuesta.',
    baseLegal: 'Meta Business Messaging Policy (Template Categorization)',
    argumentoValor:
      'Elimina el riesgo de baneos masivos de Meta por textos improvisados o palabras prohibidas.',
  },
  R8_IDENTIFICACION_MARCA: {
    id: 'R8_IDENTIFICACION_MARCA',
    motivo: 'marca_faltante',
    nombre: 'Identificación comercial obligatoria',
    descripcion:
      'Todo mensaje debe identificar claramente la denominación o razón social de la cámara o negocio emisor.',
    baseLegal: 'LFPC Art. 17 (Identificación clara del proveedor)',
    argumentoValor:
      'Genera confianza inmediata en el receptor y cumple con los requerimientos de transparencia comercial.',
  },
  R9_COBRANZA_ACTIVA: {
    id: 'R9_COBRANZA_ACTIVA',
    motivo: 'cobranza_activa',
    nombre: 'Exclusión por gestión de cobranza activa',
    descripcion:
      'Excluye de promociones y felicitaciones comerciales a destinatarios que tienen procesos de cobranza vigentes con la misma marca.',
    baseLegal: 'Criterios de Ética Comercial y Coherencia de Cartera',
    argumentoValor:
      'Previene incongruencias de comunicación (felicitar o vender a quien se le está requiriendo pago extrajudicial).',
  },
};
