import { describe, expect, it } from 'vitest';
import {
  hashTelefonoSha256,
  iniciarVersionRepep,
  insertarLoteRepep,
  activarVersionRepep,
  consultarVigenciaRepep,
  estaEnRepep,
  DIAS_MAXIMOS_VIGENCIA_REPEP,
} from '../src/services/repep';
import { evaluarEnvio } from '../src/comunicacion/motorMarketing';
import type { Env } from '../src/types/env';
import type { ContextoEnvio } from '../src/comunicacion/tipos';

interface MockRepepStore {
  versions: Array<{ id: string; list_date: string; total: number; source: string; status: string }>;
  numbers: Array<{ phone_hash: string; version_id: string }>;
}

function createMockRepepEnv(): { env: Env; store: MockRepepStore } {
  const store: MockRepepStore = {
    versions: [],
    numbers: [],
  };

  const env = {
    DB: {
      prepare: (sql: string) => {
        let boundArgs: any[] = [];
        const stmt = {
          bind: (...args: any[]) => {
            boundArgs = args;
            return stmt;
          },
          first: async <T>() => {
            if (sql.includes('comm_repep_versions') && sql.includes("status = 'active'")) {
              const active = store.versions
                .slice()
                .reverse()
                .find((v) => v.status === 'active');
              return (active ?? null) as T;
            }
            if (sql.includes('comm_repep_numbers')) {
              const [hash, vid] = boundArgs;
              const found = store.numbers.find(
                (n) => n.phone_hash === hash && n.version_id === vid
              );
              return (found ? { 1: 1 } : null) as T;
            }
            return null as T;
          },
          run: async () => {
            if (sql.includes('INSERT INTO comm_repep_versions')) {
              const [id, listDate, source] = boundArgs;
              store.versions.push({
                id,
                list_date: listDate,
                total: 0,
                source,
                status: 'loading',
              });
            }
            if (sql.includes('INSERT OR IGNORE INTO comm_repep_numbers')) {
              const [hash, vid] = boundArgs;
              const exists = store.numbers.some(
                (n) => n.phone_hash === hash && n.version_id === vid
              );
              if (!exists) store.numbers.push({ phone_hash: hash, version_id: vid });
            }
            return { success: true };
          },
        };
        return stmt;
      },
      batch: async (statements: any[]) => {
        for (const s of statements) {
          if (s.sql?.includes("status = 'superseded'")) {
            for (const v of store.versions) {
              if (v.status === 'active') v.status = 'superseded';
            }
          } else if (s.sql?.includes("status = 'active', total = ?")) {
            const [total, vid] = s.boundArgs;
            const target = store.versions.find((v) => v.id === vid);
            if (target) {
              target.status = 'active';
              target.total = total;
            }
          } else if (s.sql?.includes('INSERT OR IGNORE INTO comm_repep_numbers')) {
            const [hash, vid] = s.boundArgs;
            const exists = store.numbers.some((n) => n.phone_hash === hash && n.version_id === vid);
            if (!exists) store.numbers.push({ phone_hash: hash, version_id: vid });
          }
        }
        return [];
      },
    } as any,
  } as Env;

  // Interceptar bind de stmt para batch
  const origPrepare = env.DB.prepare;
  env.DB.prepare = (sql: string) => {
    const s = origPrepare(sql);
    (s as any).sql = sql;
    const origBind = s.bind;
    s.bind = (...args: any[]) => {
      const res = origBind(...args);
      (res as any).sql = sql;
      (res as any).boundArgs = args;
      return res;
    };
    return s;
  };

  return { env, store };
}

