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
