/**
 * Tests del spike de voz (Tarea 2).
 *
 * QuÃ© se prueba aquÃ­ y quÃ© NO:
 * Â· Se prueba el estado del DO, la acumulaciÃ³n de mÃ©tricas, el percentil y el
 *   pipeline con dobles (STT/TTS/LLM falsos). Eso es lÃ³gica pura: no abre
 *   sockets ni toca la red.
 * Â· NO se prueba una llamada real: eso requiere credenciales de Deepgram y de
 *   Cloudflare Realtime (ver `docs/spike-voz.md`). Nada de esto simula voz:
 *   cuando faltan credenciales, el cÃ³digo falla explÃ­citamente.
 */

import { describe, expect, it } from 'vitest';
import {
  AlmacenamientoMemoria,
  CallSessionDO,
  METRICAS_VOZ,
  type EstadoSesion,
} from '../src/durable/call-session';
import { percentil, resumenMetrica, resumenMetricas } from '../src/lib/medidas';
import { platformPrincipal, tenantPrincipal } from '../src/auth/principal';
import { PipelineVozImpl, type MetricasTurno } from '../src/orquestacion/voice';
import { crearStt, urlSttWorkersAi, type SttLike } from '../src/voice/stt';
import { crearTts, urlTtsWorkersAi, type TtsLike } from '../src/voice/tts';
import { puedeOmitirRealtime, spikeVozHabilitado } from '../src/routes/spike';
import type { Env } from '../src/types/env';

/* â”€â”€ Dobles de prueba â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

class SttFalso implements SttLike {
  abierto = false;
  cerrado = false;
  enviados: Uint8Array[] = [];
  private eventos: {
    onParcial?: (texto: string, momento: number) => void;
    onFinal?: (texto: string, momento: number) => void;
  } = {};

  conectar(eventos: {
    onParcial?: (texto: string, momento: number) => void;
    onFinal?: (texto: string, momento: number) => void;
  }): void {
    this.eventos = eventos;
  }

  async abrir(): Promise<void> {
    this.abierto = true;
  }

  enviar(pcm: Uint8Array): void {
    this.enviados.push(pcm);
  }

  cerrar(): void {
    this.cerrado = true;
  }

  emiteParcial(texto: string, momento: number): void {
    this.eventos.onParcial?.(texto, momento);
  }

  emiteFinal(texto: string, momento: number): void {
    this.eventos.onFinal?.(texto, momento);
  }
}

class TtsFalso implements TtsLike {
  cancelado = false;
  cerrado = false;
  hablo = false;
  texto = '';
  /** Si es true, `hablar()` no resuelve hasta que se llame `terminar()`. */
  colgar = false;
  /**
   * Si es true, `hablar()` no anuncia primer fragmento: simula una locución
   * que se corta (barge-in) antes de que llegue audio.
   */
  sinPrimerChunk = false;
  private resolverHablar: (() => void) | null = null;
  private alRecibir: (chunk: ArrayBuffer) => void = () => {};
  /** Reloj del doble (lo inyecta la prueba). */
  momento: () => number = () => Date.now();
  onPrimerChunk: ((momento: number) => void) | null = null;

  conectar(alRecibir: (chunk: ArrayBuffer) => void): void {
    this.alRecibir = alRecibir;
  }

  async hablar(texto: string): Promise<void> {
    this.hablo = true;
    this.texto = texto;
    if (this.colgar) {
      await new Promise<void>((resolver) => {
        this.resolverHablar = resolver;
      });
    }
    if (!this.sinPrimerChunk) this.onPrimerChunk?.(this.momento());
    this.alRecibir(new ArrayBuffer(64));
  }

  terminar(): void {
    this.resolverHablar?.();
    this.resolverHablar = null;
  }

  cancelar(): void {
    this.cancelado = true;
    this.resolverHablar?.();
    this.resolverHablar = null;
  }

  cerrar(): void {
    this.cerrado = true;
  }
}

/** Reloj falso: cada `avanza()` mueve el tiempo. */
function relojFalso(inicio = 1_000) {
  let ahora = inicio;
  return {
    ahora: () => ahora,
    avanza: (ms: number) => {
      ahora += ms;
      return ahora;
    },
  };
}

function entornoVacio(): Env {
  return { ENVIRONMENT: 'test' } as unknown as Env;
}