describe('Sprint 4: Ingesta y Verificación REPEP (PROFECO)', () => {
  it('hashTelefonoSha256 normaliza a E.164 y genera un hash determinista de 64 caracteres', async () => {
    const hash1 = await hashTelefonoSha256('999 123 4567');
    const hash2 = await hashTelefonoSha256('+52 999 123 4567');
    const hash3 = await hashTelefonoSha256('5219991234567');

    expect(hash1).toBeDefined();
    expect(hash1).toHaveLength(64);
    // Deben coincidir porque todos son el mismo número (+529991234567)
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);

    const hashInvalido = await hashTelefonoSha256('123');
    expect(hashInvalido).toBeNull();
  });

  it('ciclo atómico de ingesta: loading -> inserción de lote -> activación y degradación de la previa', async () => {
    const { env, store } = createMockRepepEnv();

    // 1. Iniciar versión 1
    const vid1 = await iniciarVersionRepep(env, {
      listDate: '2026-09-01',
      source: 'profeco_septiembre',
    });
    expect(store.versions[0]?.status).toBe('loading');

    // Cargar números
    await insertarLoteRepep(env, vid1, ['+529991111111', '+529992222222']);
    await activarVersionRepep(env, vid1, 2);

    expect(store.versions[0]?.status).toBe('active');
    expect(store.versions[0]?.total).toBe(2);

    // 2. Iniciar versión 2 (Octubre)
    const vid2 = await iniciarVersionRepep(env, {
      listDate: '2026-10-01',
      source: 'profeco_octubre',
    });
    await insertarLoteRepep(env, vid2, ['+529993333333']);
    await activarVersionRepep(env, vid2, 1);

    // Versión 1 pasó a 'superseded' y Versión 2 quedó 'active'
    expect(store.versions.find((v) => v.id === vid1)?.status).toBe('superseded');
    expect(store.versions.find((v) => v.id === vid2)?.status).toBe('active');
  });

  it('estaEnRepep reconoce números registrados en la versión activa', async () => {
    const { env } = createMockRepepEnv();
    const vid = await iniciarVersionRepep(env, {
      listDate: new Date().toISOString().slice(0, 10),
      source: 'test_activo',
    });
    await insertarLoteRepep(env, vid, ['+529995555555']);
    await activarVersionRepep(env, vid, 1);

    const registrado = await estaEnRepep(env, '+529995555555', vid);
    const noRegistrado = await estaEnRepep(env, '+529996666666', vid);

    expect(registrado).toBe(true);
    expect(noRegistrado).toBe(false);
  });

  it('vigencia fail-closed: lista con más de 35 días se reporta como caducada y bloquea el marketing', async () => {
    const { env } = createMockRepepEnv();

    // Fecha de corte hace 45 días
    const fechaVieja = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const vid = await iniciarVersionRepep(env, {
      listDate: fechaVieja,
      source: 'test_viejo',
    });
    await activarVersionRepep(env, vid, 100);

    const vigencia = await consultarVigenciaRepep(env);
    expect(vigencia.listaVigente).toBe(false);
    expect(vigencia.motivo).toBe('lista_caducada');
    expect(vigencia.diasAntiguedad).toBeGreaterThan(DIAS_MAXIMOS_VIGENCIA_REPEP);

    // Verificar que evaluarEnvio rechaza envíos publicitarios ante lista caducada
    const ctx: ContextoEnvio = {
      motor: 'comunicacion',
      modo: 'campana',
      canal: 'whatsapp',
      proposito: 'promocion',
      marca: 'CANACO Mérida',
      contacto: '+529997777777',
      ahora: new Date('2026-10-29T18:00:00Z'),
      tzContacto: 'America/Merida',
      consentimiento: {
        optInAt: '2026-01-01',
        optInSource: 'web',
        revokedAt: null,
      },
      suprimido: false,
      repep: {
        listaVigente: vigencia.listaVigente,
        registrado: false,
      },
      frecuencia: { enviadosVentana: 0, maximo: 2 },
      plantilla: {
        id: 't1',
        tenantId: 'canaco_merida',
        channel: 'whatsapp',
        nombre: 'Promo',
        metaName: 'promo_meta',
        lang: 'es_MX',
        categoria: 'marketing',
        status: 'APPROVED',
        subject: null,
        bodyPreview: 'Promo {{marca}}',
        variables: [],
        shared: true,
      },
      variables: {},
      cobranzaActiva: false,
    };

    const res = evaluarEnvio(ctx);
    expect(res.decision).toBe('excluir');
    expect(res.motivos).toContain('repep_lista_no_vigente');
  });
});
