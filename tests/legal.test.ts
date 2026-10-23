import { describe, expect, it } from 'vitest';
import { catalogoReglas, evaluarMensaje } from '../src/legal/motor';
import { contieneIdentidadLegal, extraerClabes, sanearAmenazas } from '../src/legal/sanitizador';
import type { ContextoLegal } from '../src/legal/tipos';

function ctx(overrides: Partial<ContextoLegal> = {}): ContextoLegal {
  return {
    ahora: new Date('2026-10-20T16:00:00Z'), // 10:00 hora CDMX
    canal: 'whatsapp',
    mensaje: 'Hola, tu saldo pendiente es $8,450.00. Responde a este mensaje.',
    nombreLegal: 'Arkelangel, S.A. de C.V.',
    condusef: '123456',
    clienteId: 'cli_1',
    clienteNombre: 'Juan Perez',
    telefono: '+525511110001',
    email: null,
    montoCents: 845000,
    contrato: null,
    contactos24h: 0,
    logsReales: 0,
    logsCrm: 0,
    dominiosPermitidos: ['prestamoclaro.com'],
    maxContactos24h: 3,
    ventanaContacto: { inicio: 8, fin: 22 },
    toleranciaCents: 0,
    esRespuesta: false,
    ...overrides,
  };
}

function reglasDe(resultado: { violaciones: { reglaId: string }[] }): string[] {
  return resultado.violaciones.map((v) => v.reglaId);
}

describe('catálogo legal', () => {
  it('contiene las 12 reglas del catálogo', () => {
    const ids = catalogoReglas()
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([
      '1.1',
      '1.2',
      '2.1',
      '2.3',
      '2.4',
      '3.1',
      '3.2',
      '4.2',
      '4.4',
      '5.2',
      '8.1',
      '8.7',
    ]);
  });

  it('cada regla trae su base legal', () => {
    for (const regla of catalogoReglas()) {
      expect(regla.ley.length).toBeGreaterThan(0);
      expect(regla.articulo.length).toBeGreaterThan(0);
      expect(regla.castigo.length).toBeGreaterThan(0);
    }
  });
});

describe('regla 1.1 — identidad corporativa', () => {
  it('repara el mensaje agregando la razón social y el registro CONDUSEF', () => {
    const resultado = evaluarMensaje(ctx());
    expect(resultado.permitido).toBe(true);
    expect(reglasDe(resultado)).toContain('1.1');
    expect(resultado.violaciones.find((v) => v.reglaId === '1.1')?.accion).toBe('SANITIZE');
    expect(contieneIdentidadLegal(resultado.mensaje, 'Arkelangel, S.A. de C.V.')).toBe(true);
  });

  it('bloquea si el agente no tiene razón social configurada (fail-closed)', () => {
    const resultado = evaluarMensaje(ctx({ nombreLegal: '' }));
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('1.1');
  });

  it('no modifica un mensaje que ya se identifica', () => {
    const mensaje = 'Hola, soy Arkelangel, S.A. de C.V. Tu saldo es $8,450.00.';
    const resultado = evaluarMensaje(ctx({ mensaje }));
    expect(resultado.violaciones.find((v) => v.reglaId === '1.1')).toBeUndefined();
  });
});

describe('regla 1.2 — representación sin poder legal', () => {
  it('elimina la frase donde el agente se presenta como abogado', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, habla su abogado. Tu saldo pendiente es $8,450.00.' })
    );
    expect(resultado.permitido).toBe(true);
    expect(resultado.mensaje.toLowerCase()).not.toContain('abogado');
  });
});

describe('regla 2.1 — amenaza fuera de proceso', () => {
  it('elimina la amenaza de embargo', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, tu saldo es $8,450.00. Te vamos a embargar mañana. Responde.' })
    );
    expect(resultado.permitido).toBe(true);
    expect(resultado.mensaje.toLowerCase()).not.toContain('embargar');
    expect(reglasDe(resultado)).toContain('2.1');
  });

  it('el saneador conserva el resto del mensaje', () => {
    const saneado = sanearAmenazas('Hola, tu saldo es $8,450.00. Te vamos a embargar mañana.');
    expect(saneado.texto).toContain('$8,450.00');
    expect(saneado.texto.toLowerCase()).not.toContain('embargar');
  });
});

