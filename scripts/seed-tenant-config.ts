/**
 * Carga la configuración operativa y legal del tenant por defecto (t_arkangel).
 *
 * Por qué existe: el tenant t_arkangel nace en la migración 0004 con
 * `config_mode='platform_env'` y campos de identidad vacíos. Este script
 * rellena la fila con los datos reales (razón social, CONDUSEF, ventana,
 * allowlist, zona horaria) y deja el tenant listo para pasar a `config_mode='db'`.
 *
 * Idempotente: se puede ejecutar varias veces; actualiza la fila existente.
 *
 * Uso:
 *   npm run seed:tenant-config            # contra D1 local
 *   npm run seed:tenant-config:remote     # contra D1 remota
 *   npm run seed:tenant-config -- --tenant t_arkangel --razon-social "Mi Empresa, S.A. de C.V." --condusef "12345"
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const BASE_DE_DATOS = 'arkangel-cobranza-db';
const TENANT_POR_DEFECTO_ID = 't_arkangel';

/* ── Utilidades ────────────────────────────────────────────────────────────── */

function literal(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

interface Argumentos {
  tenant: string;
  razonSocial?: string;
  condusef?: string;
  allowedPaymentDomains?: string;
  tz?: string;
  sendWindowStart?: string;
  sendWindowEnd?: string;
  maxContactsPerDay?: string;
  legalMontoToleranciaCents?: string;
  legalHorarioEnRespuestas?: string;
  remoto: boolean;
}

function leerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = {
    tenant: TENANT_POR_DEFECTO_ID,
    remoto: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const actual = argv[i];
    const siguiente = argv[i + 1];
    if (actual === '--remote' || actual === '--remoto') {
      args.remoto = true;
    } else if (actual === '--tenant' && siguiente) {
      args.tenant = siguiente;
      i += 1;
    } else if (actual === '--razon-social' && siguiente) {
      args.razonSocial = siguiente;
      i += 1;
    } else if (actual === '--condusef' && siguiente) {
      args.condusef = siguiente;
      i += 1;
    } else if (actual === '--allowed-payment-domains' && siguiente) {
      args.allowedPaymentDomains = siguiente;
      i += 1;
    } else if (actual === '--tz' && siguiente) {
      args.tz = siguiente;
      i += 1;
    } else if (actual === '--send-window-start' && siguiente) {
      args.sendWindowStart = siguiente;
      i += 1;
    } else if (actual === '--send-window-end' && siguiente) {
      args.sendWindowEnd = siguiente;
      i += 1;
    } else if (actual === '--max-contacts-per-day' && siguiente) {
      args.maxContactsPerDay = siguiente;
      i += 1;
    } else if (actual === '--legal-monto-tolerancia-cents' && siguiente) {
      args.legalMontoToleranciaCents = siguiente;
      i += 1;
    } else if (actual === '--legal-horario-en-respuestas' && siguiente) {
      args.legalHorarioEnRespuestas = siguiente;
      i += 1;
    } else if (actual === '--help' || actual === '-h') {
      console.log(AYUDA);
      process.exit(0);
    }
  }
  return args;
}

const AYUDA = `
Carga la configuración del tenant por defecto (t_arkangel).

  --tenant <id>                      Tenant a actualizar (por defecto: t_arkangel)
  --razon-social <texto>             Razón social (ej. "Mi Empresa, S.A. de C.V.")
  --condusef <registro>              Registro CONDUSEF (ej. "12345")
  --allowed-payment-domains <csv>    Dominios de pago permitidos (ej. "paga.miempresa.mx,otro.com")
  --tz <zona>                        Zona horaria IANA (ej. "America/Mexico_City")
  --send-window-start <hora>         Hora inicio ventana (0-23, ej. "8")
  --send-window-end <hora>           Hora fin ventana (0-23, ej. "22")
  --max-contacts-per-day <n>         Máx. contactos/24h (ej. "3")
  --legal-monto-tolerancia-cents <c> Tolerancia de monto en centavos (ej. "0")
  --legal-horario-en-respuestas <0|1> Aplicar ventana a respuestas (ej. "0")
  --remote                           Aplicar contra D1 remota (por defecto: local)
`.trim();

/* ── D1 ────────────────────────────────────────────────────────────────────── */

const WRANGLER_JS = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

