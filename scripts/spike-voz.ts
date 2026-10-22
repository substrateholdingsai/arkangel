/**
 * Arnés del spike de voz: 20 llamadas de prueba con un guion fijo de 3 turnos.
 *
 * Qué hace:
 * 1. Crea 20 llamadas contra el Worker (flag `SPIKE_VOZ_ENABLED=true`).
 * 2. Abre el canal de audio de cada llamada y manda el audio del guion
 *    (un WAV de voz real, 16 kHz mono PCM) en bloques de 20 ms.
 * 3. Espera a que termine cada llamada y lee sus métricas.
 * 4. Calcula p50 y p95 de cada métrica y los imprime como tabla.
 *
 * Requisitos (sin esto no hay números, y no se inventan):
 * · El Worker con `SPIKE_VOZ_ENABLED=true` y las credenciales de Deepgram y
 *   Cloudflare Realtime.
 * · `SPIKE_AUDIO_PATH`: un WAV mono 16 kHz con el guion hablado (3 turnos).
 * · `SPIKE_ADMIN_TOKEN`: el token de administración del Worker.
 *
 * Uso:
 *   SPIKE_BASE_URL=http://localhost:8787 \
 *   SPIKE_ADMIN_TOKEN=... \
 *   SPIKE_AUDIO_PATH=./spike/guion.wav \
 *   npx tsx scripts/spike-voz.ts
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { percentil, type ResumenMetricas } from '../src/lib/medidas';

/** Configuración efectiva del arnés. */
interface Config {
  baseUrl: string;
  adminToken: string;
  audioPath: string;
  tenantId: string;
  llamadas: number;
  pausaMs: number;
}

/**
 * Lee `.dev.vars` (no commiteado) y lo usa como respaldo.
 *
 * El entorno manda: `.dev.vars` sólo rellena lo que no esté ya exportado.
 * Así `npm run spike:voz` funciona sin exportar variables a mano, y un
 * `wrangler dev` con otro token se sigue respetando.
 */
async function leeDevVars(ruta = '.dev.vars'): Promise<Record<string, string>> {
  let texto: string;
  try {
    texto = await readFile(ruta, 'utf8');
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const linea of texto.split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte <= 0) continue;
    const nombre = limpia.slice(0, corte).trim();
    let valor = limpia.slice(corte + 1).trim();
    const comilla =
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"));
    if (comilla && valor.length >= 2) valor = valor.slice(1, -1);
    vars[nombre] = valor;
  }
  return vars;
}

/** Primer valor no vacío: entorno primero, luego `.dev.vars`. */
function toma(
  devVars: Record<string, string>,
  nombre: string,
  ...alternativas: string[]
): string {
  for (const clave of [nombre, ...alternativas]) {
    const delEntorno = process.env[clave];
    if (delEntorno) return delEntorno;
    const deVars = devVars[clave];
    if (deVars) return deVars;
  }
  return '';
}

const METRICAS = [
  'stt_partial_ms',
  'stt_final_ms',
  'llm_first_token_ms',
  'llm_total_ms',
  'tts_first_chunk_ms',
  'round_trip_ms',
  'barge_in_latency_ms',
] as const;

/** Lee un WAV PCM 16 bits mono y devuelve las muestras. */
async function leeWav(ruta: string): Promise<Int16Array> {
  const buffer = await readFile(ruta);
  // El WAV tiene 44 bytes de cabecera en el caso más simple (PCM mono 16 bit).
  // Se busca el chunk 'data' para no depender del tamaño exacto.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const datos = buffer.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(datos.buffer, datos.byteOffset, Math.floor(datos.length / 2));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No se encontró el chunk 'data' en ${ruta}`);
}

/**
 * Manda el audio en bloques de 20 ms.
 *
 * A 16 kHz, 20 ms son 320 muestras (640 muestras serían 40 ms: el audio
 * llegaría al doble de velocidad y el STT vería un habla deformada).
 */
function mandaAudio(socket: WebSocket, muestras: Int16Array, enFinal: () => void): void {
  const bloque = 320;
  let i = 0;
  const temporizador = setInterval(() => {
    if (i >= muestras.length || socket.readyState !== WebSocket.OPEN) {
      clearInterval(temporizador);
      enFinal();
      return;
    }
    const trozo = muestras.subarray(i, i + bloque);
    socket.send(trozo.buffer.slice(trozo.byteOffset, trozo.byteOffset + trozo.byteLength));
    i += bloque;
  }, 20);
}