/* â”€â”€ Percentiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe('percentiles de latencia', () => {
  it('devuelve null sin muestras', () => {
    expect(percentil([], 50)).toBeNull();
    expect(resumenMetrica([]).p50).toBeNull();
  });

  it('con 20 muestras, p50 es la 10Âª y p95 la 19Âª (nearest rank)', () => {
    const muestras = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentil(muestras, 50)).toBe(100);
    expect(percentil(muestras, 95)).toBe(190);
    expect(percentil(muestras, 0)).toBe(10);
    expect(percentil(muestras, 100)).toBe(200);
  });

  it('ignora las muestras no finitas', () => {
    expect(percentil([10, Number.NaN, 20, Infinity], 50)).toBe(10);
  });

  it('el resumen trae n, min, p50, p95, max y media', () => {
    const resumen = resumenMetrica([100, 200, 300, 400]);
    expect(resumen.n).toBe(4);
    expect(resumen.min).toBe(100);
    expect(resumen.max).toBe(400);
    expect(resumen.p50).toBe(200);
    expect(resumen.p95).toBe(400);
    expect(resumen.media).toBe(250);
  });

  it('resumenMetricas resume todas las mÃ©tricas del spike', () => {
    const resumen = resumenMetricas({
      round_trip_ms: [500, 700],
      tts_first_chunk_ms: [100, 200],
    });
    expect(Object.keys(resumen).sort()).toEqual(['round_trip_ms', 'tts_first_chunk_ms']);
    expect(resumen['round_trip_ms']?.p95).toBe(700);
  });
});

/* â”€â”€ Durable Object de la llamada â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe('CallSessionDO', () => {
  function nuevoDO() {
    return new CallSessionDO({ storage: new AlmacenamientoMemoria() }, entornoVacio());
  }

  async function iniciar(do_: CallSessionDO, traceId = 'trace-1'): Promise<EstadoSesion> {
    const respuesta = await do_.fetch(
      new Request('https://call-session/iniciar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: 'spk_1', tenantId: 't_alfa', traceId }),
      })
    );
    expect(respuesta.status).toBe(200);
    return (await respuesta.json()) as EstadoSesion;
  }

  it('exige callId y tenantId al iniciar', async () => {
    const do_ = nuevoDO();
    const respuesta = await do_.fetch(
      new Request('https://call-session/iniciar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: 't_alfa' }),
      })
    );
    expect(respuesta.status).toBe(400);
  });

  it('la llamada arranca en ringing y lleva el traceId', async () => {
    const do_ = nuevoDO();
    await iniciar(do_, 'trace-abc');
    const respuesta = await do_.fetch(new Request('https://call-session/estado'));
    const estado = (await respuesta.json()) as EstadoSesion & { resumen: unknown };
    expect(estado.estado).toBe('ringing');
    expect(estado.traceId).toBe('trace-abc');
    expect(estado.tenantId).toBe('t_alfa');
    expect(estado.turnos).toBe(0);
    expect(estado.resumen).toBeDefined();
  });

  it('acumula las mÃ©tricas de cada turno y pasa a active', async () => {
    const do_ = nuevoDO();
    await iniciar(do_);

    const respuesta = await do_.fetch(
      new Request('https://call-session/turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricas: {
            stt_partial_ms: 120,
            stt_final_ms: 800,
            llm_first_token_ms: 400,
            llm_total_ms: 450,
            tts_first_chunk_ms: 200,
            round_trip_ms: 1000,
            barge_in_latency_ms: null,
          },
        }),
      })
    );
    expect(respuesta.status).toBe(200);

    const estadoRespuesta = await do_.fetch(new Request('https://call-session/estado'));
    const estado = (await estadoRespuesta.json()) as EstadoSesion & {
      resumen: Record<string, { p50: number | null; n: number }>;
    };
    expect(estado.estado).toBe('active');
    expect(estado.turnos).toBe(1);
    expect(estado.metricas.round_trip_ms).toEqual([1000]);
    expect(estado.metricas.stt_partial_ms).toEqual([120]);
    expect(estado.resumen['round_trip_ms']?.p50).toBe(1000);
    expect(estado.resumen['round_trip_ms']?.n).toBe(1);
    // Las mÃ©tricas sin valor no se inventan.
    expect(estado.metricas.barge_in_latency_ms).toEqual([]);
  });

  it('ignora mÃ©tricas que no son nÃºmeros', async () => {
    const do_ = nuevoDO();
    await iniciar(do_);
    await do_.fetch(
      new Request('https://call-session/turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricas: { round_trip_ms: 'mucho', stt_final_ms: 42, extra_ms: 99 },
        }),
      })
    );
    const estado = (await (
      await do_.fetch(new Request('https://call-session/estado'))
    ).json()) as EstadoSesion;
    expect(estado.metricas.round_trip_ms).toEqual([]);
    expect(estado.metricas.stt_final_ms).toEqual([42]);
  });

  it('el barge-in cuenta la interrupciÃ³n y guarda la latencia', async () => {
    const do_ = nuevoDO();
    await iniciar(do_);
    const respuesta = await do_.fetch(
      new Request('https://call-session/cortar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bargeInLatencyMs: 35 }),
      })
    );
    expect(respuesta.status).toBe(200);
    const estado = (await (
      await do_.fetch(new Request('https://call-session/estado'))
    ).json()) as EstadoSesion;
    expect(estado.interrumpidas).toBe(1);
    expect(estado.metricas.barge_in_latency_ms).toEqual([35]);
  });

  it('colgar deja la llamada en ended', async () => {
    const do_ = nuevoDO();
    await iniciar(do_);
    await do_.fetch(new Request('https://call-session/colgar', { method: 'POST' }));
    const estado = (await (
      await do_.fetch(new Request('https://call-session/estado'))
    ).json()) as EstadoSesion;
    expect(estado.estado).toBe('ended');
    expect(estado.terminadaEn).toBeGreaterThan(0);
  });

  it('el estado de una llamada inexistente es 404', async () => {
    const do_ = nuevoDO();
    const respuesta = await do_.fetch(new Request('https://call-session/estado'));
    expect(respuesta.status).toBe(404);
  });

  it('sin credenciales de Workers AI no hay pipeline: el DO no inventa voz', async () => {
    const do_ = nuevoDO();
    await iniciar(do_);
    const respuesta = await do_.fetch(
      new Request('https://call-session/audio', { headers: { Upgrade: 'websocket' } })
    );
    // El runtime real devuelve 101; en el doble de pruebas no hay WebSocketPair.
    expect([101, 426]).toContain(respuesta.status);
    const estado = (await (
      await do_.fetch(new Request('https://call-session/estado'))
    ).json()) as EstadoSesion;
    expect(estado.estado).toBe('ringing');
  });

  it('declara las siete mÃ©tricas del spike', () => {
    expect(METRICAS_VOZ).toEqual([
      'stt_partial_ms',
      'stt_final_ms',
      'llm_first_token_ms',
      'llm_total_ms',
      'tts_first_chunk_ms',
      'round_trip_ms',
      'barge_in_latency_ms',
    ]);
  });
});

/* â”€â”€ Pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe('pipeline de voz', () => {
  /** Monta un pipeline con STT y TTS falsos y reloj controlable. */
  function montar(
    opciones: { colgarTts?: boolean; bloquearLlm?: boolean; sinPrimerChunk?: boolean } = {}
  ) {
    const reloj = relojFalso(1000);
    const eventos: string[] = [];
    const metricas: MetricasTurno[] = [];
    const stt = new SttFalso();
    const tts = new TtsFalso();
    tts.colgar = opciones.colgarTts ?? false;
    tts.sinPrimerChunk = opciones.sinPrimerChunk ?? false;
    /** Callback real del pipeline para el primer fragmento de audio. */
    let primerChunk: ((momento: number) => void) | null = null;
    /** Libera al LLM cuando la prueba lo deja en vuelo. */
    let soltarLlm: (() => void) | null = null;
    /** Cuántas veces se ha pedido redacción al LLM. */
    let llamadasLlm = 0;

    const pipeline = new PipelineVozImpl({
      env: entornoVacio(),
      callId: 'spk_1',
      tenantId: 't_alfa',
      traceId: 'trace-1',
      cliente: {
        nombre: 'Cliente de prueba',
        montoCents: 125_000,
        fechaVencimiento: '2026-10-01',
        diasRetraso: 20,
        band: 'medio',
        nombreLegal: 'Spike Arkangel (prueba)',
        condusef: '000000',
      },
      alEvento: (evento) => {
        eventos.push(evento.tipo);
        if (evento.tipo === 'fin_turno') metricas.push(evento.metricas);
      },
      crearStt: (eventosStt) => {
        stt.conectar(eventosStt);
        return stt;
      },
      crearTts: (alRecibir, onPrimerChunk) => {
        primerChunk = onPrimerChunk;
        // El doble simula que el proveedor tarda 120 ms en el primer audio.
        tts.onPrimerChunk = () => {
          reloj.avanza(120);
          onPrimerChunk(reloj.ahora());
        };
        tts.conectar(alRecibir);
        return tts;
      },
      redactar: async () => {
        llamadasLlm += 1;
        // Con `bloquearLlm` se deja en vuelo **el segundo** turno: el primero
        // se completa para tener un turno ya cerrado.
        if (opciones.bloquearLlm && llamadasLlm > 1) {
          await new Promise<void>((resolver) => {
            soltarLlm = resolver;
          });
        }
        reloj.avanza(300);
        return { body: 'Hola, tu saldo pendiente vence pronto.', source: 'ai' };
      },
      ahora: reloj.ahora,
    });

    return {
      pipeline,
      reloj,
      eventos,
      metricas,
      stt,
      tts,
      primerChunk: () => primerChunk,
      soltarLlm: () => soltarLlm?.(),
    };
  }

  it('un turno completo deja las mÃ©tricas de latencia', async () => {
    const { pipeline, reloj, eventos, metricas, stt, tts } = montar();

    // El usuario empieza a hablar.
    pipeline.recibirAudio(new ArrayBuffer(320));
    reloj.avanza(200);
    stt.emiteParcial('hola', reloj.ahora());
    reloj.avanza(300);
    stt.emiteFinal('hola, buenos dÃ­as', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));

    expect(eventos).toContain('final');
    expect(eventos).toContain('fin_turno');
    const m = metricas[0]!;
    expect(m.stt_partial_ms).toBe(200);
    expect(m.stt_final_ms).toBe(500);
    expect(m.llm_total_ms).toBe(300);
    expect(m.llm_first_token_ms).toBe(300);
    expect(m.tts_first_chunk_ms).toBe(120);
    expect(m.round_trip_ms).toBe(420);
    expect(m.barge_in_latency_ms).toBeNull();
    expect(tts.texto).toBe('Hola, tu saldo pendiente vence pronto.');
  });

  it('un fragmento de audio tardío no inventa la latencia de un turno', async () => {
    const { pipeline, reloj, metricas, stt, primerChunk, soltarLlm } = montar({
      bloquearLlm: true,
      sinPrimerChunk: true,
    });

    // Turno 1: el bot habla (sin fragmento: se corta antes de que llegue audio).
    pipeline.recibirAudio(new ArrayBuffer(320));
    reloj.avanza(200);
    stt.emiteParcial('hola', reloj.ahora());
    reloj.avanza(300);
    stt.emiteFinal('hola, buenos días', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));
    expect(metricas).toHaveLength(1);

    // Turno 2: el LLM queda en vuelo (el usuario volvió a hablar).
    reloj.avanza(500);
    stt.emiteFinal('otra cosa', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));

    // Llega un fragmento tardío de la locución anterior, cuando el turno 2
    // todavía no ha empezado a hablar: no se le puede atribuir a nadie.
    reloj.avanza(9999);
    primerChunk()?.(reloj.ahora());

    soltarLlm();
    await new Promise((resolver) => setTimeout(resolver, 0));

    const m = metricas[1]!;
    expect(m).toBeDefined();
    // Sin atribuir el fragmento a un turno, la latencia de audio salía con el
    // `Date.now()` entero (≈1,8 billones) en lugar de milisegundos.
    expect(m.tts_first_chunk_ms ?? 0).toBeLessThan(5000);
    expect(m.round_trip_ms ?? 0).toBeLessThan(60_000);
  });

  it('un parcial durante la locuciÃ³n corta el TTS (barge-in) y mide la latencia', async () => {
    const { pipeline, reloj, eventos, stt, tts } = montar({ colgarTts: true });

    // El bot empieza a locutar y se queda hablando.
    pipeline.recibirAudio(new ArrayBuffer(320));
    stt.emiteFinal('hola', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));
    expect(tts.hablo).toBe(true);
    expect(pipeline.locutando()).toBe(true);

    // El usuario interrumpe: llega un parcial mientras el bot habla.
    const antes = eventos.length;
    reloj.avanza(15);
    stt.emiteParcial('espere', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));

    expect(eventos.slice(antes)).toContain('barge_in');
    expect(tts.cancelado).toBe(true);
    expect(pipeline.locutando()).toBe(false);
  });

  it('el LLM se llama en modo lectura con redactMessage', async () => {
    const reloj = relojFalso();
    const stt = new SttFalso();
    const tts = new TtsFalso();
    let recibido: unknown = null;

    const pipeline = new PipelineVozImpl({
      env: entornoVacio(),
      callId: 'spk_1',
      tenantId: 't_alfa',
      traceId: 'trace-1',
      cliente: {
        nombre: 'Cliente',
        montoCents: 125_000,
        fechaVencimiento: '2026-10-01',
        diasRetraso: 20,
        band: 'medio',
      },
      alEvento: () => {},
      crearStt: (eventosStt) => {
        stt.conectar(eventosStt);
        return stt;
      },
      crearTts: (alRecibir, onPrimerChunk) => {
        tts.onPrimerChunk = onPrimerChunk;
        tts.conectar(alRecibir);
        return tts;
      },
      redactar: async (_env, params) => {
        recibido = params;
        return { body: 'texto', source: 'ai' };
      },
      ahora: reloj.ahora,
    });

    pipeline.recibirAudio(new ArrayBuffer(320));
    stt.emiteFinal('hola', reloj.ahora());
    await new Promise((resolver) => setTimeout(resolver, 0));

    expect(recibido).not.toBeNull();
    expect((recibido as { channel: string }).channel).toBe('sms');
    expect((recibido as { amountCents: number }).amountCents).toBe(125_000);
    expect(tts.texto).toBe('texto');
  });
});

