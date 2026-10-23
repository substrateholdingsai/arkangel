/**
 * Tipos del motor de cumplimiento: la ley como código ejecutable.
 *
 * Cada regla del catálogo legal es un evaluador puro: recibe el contexto del
 * intento de contacto y devuelve una violación (o null). El motor decide la
 * acción: BLOCK (no se envía), SANITIZE (se corrige y se continúa), WARN
 * (se audita y se envía) o ESCALATE (se envía pero el caso pasa a humano).
 */

export type AccionLegal = 'BLOCK' | 'SANITIZE' | 'WARN' | 'ESCALATE';

export interface MetaRegla {
  id: string;
  seccion: string;
  conducta: string;
  descripcion: string;
  ley: string;
  articulo: string;
  castigo: string;
  accion: AccionLegal;
}

export interface Violacion {
  reglaId: string;
  seccion: string;
  conducta: string;
  ley: string;
  articulo: string;
  castigo: string;
  accion: AccionLegal;
  detalle: string;
  evidencia: string;
}

export interface ContratoLegal {
  id: string;
  client_id: string;
  monto_pactado_cents: number;
  tasa_pct: number | null;
  clabe: string | null;
  nombre_legal: string | null;
  condusef: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContextoLegal {
  ahora: Date;
  canal: 'whatsapp' | 'sms' | 'email';
  mensaje: string;
  asunto?: string;

  // Identidad del emisor (regla 1.1)
  nombreLegal: string;
  condusef: string;

  // Deudor
  clienteId: string;
  clienteNombre: string;
  telefono?: string | null;
  email?: string | null;

  // Montos y vencimiento (reglas 2.3, 4.2 y 8.1)
  montoCents: number;
  contrato?: ContratoLegal | null;
  /** Fecha de vencimiento (`YYYY-MM-DD`). Permite bloquear cobro anticipado (Día T-1). */
  fechaVencimiento?: string | null;

  // Presión y trazabilidad (reglas 2.3 y 8.7)
  contactos24h: number;
  logsReales: number;
  logsCrm: number;

  // Superficie de fraude (reglas 3.1 y 3.2)
  dominiosPermitidos: string[];
  adjuntos?: string[];

  // Parámetros legales vigentes
  maxContactos24h: number;
  ventanaContacto: { inicio: number; fin: number };
  toleranciaCents: number;
  /**
   * Zona horaria en la que se evalúa la ventana de contacto. Por defecto,
   * `America/Mexico_City`: es la del marco normativo (NOM-184). Un tenant con
   * otra zona debe declararla para que el orquestador y el motor legal no
   * discrepen sobre la misma ventana.
   */
  zonaHoraria?: string;

  // Contexto del intento
  caseId?: string | null;
  esRespuesta: boolean;
  /**
   * Una respuesta a un mensaje del deudor no es contacto iniciado por el agente:
   * el tope de impactos (2.3) y la ventana horaria (2.4) no se le aplican
   * (se activan con `LEGAL_HORARIO_EN_RESPUESTAS=true` si la política lo exige).
   */
  respuestaExenta?: boolean;
}

export interface ResultadoLegal {
  permitido: boolean;
  mensaje: string;
  asunto?: string;
  violaciones: Violacion[];
  bloqueadoPor: string | null;
  requiereHumano: boolean;
}