describe('regla 2.3 — hostigamiento continuo', () => {
  it('bloquea el cuarto impacto en 24 h', () => {
    const resultado = evaluarMensaje(ctx({ contactos24h: 3 }));
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('2.3');
  });

  it('permite el tercero', () => {
    expect(evaluarMensaje(ctx({ contactos24h: 2 })).permitido).toBe(true);
  });

  it('no cuenta una respuesta al deudor', () => {
    const resultado = evaluarMensaje(
      ctx({ contactos24h: 5, esRespuesta: true, respuestaExenta: true })
    );
    expect(resultado.permitido).toBe(true);
  });
});

describe('regla 2.4 — horario prohibido', () => {
  it('bloquea a las 03:00 hora CDMX', () => {
    const resultado = evaluarMensaje(ctx({ ahora: new Date('2026-10-20T09:00:00Z') }));
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('2.4');
  });

  it('permite a las 10:00 hora CDMX', () => {
    expect(evaluarMensaje(ctx()).permitido).toBe(true);
  });

  it('la ventana se evalúa en la zona horaria del tenant', () => {
    // 09:00 UTC = 03:00 CDMX (fuera) pero 03:00 UTC (dentro, de 8 a 22).
    const instante = new Date('2026-10-20T09:00:00Z');

    const enCdmx = evaluarMensaje(ctx({ ahora: instante, zonaHoraria: 'America/Mexico_City' }));
    expect(enCdmx.permitido).toBe(false);

    const enUtc = evaluarMensaje(ctx({ ahora: instante, zonaHoraria: 'UTC' }));
    expect(enUtc.permitido).toBe(true);
  });

  it('sin zona declarada se usa la del marco normativo (CDMX)', () => {
    const instante = new Date('2026-10-20T09:00:00Z');
    expect(evaluarMensaje(ctx({ ahora: instante })).permitido).toBe(false);
  });
});

describe('regla 3.1 — smishing', () => {
  it('elimina links a dominios no autorizados', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, paga en https://cobro-falso.com/pagar. Tu saldo es $8,450.00.' })
    );
    expect(resultado.permitido).toBe(true);
    expect(resultado.mensaje).not.toContain('cobro-falso.com');
  });

  it('conserva los links del dominio permitido', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, paga en https://prestamoclaro.com/pago. Tu saldo es $8,450.00.' })
    );
    expect(resultado.mensaje).toContain('prestamoclaro.com');
    expect(resultado.violaciones.find((v) => v.reglaId === '3.1')).toBeUndefined();
  });

  it('con allowlist vacía elimina cualquier link (política "sin links")', () => {
    const resultado = evaluarMensaje(
      ctx({
        mensaje: 'Hola, paga en https://prestamoclaro.com/pago. Tu saldo es $8,450.00.',
        dominiosPermitidos: [],
      })
    );
    expect(resultado.mensaje).not.toContain('prestamoclaro.com');
    expect(resultado.violaciones.find((v) => v.reglaId === '3.1')?.accion).toBe('SANITIZE');
  });
});

describe('regla 3.2 — destino de pago trazable', () => {
  it('bloquea una CLABE sin contrato que la respalde', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, transfiere a la CLABE 012180012345678901. Tu saldo es $8,450.00.' })
    );
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('3.2');
  });

  it('acepta la CLABE que sí está en el contrato', () => {
    const resultado = evaluarMensaje(
      ctx({
        mensaje: 'Hola, transfiere a la CLABE 012180012345678901. Tu saldo es $8,450.00.',
        contrato: {
          id: 'con_1',
          client_id: 'cli_1',
          monto_pactado_cents: 845000,
          tasa_pct: null,
          clabe: '012180012345678901',
          nombre_legal: 'Arkelangel, S.A. de C.V.',
          condusef: '123456',
          created_at: '',
          updated_at: '',
        },
      })
    );
    expect(resultado.permitido).toBe(true);
  });

  it('extrae CLABEs de 16 a 18 dígitos', () => {
    expect(extraerClabes('paga a la 012180012345678901 hoy')).toEqual(['012180012345678901']);
  });
});

