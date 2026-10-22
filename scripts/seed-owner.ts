/**
 * Alta del primer usuario (el "owner") del sistema de autenticación nativa.
 *
 * Por qué existe: el registro público del panel deja a cualquiera con su
 * propio despacho, pero el alta real de un usuario de producción la hace una
 * persona, con un tenant que ya existe en el catálogo y con un rol concreto.
 * Este script es ese camino:
 *
 *   1. Pide por consola el correo, la contraseña y el `tenant_id`.
 *   2. Calcula el hash PBKDF2 de la contraseña (mismo formato que el Worker:
 *      `pbkdf2_sha256$25000$salt$hash`).
 *   3. Inserta el usuario con el correo ya verificado.
 *   4. Inserta la membresía con el rol indicado (`owner` por defecto).
 *
 * Uso:
 *   npm run seed:owner            # contra la D1 local
 *   npm run seed:owner:remote     # contra la D1 remota
 *   npm run seed:owner -- --email a@b.com --password '...' --tenant t_arkangel --role owner
 *
 * El script habla con D1 a través de `wrangler d1 execute`, así que usa la
 * sesión de wrangler que ya tengas iniciada. No escribe secretos en disco.
 */

import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const BASE_DE_DATOS = 'arkangel-cobranza-db';
const ITERACIONES = 100_000;
const LONGITUD_SAL = 16;
const LONGITUD_HASH = 32;
const ROLES = ['owner', 'admin', 'member'] as const;

type Rol = (typeof ROLES)[number];

/* ── Utilidades ────────────────────────────────────────────────────────────── */

function hex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Hash de la contraseña con PBKDF2 (SHA-256, 25 000 iteraciones, sal de 16
 * bytes). Es el mismo formato que produce `src/auth/native.ts` en el Worker,
 * así que la contraseña que se valida allí es la que se verifica aquí.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(LONGITUD_SAL);
  const hash = pbkdf2Sync(password, salt, ITERACIONES, LONGITUD_HASH, 'sha256');
  return `pbkdf2_sha256$${ITERACIONES}$${hex(salt)}$${hex(hash)}`;
}

/** Escapa una cadena para meterla en una literal de SQL de SQLite. */
function literal(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

interface Argumentos {
  email?: string;
  password?: string;
  tenant?: string;
  role: Rol;
  remoto: boolean;
}

function leerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = { role: 'owner', remoto: false };
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    const siguiente = argv[i + 1];
    if (actual === '--remote' || actual === '--remoto') {
      args.remoto = true;
    } else if (actual === '--email' && siguiente) {
      args.email = siguiente;
      i += 1;
    } else if (actual === '--password' && siguiente) {
      args.password = siguiente;
      i += 1;
    } else if (actual === '--tenant' && siguiente) {
      args.tenant = siguiente;
      i += 1;
    } else if (actual === '--role' && siguiente) {
      if (!ROLES.includes(siguiente as Rol)) {
        throw new Error(`Rol inválido: "${siguiente}". Usa uno de: ${ROLES.join(', ')}`);
      }
      args.role = siguiente as Rol;
      i += 1;
    } else if (actual === '--help' || actual === '-h') {
      console.log(AYUDA);
      process.exit(0);
    }
  }
  return args;
}

const AYUDA = `
Alta del primer usuario de Arkangel (autenticación nativa en D1).

  --email <correo>        Correo del usuario
  --password <clave>      Contraseña (mínimo 12 caracteres)
  --tenant <tenant_id>    Despacho al que se da de alta (ej. t_arkangel)
  --role <rol>            ${ROLES.join(' | ')} (por defecto: owner)
  --remote                Aplicar contra la D1 remota (por defecto: local)
`.trim();

/* ── D1 ────────────────────────────────────────────────────────────────────── */

/** Ruta al binario de wrangler dentro de `node_modules` (sin `npx`). */
const WRANGLER_JS = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

/**
 * Ejecuta SQL de escritura (varias sentencias) contra D1.
 *
 * Va por `--file` porque `wrangler d1 execute --command` es de una sola
 * sentencia. En modo `--file` la salida JSON es un **resumen** de la
 * ejecución, no las filas: por eso las lecturas usan `consultarSql`.
 */