/* â”€â”€ Feature flag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe('flag del spike', () => {
  it('sÃ³lo con SPIKE_VOZ_ENABLED=true el spike estÃ¡ encendido', () => {
    expect(spikeVozHabilitado({ SPIKE_VOZ_ENABLED: 'true' } as unknown as Env)).toBe(true);
    expect(spikeVozHabilitado({ SPIKE_VOZ_ENABLED: 'false' } as unknown as Env)).toBe(false);
    expect(spikeVozHabilitado({} as unknown as Env)).toBe(false);
    expect(spikeVozHabilitado({ SPIKE_VOZ_ENABLED: '1' } as unknown as Env)).toBe(false);
  });
});

describe('credenciales de voz (Workers AI)', () => {
  it('sin token ni cuenta no hay STT ni TTS: el spike no simula voz', () => {
    expect(crearStt({}, {})).toBeNull();
    expect(crearTts({}, () => {})).toBeNull();
    expect(crearStt({ CF_AI_API_TOKEN: 't' }, {})).toBeNull();
    expect(crearTts({ CF_AI_ACCOUNT_ID: 'a' }, () => {})).toBeNull();
  });

  it('con token y cuenta hay cliente de STT y de TTS', () => {
    const entorno = { CF_AI_API_TOKEN: 'token', CF_AI_ACCOUNT_ID: 'cuenta' };
    expect(crearStt(entorno, {})).not.toBeNull();
    expect(crearTts(entorno, () => {})).not.toBeNull();
  });

  it('la URL de STT va al modelo de Workers AI con el audio en la query', () => {
    const url = urlSttWorkersAi('cuenta', '@cf/deepgram/nova-3', 'es', 16_000);
    expect(url.startsWith('wss://api.cloudflare.com/client/v4/accounts/cuenta/ai/run/')).toBe(true);
    expect(url).toContain('@cf/deepgram/nova-3');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=16000');
    expect(url).toContain('language=es');
    expect(url).toContain('interim_results=true');
  });

  it('la URL de TTS pide el hablante y el audio crudo', () => {
    const url = urlTtsWorkersAi('cuenta', '@cf/deepgram/aura-2-es', 'estrella');
    expect(url.startsWith('wss://api.cloudflare.com/client/v4/accounts/cuenta/ai/run/')).toBe(true);
    expect(url).toContain('@cf/deepgram/aura-2-es');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('speaker=estrella');
  });
});

describe('reunion de Realtime', () => {
  const admin = platformPrincipal('admin-token');
  const deTenant = tenantPrincipal('apikey', 'intake-token', 't_alfa', 'service_ingest');

  it('solo un principal de plataforma puede pedir la llamada sin reunion', () => {
    expect(puedeOmitirRealtime(admin, false)).toBe(true);
    expect(puedeOmitirRealtime(deTenant, false)).toBe(false);
    expect(puedeOmitirRealtime(null, false)).toBe(false);
  });

  it('sin pedirlo explicitamente siempre hay reunion', () => {
    expect(puedeOmitirRealtime(admin, undefined)).toBe(false);
    expect(puedeOmitirRealtime(admin, true)).toBe(false);
    expect(puedeOmitirRealtime(admin, 'false')).toBe(false);
  });
});
