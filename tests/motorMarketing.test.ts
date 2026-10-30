import { describe, expect, it } from 'vitest';
import { evaluarEnvio } from '../src/comunicacion/motorMarketing';
import type { ContextoEnvio, PlantillaComunicacion } from '../src/comunicacion/tipos';

function plantillaValida(overrides: Partial<PlantillaComunicacion> = {}): PlantillaComunicacion {
  return {
    id: 'tpl_promo_aniversario',
    tenantId: 'canaco_merida',
    channel: 'whatsapp',
    nombre: 'Invitación Aniversario',
    metaName: 'promo_aniversario_canaco',
    lang: 'es_MX',
    categoria: 'marketing',
    status: 'APPROVED',
    subject: null,
    bodyPreview: 'Hola {{nombre}}, {{marca}} te invita a su evento especial.',
    variables: ['nombre'],
    shared: true,
    ...overrides,
  };
}

function contextoValido(overrides: Partial<ContextoEnvio> = {}): ContextoEnvio {
  // Fecha a las 12:00 PM CDMX (dentro del horario 08:00 a 21:00)
  const ahoraMediodia = new Date('2026-10-29T18:00:00Z'); // 12:00 CDMX (UTC-6)
  return {
    motor: 'comunicacion',
    modo: 'campana',
    canal: 'whatsapp',
    proposito: 'promocion',
    marca: 'CANACO SERVYTUR Mérida',
    contacto: '+529991234567',
    ahora: ahoraMediodia,
    tzContacto: 'America/Merida',
    consentimiento: {
      optInAt: '2026-01-15T10:00:00Z',
      optInSource: 'registro_agremiado_siem',
      revokedAt: null,
    },
    suprimido: false,
    repep: {
      listaVigente: true,
      registrado: false,
    },
    frecuencia: {
      enviadosVentana: 0,
      maximo: 2,
    },
    plantilla: plantillaValida(),
    variables: {
      nombre: 'Don Pedro',
    },
    cobranzaActiva: false,
    ...overrides,
  };
}

describe('Motor de Comunicación — Reglas Anti-spam Fail-closed', () => {
  it('R1: Bloquea si no se declara explícitamente el motor (fail-closed)', () => {
    const ctx = contextoValido({ motor: null });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('motor_no_declarado');
  });

  it('R1: Bloquea si se intenta evaluar con el motor de cobranza en este módulo', () => {
    const ctx = contextoValido({ motor: 'cobranza' });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('motor_incorrecto');
  });

  it('R8: Bloquea si la marca comercial está vacía (LFPC)', () => {
    const ctx = contextoValido({ marca: '   ' });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('marca_faltante');
  });

  it('R9: Bloquea si el destinatario está en cobranza activa con el emisor', () => {
    const ctx = contextoValido({ cobranzaActiva: true });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('cobranza_activa');
  });

  it('R3: Bloquea si el número está en la lista de supresión (Opt-out)', () => {
    const ctx = contextoValido({ suprimido: true });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('suprimido');
  });

  it('R2: Bloquea si no hay consentimiento previo verificado (Opt-in)', () => {
    const ctxSinConsentimiento = contextoValido({ consentimiento: null });
    expect(evaluarEnvio(ctxSinConsentimiento).motivos).toContain('sin_consentimiento');

    const ctxSinFuente = contextoValido({
      consentimiento: { optInAt: '2026-01-01', optInSource: null, revokedAt: null },
    });
    expect(evaluarEnvio(ctxSinFuente).motivos).toContain('sin_consentimiento');

    const ctxRevocado = contextoValido({
      consentimiento: { optInAt: '2026-01-01', optInSource: 'web', revokedAt: '2026-05-01' },
    });
    expect(evaluarEnvio(ctxRevocado).motivos).toContain('consentimiento_revocado');
  });

  it('R4: Bloquea si el número está en el REPEP de PROFECO (para marketing)', () => {
    const ctx = contextoValido({
      proposito: 'promocion',
      repep: { listaVigente: true, registrado: true },
    });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('repep_registrado');
  });

  it('R4: Bloquea fail-closed si la lista de REPEP no está vigente (para marketing)', () => {
    const ctx = contextoValido({
      proposito: 'promocion',
      repep: { listaVigente: false, registrado: false },
    });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('repep_lista_no_vigente');
  });

  it('R4: REPEP NO aplica a avisos institucionales ni a transaccionales', () => {
    const ctxAviso = contextoValido({
      proposito: 'aviso',
      plantilla: plantillaValida({ categoria: 'avisos' }),
      repep: { listaVigente: false, registrado: true }, // Aunque no haya lista o esté registrado
    });
    const res = evaluarEnvio(ctxAviso);
    expect(res.decision).toBe('enviar');
  });

  it('R5: Quiet Hours: si son las 23:00 difiere para la siguiente apertura a las 08:00', () => {
    // 23:00 hora Mérida (UTC-6) -> 05:00 UTC día siguiente
    const noche = new Date('2026-10-30T05:00:00Z');
    const ctx = contextoValido({ ahora: noche, tzContacto: 'America/Merida' });

    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('diferir');
    expect(res.diferirHasta).toBeDefined();
  });

  it('R6: Frequency Cap: bloquea si ya alcanzó el máximo semanal de impactos comerciales', () => {
    const ctx = contextoValido({
      frecuencia: { enviadosVentana: 2, maximo: 2 },
    });
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('frecuencia_excedida');
  });

  it('R7: Plantillas: bloquea si la plantilla no está aprobada o faltan variables', () => {
    const ctxPending = contextoValido({
      plantilla: plantillaValida({ status: 'PENDING' }),
    });
    expect(evaluarEnvio(ctxPending).motivos).toContain('plantilla_no_aprobada');

    const ctxSinVar = contextoValido({
      variables: {}, // falta {{nombre}}
    });
    expect(evaluarEnvio(ctxSinVar).motivos).toContain('plantilla_variables_faltantes');
  });

  it('Envío exitoso en campaña: renderiza con firma de marca', () => {
    const ctx = contextoValido();
    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('enviar');
    expect(res.motivos).toHaveLength(0);
    expect(res.textoRenderizado).toContain('Don Pedro');
    expect(res.textoRenderizado).toContain('CANACO SERVYTUR Mérida');
  });

  it('Modo respuesta: permite texto libre sólo dentro de la ventana de 24h de WhatsApp', () => {
    const ahora = new Date('2026-10-29T18:00:00Z');
    const hace2Horas = new Date(ahora.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const hace30Horas = new Date(ahora.getTime() - 30 * 60 * 60 * 1000).toISOString();

    const ctxValidoRespuesta = contextoValido({
      modo: 'respuesta',
      plantilla: null,
      textoLibre: 'Estimado socio, con gusto le enviamos los datos.',
      ultimaRespuestaAt: hace2Horas,
    });
    expect(evaluarEnvio(ctxValidoRespuesta).decision).toBe('enviar');

    const ctxExpirado = contextoValido({
      modo: 'respuesta',
      plantilla: null,
      textoLibre: 'Hola de nuevo',
      ultimaRespuestaAt: hace30Horas,
    });
    expect(evaluarEnvio(ctxExpirado).motivos).toContain('texto_libre_fuera_de_ventana');
  });
});