async function ejecutarSql(sql: string, remoto: boolean): Promise<string> {
  const archivo = path.join(
    tmpdir(),
    `arkangel-seed-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`
  );
  await writeFile(archivo, sql, 'utf8');

  const argumentos = [
    WRANGLER_JS,
    'd1',
    'execute',
    BASE_DE_DATOS,
    `--file=${archivo}`,
    remoto ? '--remote' : '--local',
  ];

  try {
    return await new Promise<string>((resolve, reject) => {
      // Se invoca el binario de wrangler con el mismo node del script: sin
      // `npx` (que tarda) y sin `shell` (que en Windows concatenaría los
      // argumentos sin escapar).
      const proceso = spawn(process.execPath, argumentos, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let salida = '';
      let error = '';
      proceso.stdout.on('data', (trozo) => {
        salida += String(trozo);
      });
      proceso.stderr.on('data', (trozo) => {
        error += String(trozo);
      });
      proceso.on('error', reject);
      proceso.on('close', (codigo) => {
        if (codigo === 0) resolve(salida);
        else reject(new Error(error.trim() || `wrangler salió con código ${codigo}`));
      });
    });
  } finally {
    await unlink(archivo).catch(() => undefined);
  }
}

/**
 * Consulta y devuelve las filas del resultado (o `[]` si no hay ninguna).
 *
 * Va por `--command` (una sentencia) porque en modo `--file` wrangler no
 * devuelve las filas sino un resumen de la ejecución.
 */
async function consultarSql(sql: string, remoto: boolean): Promise<Array<Record<string, unknown>>> {
  const salida = await new Promise<string>((resolve, reject) => {
    const proceso = spawn(
      process.execPath,
      [
        WRANGLER_JS,
        'd1',
        'execute',
        BASE_DE_DATOS,
        `--command=${sql}`,
        remoto ? '--remote' : '--local',
        '--json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let texto = '';
    let error = '';
    proceso.stdout.on('data', (trozo) => {
      texto += String(trozo);
    });
    proceso.stderr.on('data', (trozo) => {
      error += String(trozo);
    });
    proceso.on('error', reject);
    proceso.on('close', (codigo) => {
      if (codigo === 0) resolve(texto);
      else reject(new Error(error.trim() || `wrangler salió con código ${codigo}`));
    });
  });
  // wrangler escribe un prefijo con el estado de la ejecución y luego el JSON.
  const inicio = salida.search(/[[{]/);
  if (inicio === -1) return [];
  try {
    const parseado = JSON.parse(salida.slice(inicio)) as unknown;
    const objetos = Array.isArray(parseado) ? parseado : [parseado];
    for (const objeto of objetos) {
      if (
        objeto &&
        typeof objeto === 'object' &&
        Array.isArray((objeto as { results?: unknown }).results)
      ) {
        return (objeto as { results: Array<Record<string, unknown>> }).results;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/* ── Flujo ─────────────────────────────────────────────────────────────────── */

async function preguntar(
  rl: ReturnType<typeof createInterface>,
  etiqueta: string
): Promise<string> {
  const respuesta = (await rl.question(etiqueta)).trim();
  if (!respuesta) throw new Error(`Falta ${etiqueta.replace(':', '').trim()}`);
  return respuesta;
}

async function main(): Promise<void> {
  const args = leerArgumentos(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = (args.email ?? (await preguntar(rl, 'Correo electrónico: '))).toLowerCase();
    const password = args.password ?? (await preguntar(rl, 'Contraseña (mínimo 12 caracteres): '));
    const tenantId = args.tenant ?? (await preguntar(rl, 'tenant_id del despacho: '));
    const role = args.role;

    if (password.length < 12) {
      throw new Error('La contraseña debe tener al menos 12 caracteres.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('El correo no tiene un formato válido.');
    }

    // El tenant tiene que existir: la membresía lo declara como clave foránea.
    const tenants = await consultarSql(
      `SELECT id FROM tenants WHERE id = ${literal(tenantId)};`,
      args.remoto
    );
    if (tenants.length === 0) {
      throw new Error(
        `El despacho "${tenantId}" no existe en el catálogo de tenants. ` +
          'Crea el tenant primero (migración 0004) o usa uno existente.'
      );
    }

    const hash = hashPassword(password);
    const ahora = Math.floor(Date.now() / 1000);

    // Idempotente: si el correo ya existe se le cambia la contraseña y se
    // actualiza su membresía, en vez de crear un usuario duplicado.
    const sql = [
      `INSERT INTO users (id, email, full_name, password_hash, email_verified_at, platform_role, created_at)`,
      `  VALUES (${literal(`usr_${randomUUID().replace(/-/g, '').slice(0, 24)}`)}, ${literal(email)}, ${literal(email.split('@')[0])}, ${literal(hash)}, ${ahora}, 'user', ${ahora})`,
      `  ON CONFLICT(email) DO UPDATE SET`,
      `    password_hash = excluded.password_hash,`,
      `    email_verified_at = excluded.email_verified_at,`,
      `    full_name = excluded.full_name;`,
      `INSERT INTO tenant_memberships (user_id, tenant_id, role, created_at)`,
      `  SELECT id, ${literal(tenantId)}, ${literal(role)}, ${ahora} FROM users WHERE email = ${literal(email)}`,
      `  ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role;`,
    ].join('\n');

    await ejecutarSql(sql, args.remoto);

    const usuario = await consultarSql(
      `SELECT id, email FROM users WHERE email = ${literal(email)};`,
      args.remoto
    );

    console.log('');
    console.log(`Usuario listo: ${email}`);
    console.log(`  id       ${String(usuario[0]?.id ?? 'desconocido')}`);
    console.log(`  despacho ${tenantId} (rol ${role})`);
    console.log(`  destino  ${args.remoto ? 'D1 remota' : 'D1 local'}`);
    console.log('');
    console.log('Entra en el panel con ese correo y esa contraseña.');
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
