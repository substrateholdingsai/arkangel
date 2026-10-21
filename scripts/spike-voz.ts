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

const BASE_URL = process.env.SPIKE_BASE_URL ?? 'http://localhost:8787';
const ADMIN_TOKEN = process.env.SPIKE_ADMIN_TOKEN ?? '';
const AUDIO_PATH = process.env.SPIKE_AUDIO_PATH ?? '';
const TENANT_ID = process.env.SPIKE_TENANT_ID ?? 't_arkangel';
const LLAMADAS = Number(process.env.SPIKE_LLAMADAS ?? '20');
/** Silencio entre turnos (ms): el guion son 3 turnos con pausas. */
const PAUSA_ENTRE_TURNOS_MS = Number(process.env.SPIKE_PAUSA_MS ?? '1200');

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

/** Manda el audio en bloques de 20 ms (640 muestras a 16 kHz). */
function mandaAudio(socket: WebSocket, muestras: Int16Array, enFinal: () => void): void {
  const bloque = 640;
  let i = 0;
  const temporizador = setInterval(() => {
    if (i >= muestras.length || socket.readyState !== WebSocket.OPEN) {
      clearInterval(temporizador);
      enFinal();
      return;
    }
    const trozo = muestras.subarray(i, i + bloque);
    socket.send(trozo.buffer.slice(trozo.byteOffset, tramo.byteOffset + tramo.byteLength));
    i += bloque;
  }, 20);
}

/** Corre una llamada completa y devuelve sus métricas. */
async function correLlamada(indice: number): Promise<Record<string, number[]>> {
  const respuesta = await fetch(`${BASE_URL}/spike/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({ tenantId: TENANT_ID, clientName: `Cliente ${indice}` }),
  });
  if (!respuesta.ok) {
    throw new Error(`POST /spike/call → ${respuesta.status} ${await respuesta.text()}`);
  }
  const llamada = (await respuesta.json()) as {
    callId: string;
    audioUrl: string;
    traceId: string;
  };

  const url = `${BASE_URL.replace(/^http/, 'ws')}${llamada.audioUrl}`;
  const socket = new WebSocket(url);
  const muestras = await leeWav(AUDIO_PATH);

  await new Promise<void>((resolver, rechazar) => {
    socket.addEventListener('open', () => {
      // El guion son 3 turnos: se manda el audio y se espera la pausa entre
      // turnos (el STT cierra cada turno con su final).
      mandaAudio(socket, muestras, () => {
        setTimeout(() => {
          socket.close();
          resolver();
        }, PAUSA_ENTRE_TURNOS_MS * 3);
      });
    });
    socket.addEventListener('error', () => rechazar(new Error('error del socket de audio')));
  });

  const estado = await fetch(`${BASE_URL}/spike/call/${llamada.callId}/estado`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  const datos = (await estado.json()) as { metricas: Record<string, number[]> };
  console.error(`llamada ${indice + 1}/${LLAMADAS} · ${llamada.callId} · ${llamada.traceId}`);
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
  if (!ADMIN_TOKEN) {
    console.error('Falta SPIKE_ADMIN_TOKEN.');
    process.exit(1);
  }
  if (!AUDIO_PATH) {
    console.error('Falta SPIKE_AUDIO_PATH (WAV mono 16 kHz con el guion de 3 turnos).');
    process.exit(1);
  }

  const todas: Record<string, number[]> = {};
  for (const nombre of METRICAS) todas[nombre] = [];

  for (let i = 0; i < LLAMADAS; i++) {
    const metricas = await correLlamada(i);
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
  console.log(`guion: ${basename(AUDIO_PATH)} · ${LLAMADAS} llamadas`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