describe('regla 4.2 — interés sobre interés no pactado', () => {
  it('bloquea cuando el monto supera lo pactado', () => {
    const resultado = evaluarMensaje(
      ctx({
        montoCents: 900000,
        contrato: {
          id: 'con_1',
          client_id: 'cli_1',
          monto_pactado_cents: 845000,
          tasa_pct: null,
          clabe: null,
          nombre_legal: null,
          condusef: null,
          created_at: '',
          updated_at: '',
        },
      })
    );
    expect(resultado.permitido).toBe(false);
    expect(['4.2', '8.1']).toContain(resultado.bloqueadoPor);
  });
});

describe('regla 4.4 — extorsión por contactos', () => {
  it('elimina la amenaza de avisar a contactos', () => {
    const resultado = evaluarMensaje(
      ctx({ mensaje: 'Hola, tu saldo es $8,450.00. Avisaremos a tus contactos si no pagas.' })
    );
    expect(resultado.permitido).toBe(true);
    expect(resultado.mensaje.toLowerCase()).not.toContain('contactos');
  });
});

describe('regla 5.2 — simulación de orden judicial', () => {
  it('bloquea documentos con apariencia judicial', () => {
    const resultado = evaluarMensaje(ctx({ adjuntos: ['orden_juzgado_sello.pdf'] }));
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('5.2');
  });
});

describe('regla 8.1 — contrato vs CRM', () => {
  it('bloquea cuando el CRM y el contrato difieren', () => {
    const resultado = evaluarMensaje(
      ctx({
        montoCents: 845000,
        contrato: {
          id: 'con_1',
          client_id: 'cli_1',
          monto_pactado_cents: 1200000,
          tasa_pct: null,
          clabe: null,
          nombre_legal: null,
          condusef: null,
          created_at: '',
          updated_at: '',
        },
      })
    );
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('8.1');
  });
});

describe('regla 8.7 — falsedad de registros', () => {
  it('bloquea si el CRM declara más contactos de los que salieron', () => {
    const resultado = evaluarMensaje(ctx({ logsCrm: 1, logsReales: 4 }));
    expect(resultado.permitido).toBe(false);
    expect(resultado.bloqueadoPor).toBe('8.7');
  });

  it('permite cuando los registros coinciden', () => {
    expect(evaluarMensaje(ctx({ logsCrm: 2, logsReales: 2 })).permitido).toBe(true);
  });
});

describe('motor de cumplimiento', () => {
  it('permite un mensaje limpio', () => {
    const resultado = evaluarMensaje(ctx());
    expect(resultado.permitido).toBe(true);
    expect(resultado.bloqueadoPor).toBeNull();
  });

  it('acumula varias violaciones y queda bloqueado', () => {
    const resultado = evaluarMensaje(
      ctx({
        mensaje: 'Hola, tu abogado dice que te vamos a embargar y avisaremos a tus contactos.',
        contactos24h: 3,
        logsCrm: 1,
        logsReales: 4,
      })
    );
    expect(resultado.permitido).toBe(false);
    expect(reglasDe(resultado)).toEqual(expect.arrayContaining(['2.1', '2.3', '4.4', '8.7']));
  });

  it('deja huella legal: ley, artículo y castigo en la violación', () => {
    const resultado = evaluarMensaje(ctx({ contactos24h: 3 }));
    const violacion = resultado.violaciones.find((v) => v.reglaId === '2.3');
    expect(violacion?.ley).toContain('NOM-184');
    expect(violacion?.articulo).toContain('284 Bis');
    expect(violacion?.castigo.length).toBeGreaterThan(0);
  });
});