/** Corre una llamada completa y devuelve sus métricas. */
async function correLlamada(indice: number, config: Config): Promise<Record<string, number[]>> {
  const respuesta = await fetch(`${config.baseUrl}/spike/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': config.adminToken,
    },
    body: JSON.stringify({
      tenantId: config.tenantId,
      clientName: `Cliente ${indice}`,
      // El arnés habla por WebSocket: no necesita reunión de Realtime.
      realtime: false,
    }),
  });
  if (!respuesta.ok) {
    throw new Error(`POST /spike/call → ${respuesta.status} ${await respuesta.text()}`);
  }
  const llamada = (await respuesta.json()) as {
    callId: string;
    audioUrl: string;
    traceId: string;
  };

  const url = `${config.baseUrl.replace(/^http/, 'ws')}${llamada.audioUrl}`;
  // El canal de audio es un WebSocket: el token va en la cabecera. (En el
  // navegador el mismo canal lo autentica la cookie de sesión.)
  const socket = new WebSocket(url, {
    headers: { 'x-admin-token': config.adminToken },
  });
  // El DO manda por el mismo socket los eventos del pipeline: se muestran
  // para poder ver en vivo qué pasa (y si algo falla).
  socket.addEventListener('message', (evento) => {
    if (typeof evento.data !== 'string') return;
    try {
      const mensaje = JSON.parse(evento.data) as { tipo?: string; texto?: string; mensaje?: string };
      if (mensaje.tipo === 'error') {
        console.error(`  · error del pipeline: ${mensaje.mensaje ?? ''}`);
        return;
      }
      if (mensaje.tipo === 'final' || mensaje.tipo === 'parcial') {
        console.error(`  · ${mensaje.tipo}: ${mensaje.texto ?? ''}`);
      }
    } catch {
      // Evento ilegible: se ignora.
    }
  });
  const muestras = await leeWav(config.audioPath);

  await new Promise<void>((resolver, rechazar) => {
    // Se espera el cierre real del socket: si se resuelve antes, el proceso
    // se queda vivo con el socket a medio cerrar (y Node aborta al salir).
    // El plazo es holgado: el guion se manda en tiempo real y dura más que
    // el audio; el corte de seguridad es sólo para no colgarse.
    const seguridad = setTimeout(() => resolver(), 120_000);
    socket.addEventListener('open', () => {
      // El guion son 3 turnos: se manda el audio y se espera la pausa entre
      // turnos (el STT cierra cada turno con su final).
      mandaAudio(socket, muestras, () => {
        setTimeout(() => {
          socket.close();
        }, config.pausaMs * 3);
      });
    });
    socket.addEventListener('close', () => {
      clearTimeout(seguridad);
      resolver();
    });
    socket.addEventListener('error', () => {
      clearTimeout(seguridad);
      rechazar(new Error('error del socket de audio'));
    });
  });

  const estado = await fetch(`${config.baseUrl}/spike/call/${llamada.callId}/estado`, {
    headers: { 'x-admin-token': config.adminToken },
  });
  const datos = (await estado.json()) as { metricas: Record<string, number[]> };
  console.error(
    `llamada ${indice + 1}/${config.llamadas} · ${llamada.callId} · ${llamada.traceId}`
  );
  return datos.metricas ?? {};
}

/** Imprime la tabla de p50/p95. */
function imprimeTabla(resumen: ResumenMetricas): void {
  console.log('');
  console.log('| métrica | n | p50 (ms) | p95 (ms) |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const nombre of METRICAS) {
    const r = resumen[nombre];
    if (!r || r.n === 0) {
      console.log(`| ${nombre} | 0 | — | — |`);
      continue;
    }
    console.log(`| ${nombre} | ${r.n} | ${Math.round(r.p50 ?? 0)} | ${Math.round(r.p95 ?? 0)} |`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const devVars = await leeDevVars();

  const config: Config = {
    baseUrl: toma(devVars, 'SPIKE_BASE_URL') || 'http://localhost:8787',
    adminToken: toma(devVars, 'SPIKE_ADMIN_TOKEN', 'ADMIN_TOKEN'),
    audioPath: toma(devVars, 'SPIKE_AUDIO_PATH') || './spike/guion.wav',
    tenantId: toma(devVars, 'SPIKE_TENANT_ID') || 't_arkangel',
    llamadas: Number(toma(devVars, 'SPIKE_LLAMADAS') || '20'),
    /** Silencio entre turnos (ms): el guion son 3 turnos con pausas. */
    pausaMs: Number(toma(devVars, 'SPIKE_PAUSA_MS') || '1200'),
  };

  if (!config.adminToken) {
    console.error('Falta SPIKE_ADMIN_TOKEN (o ADMIN_TOKEN en .dev.vars).');
    process.exit(1);
  }
  if (!config.audioPath) {
    console.error('Falta SPIKE_AUDIO_PATH (WAV mono 16 kHz con el guion de 3 turnos).');
    process.exit(1);
  }

  const todas: Record<string, number[]> = {};
  for (const nombre of METRICAS) todas[nombre] = [];

  for (let i = 0; i < config.llamadas; i++) {
    const metricas = await correLlamada(i, config);
    for (const nombre of METRICAS) {
      todas[nombre].push(...(metricas[nombre] ?? []));
    }
  }

  const resumen: ResumenMetricas = {};
  for (const nombre of METRICAS) {
    const valores = todas[nombre];
    resumen[nombre] = {
      n: valores.length,
      min: valores.length ? Math.min(...valores) : null,
      p50: percentil(valores, 50),
      p95: percentil(valores, 95),
      max: valores.length ? Math.max(...valores) : null,
      media: valores.length
        ? Math.round((valores.reduce((a, b) => a + b, 0) / valores.length) * 100) / 100
        : null,
    };
  }
  imprimeTabla(resumen);
  console.log(`guion: ${basename(config.audioPath)} · ${config.llamadas} llamadas`);
  // Los sockets de Workers AI pueden dejar el bucle de eventos vivo: se sale
  // explícitamente una vez escrito el resultado.
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
