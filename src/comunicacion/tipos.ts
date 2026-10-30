/**
 * Tipos del Motor de Comunicación (marketing, eventos, avisos, transaccional).
 *
 * Este dominio comparte los CANALES con cobranza (src/channels) pero no su
 * cerebro: no importa nada de src/legal ni de src/orquestacion. Lo verifica
 * tests/comunicacionAislamiento.test.ts.
 */

/**
 * Motor que el operador declara explícitamente al disparar. No hay default:
 * sin selección no se dispara (fail-closed).
 */
export type MotorComunicacion = 'cobranza' | 'comunicacion';

export const MOTORES: readonly MotorComunicacion[] = ['cobranza', 'comunicacion'];

/** Canales del motor. `voz` es la llamada saliente con Voz AI (Telnyx). */
export type CanalComunicacion = 'whatsapp' | 'sms' | 'email' | 'voz';

export const CANALES: readonly CanalComunicacion[] = ['whatsapp', 'sms', 'email', 'voz'];

/** Propósito del mensaje: decide la categoría de consentimiento y las reglas. */
export type Proposito =
  'promocion' | 'evento' | 'cumpleanos' | 'marketing' | 'aviso' | 'transaccional';

export const PROPOSITOS: readonly Proposito[] = [
  'promocion',
  'evento',
  'cumpleanos',
  'marketing',
  'aviso',
  'transaccional',
];

/** Categoría de consentimiento (columna `categoria` de comm_consents). */
export type CategoriaConsentimiento = 'marketing' | 'avisos' | 'transaccional';

export function categoriaDe(proposito: Proposito): CategoriaConsentimiento {
  switch (proposito) {
    case 'aviso':
      return 'avisos';
    case 'transaccional':
      return 'transaccional';
    default:
      return 'marketing';
  }
}

/** ¿Es publicidad? (REPEP y frequency cap aplican a publicidad). */
export function esPublicidad(proposito: Proposito): boolean {
  return categoriaDe(proposito) === 'marketing';
}

/** Modo de envío: campaña masiva (sólo plantillas) o respuesta 1:1. */
export type ModoEnvio = 'campana' | 'respuesta';

/** Códigos de exclusión. Cada uno tiene ficha en `reglas.ts`. */
export type MotivoExclusion =
  | 'motor_no_declarado'
  | 'motor_incorrecto'
  | 'contacto_invalido'
  | 'sin_consentimiento'
  | 'consentimiento_revocado'
  | 'suprimido'
  | 'repep_registrado'
  | 'repep_lista_no_vigente'
  | 'frecuencia_excedida'
  | 'plantilla_no_aprobada'
  | 'plantilla_canal_incorrecto'
  | 'plantilla_categoria_incorrecta'
  | 'plantilla_variables_faltantes'
  | 'texto_libre_en_campana'
  | 'texto_libre_fuera_de_ventana'
  | 'marca_faltante'
  | 'cobranza_activa'
  | 'saldo_insuficiente'
  | 'saldo_desconocido'
  | 'jerarquia_invalida';

/** Hecho de consentimiento ya consultado. */
export interface HechoConsentimiento {
  optInAt: string | null;
  optInSource: string | null;
  revokedAt: string | null;
}

/** Hecho REPEP ya consultado. `listaVigente=false` → no hay lista confiable. */
export interface HechoRepep {
  listaVigente: boolean;
  registrado: boolean;
}

/** Hecho de frecuencia ya consultado (desde FrequencyCapDO). */
export interface HechoFrecuencia {
  enviadosVentana: number;
  maximo: number;
}

/** Plantilla curada tal como la ve el motor. */
export interface PlantillaComunicacion {
  id: string;
  tenantId: string;
  channel: CanalComunicacion;
  nombre: string;
  metaName: string | null;
  lang: string;
  categoria: CategoriaConsentimiento;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  subject: string | null;
  bodyPreview: string;
  variables: string[];
  shared: boolean;
}

/**
 * Todo lo que el motor necesita para decidir UN envío. Se arma antes (con D1 y
 * el DO de frecuencia) para que `evaluarEnvio` sea puro y determinista.
 */
export interface ContextoEnvio {
  motor: MotorComunicacion | null | undefined;
  modo: ModoEnvio;
  canal: CanalComunicacion;
  proposito: Proposito;
  /** Marca que firma el mensaje (tenants.marca_comercial). */
  marca: string;
  contacto: string | null;
  ahora: Date;
  /** Zona IANA del contacto si se conoce; si no, se aplica la más restrictiva. */
  tzContacto: string | null;
  consentimiento: HechoConsentimiento | null;
  suprimido: boolean;
  repep: HechoRepep;
  frecuencia: HechoFrecuencia | null;
  plantilla: PlantillaComunicacion | null;
  variables: Record<string, string>;
  /** Texto libre (sólo modo respuesta). */
  textoLibre?: string | null;
  /** Último mensaje entrante del contacto (ventana de 24h de Meta). */
  ultimaRespuestaAt?: string | null;
  /** El mismo emisor tiene a este contacto en cobranza activa. */
  cobranzaActiva: boolean;
}

export type Decision = 'enviar' | 'diferir' | 'excluir';

export interface ResultadoEvaluacion {
  decision: Decision;
  motivos: MotivoExclusion[];
  /** Reglas evaluadas (ids de `reglas.ts`), para el preview y la auditoría. */
  reglasAplicadas: string[];
  /** Si `decision = 'diferir'`: siguiente apertura del horario permitido. */
  diferirHasta?: string;
  /** Texto final con la marca, si se pudo renderizar. */
  textoRenderizado?: string;
}