describe('auditoría de las 48 conductas prohibidas (Mapa Legal)', () => {
  it('1.2/1.5: elimina usurpación de Institución de Crédito o inspectores de PROFECO/SAT', () => {
    const res = evaluarMensaje(
      ctx({
        mensaje:
          'Somos una institución de crédito y el inspector de PROFECO revisará tu saldo de $8,450.00.',
      })
    );
    expect(res.permitido).toBe(true);
    expect(reglasDe(res)).toContain('1.2');
    expect(res.mensaje.toLowerCase()).not.toContain('institución de crédito');
    expect(res.mensaje.toLowerCase()).not.toContain('inspector de profeco');
  });

  it('2.1 (Conducta 2.3 PDF): elimina amenazas de acceso directo al dispositivo o fotos', () => {
    const res = evaluarMensaje(
      ctx({
        mensaje:
          'Paga tu saldo de $8,450.00. Tenemos acceso directo a tu dispositivo y descargamos tus fotos.',
      })
    );
    expect(res.permitido).toBe(true);
    expect(reglasDe(res)).toContain('2.1');
    expect(res.mensaje.toLowerCase()).not.toContain('acceso directo a tu dispositivo');
    expect(res.mensaje.toLowerCase()).not.toContain('descargamos tus fotos');
  });

  it('2.3 (Conductas 2.7/8.3/8.4 PDF): bloquea cobro anticipado Día T-1 (deuda aún no vencida)', () => {
    const res = evaluarMensaje(
      ctx({
        ahora: new Date('2026-10-20T16:00:00Z'), // hoy = 2026-10-20 en CDMX
        fechaVencimiento: '2026-10-21', // vence mañana (T-1)
      })
    );
    expect(res.permitido).toBe(false);
    expect(res.bloqueadoPor).toBe('2.3');
  });

  it('3.1 (Conductas 3.1/3.3 PDF): elimina acortadores bit.ly sin https y plantillas de smishing Microsoft', () => {
    const res = evaluarMensaje(
      ctx({
        mensaje:
          'Cargo ppro*microsoft detectado. Liquida tu saldo de $8,450.00 en bit.ly/cobro-urgente hoy.',
      })
    );
    expect(res.permitido).toBe(true);
    expect(reglasDe(res)).toContain('3.1');
    expect(res.mensaje.toLowerCase()).not.toContain('bit.ly');
    expect(res.mensaje.toLowerCase()).not.toContain('ppro*microsoft');
  });

  it('3.2 (Conductas 3.5/3.6/7.1 PDF): bloquea tarjetas separadas por espacios/guiones y desvíos a cuenta personal u OXXO', () => {
    const conTarjetaSeparada = evaluarMensaje(
      ctx({
        mensaje: 'Deposita $8,450.00 a la tarjeta 4152 3133 4455 6677 hoy mismo.',
        contrato: {
          id: 'con_1',
          client_id: 'cli_1',
          monto_pactado_cents: 845000,
          tasa_pct: 12,
          clabe: '012180012345678901',
          nombre_legal: 'Arkelangel, S.A. de C.V.',
          condusef: '123456',
          created_at: '',
          updated_at: '',
        },
      })
    );
    expect(conTarjetaSeparada.permitido).toBe(false);
    expect(conTarjetaSeparada.bloqueadoPor).toBe('3.2');

    const conCuentaPersonal = evaluarMensaje(
      ctx({
        mensaje: 'Tu saldo es $8,450.00, deposita en OXXO a cuenta personal del gestor.',
      })
    );
    expect(conCuentaPersonal.permitido).toBe(false);
    expect(conCuentaPersonal.bloqueadoPor).toBe('3.2');
  });

  it('4.2 (Conductas 4.5/8.6 PDF): bloquea tasa moratoria diaria usuraria (3% diario) o mayor a la del contrato', () => {
    const usuraria = evaluarMensaje(
      ctx({
        mensaje: 'Tu saldo es $8,450.00 con tasa de mora del 3% diario a partir de hoy.',
      })
    );
    expect(usuraria.permitido).toBe(false);
    expect(usuraria.bloqueadoPor).toBe('4.2');

    const contradiceContrato = evaluarMensaje(
      ctx({
        mensaje: 'Tu saldo es $8,450.00 con interés moratorio del 5% mensual.',
        contrato: {
          id: 'con_1',
          client_id: 'cli_1',
          monto_pactado_cents: 845000,
          tasa_pct: 2,
          clabe: '012180012345678901',
          nombre_legal: 'Arkelangel, S.A. de C.V.',
          condusef: '123456',
          created_at: '',
          updated_at: '',
        },
      })
    );
    expect(contradiceContrato.permitido).toBe(false);
    expect(contradiceContrato.bloqueadoPor).toBe('4.2');
  });

  it('4.4 (Conductas 2.4/2.6 PDF): elimina amenazas de boletines, recursos humanos y redes sociales', () => {
    const res = evaluarMensaje(
      ctx({
        mensaje:
          'Tu saldo es $8,450.00. Emitiremos un boletín a recursos humanos de tu trabajo y en redes sociales.',
      })
    );
    expect(res.permitido).toBe(true);
    expect(reglasDe(res)).toContain('4.4');
    expect(res.mensaje.toLowerCase()).not.toContain('boletín');
    expect(res.mensaje.toLowerCase()).not.toContain('recursos humanos');
  });
});