async function ejecutarSql(sql: string, remoto: boolean): Promise<string> {
  const archivo = path.join(
    tmpdir(),
    `arkangel-seed-tenant-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`
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
    const tenantId = args.tenant;
    const razonSocial = args.razonSocial ?? (await preguntar(rl, 'Razón social: '));
    const condusef = args.condusef ?? (await preguntar(rl, 'Registro CONDUSEF: '));
    const allowedPaymentDomains =
      args.allowedPaymentDomains ?? (await preguntar(rl, 'Dominios de pago permitidos (CSV): '));
    const tz = args.tz ?? (await preguntar(rl, 'Zona horaria (IANA): '));
    const sendWindowStart = args.sendWindowStart ?? (await preguntar(rl, 'Hora inicio ventana (0-23): '));
    const sendWindowEnd = args.sendWindowEnd ?? (await preguntar(rl, 'Hora fin ventana (0-23): '));
    const maxContactsPerDay = args.maxContactsPerDay ?? (await preguntar(rl, 'Máx. contactos/24h: '));
    const legalMontoToleranciaCents =
      args.legalMontoToleranciaCents ?? (await preguntar(rl, 'Tolerancia monto (centavos): '));
    const legalHorarioEnRespuestas =
      args.legalHorarioEnRespuestas ?? (await preguntar(rl, 'Aplicar ventana a respuestas (0/1): '));

    if (!/^\d+$/.test(sendWindowStart) || Number(sendWindowStart) < 0 || Number(sendWindowStart) > 23) {
      throw new Error('Hora inicio debe ser 0-23');
    }
    if (!/^\d+$/.test(sendWindowEnd) || Number(sendWindowEnd) < 0 || Number(sendWindowEnd) > 23) {
      throw new Error('Hora fin debe ser 0-23');
    }
    if (!/^\d+$/.test(maxContactsPerDay) || Number(maxContactsPerDay) < 0) {
      throw new Error('Máx. contactos debe ser entero >= 0');
    }
    if (!/^\d+$/.test(legalMontoToleranciaCents) || Number(legalMontoToleranciaCents) < 0) {
      throw new Error('Tolerancia debe ser entero >= 0');
    }
    if (!['0', '1'].includes(legalHorarioEnRespuestas)) {
      throw new Error('Horario en respuestas debe ser 0 o 1');
    }

    const ahora = Math.floor(Date.now() / 1000);

    const sql = `
UPDATE tenants SET
  razon_social = ${literal(razonSocial)},
  condusef_registro = ${literal(condusef)},
  allowed_payment_domains = ${literal(allowedPaymentDomains)},
  tz = ${literal(tz)},
  send_window_start = ${sendWindowStart},
  send_window_end = ${sendWindowEnd},
  max_contacts_per_day = ${maxContactsPerDay},
  legal_monto_tolerancia_cents = ${legalMontoToleranciaCents},
  legal_horario_en_respuestas = ${legalHorarioEnRespuestas},
  updated_at = datetime('now')
WHERE id = ${literal(tenantId)};
`;

    await ejecutarSql(sql, args.remoto);

    const tenant = await consultarSql(
      `SELECT id, slug, nombre, config_mode, razon_social, condusef_registro, allowed_payment_domains, tz, send_window_start, send_window_end, max_contacts_per_day, legal_monto_tolerancia_cents, legal_horario_en_respuestas FROM tenants WHERE id = ${literal(tenantId)};`,
      args.remoto
    );

    console.log('');
    console.log(`Tenant actualizado: ${tenant[0]?.id}`);
    console.log(`  slug                    ${tenant[0]?.slug}`);
    console.log(`  nombre                  ${tenant[0]?.nombre}`);
    console.log(`  config_mode             ${tenant[0]?.config_mode}`);
    console.log(`  razon_social            ${tenant[0]?.razon_social}`);
    console.log(`  condusef_registro       ${tenant[0]?.condusef_registro}`);
    console.log(`  allowed_payment_domains ${tenant[0]?.allowed_payment_domains}`);
    console.log(`  tz                      ${tenant[0]?.tz}`);
    console.log(`  send_window_start       ${tenant[0]?.send_window_start}`);
    console.log(`  send_window_end         ${tenant[0]?.send_window_end}`);
    console.log(`  max_contacts_per_day    ${tenant[0]?.max_contacts_per_day}`);
    console.log(`  legal_monto_tolerancia_cents ${tenant[0]?.legal_monto_tolerancia_cents}`);
    console.log(`  legal_horario_en_respuestas  ${tenant[0]?.legal_horario_en_respuestas}`);
    console.log(`  destino                 ${args.remoto ? 'D1 remota' : 'D1 local'}`);
    console.log('');
    console.log('Ahora ejecuta:');
    console.log(`  npm run db:migrate:local`);
    console.log(`  # y luego, para pasar a modo db:`);
    console.log(`  # wrangler d1 execute arkangel-cobranza-db --local --command="UPDATE tenants SET config_mode='db' WHERE id='t_arkangel';"`);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});