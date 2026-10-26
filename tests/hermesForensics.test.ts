import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  dispatchHermesForensicJob,
  getHermesForensicJob,
  listHermesJobsForCase,
  listHermesJobsForClient,
  type SkipTraceResult,
  type SatMaterialityResult,
  type JudicialSynthesisResult,
} from '../src/services/hermesForensics';
import { hermes } from '../src/routes/hermes';
import type { TenantContext } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

class FakeHermesD1 {
  hermesJobs: any[] = [];
  wormAuditLogs: any[] = [];

  clients = [
    {
      id: 'cli_hermes_1',
      tenant_id: 't_hermes',
      name: 'Mauricio Garza Toussaint',
      phone: '+528183445566',
      email: 'm.garza@toussaint.mx',
      curp: 'GATM800101HNL12345',
    },
  ];

  cases = [
    {
      id: 'cas_hermes_1',
      tenant_id: 't_hermes',
      client_id: 'cli_hermes_1',
      amount_cents: 8500000,
      name: 'Mauricio Garza Toussaint',
      phone: '+528183445566',
      email: 'm.garza@toussaint.mx',
      status: 'ready',
      channel_state: '{}',
      case_date: '2026-01-15',
      created_at: '2026-01-15T00:00:00Z',
      updated_at: '2026-01-15T00:00:00Z',
    },
  ];

  tenants = [
    {
      id: 't_hermes',
      slug: 'garza_legal',
      razon_social: 'Garza & Asociados Cobranza Corporativa S.C.',
      condusef_registro: 'CONDUSEF-PSC-7788',
    },
  ];

  prepare = (sql: string) => {
    const s = sql.trim();

    return {
      bind: (...params: any[]) => {
        return {
          first: async <T>(): Promise<T | null> => {
            if (s.includes('FROM worm_audit_log') && s.includes('ORDER BY created_at DESC')) {
              const tenantId = params[0];
              const entries = this.wormAuditLogs.filter((w) => w.tenant_id === tenantId);
              if (!entries.length) return null;
              return { entry_hash: entries[entries.length - 1].entry_hash } as unknown as T;
            }

            if (s.includes('FROM cases WHERE tenant_id = ? AND id = ?')) {
              const [tenantId, id] = params;
              const found = this.cases.find((c) => c.tenant_id === tenantId && c.id === id);
              return (found as unknown as T) || null;
            }

            if (
              s.includes('FROM clients WHERE tenant_id = ? AND id = ?') ||
              s.includes('FROM clients WHERE id = ?')
            ) {
              const id = params[params.length - 1];
              const found = this.clients.find((c) => c.id === id);
              return (found as unknown as T) || null;
            }

            if (s.includes('FROM hermes_forensic_jobs WHERE tenant_id = ? AND id = ?')) {
              const [tenantId, id] = params;
              const found = this.hermesJobs.find((j) => j.tenant_id === tenantId && j.id === id);
              return (found as unknown as T) || null;
            }

            if (s.includes('FROM tenants WHERE id = ?')) {
              const id = params[0];
              const tn = this.tenants.find((t) => t.id === id);
              return (tn as unknown as T) || null;
            }

            return null;
          },

          all: async <T>(): Promise<{ results: T[] }> => {
            if (
              s.includes('FROM hermes_forensic_jobs') &&
              s.includes('WHERE tenant_id = ? AND case_id = ?')
            ) {
              const [tenantId, caseId] = params;
              const list = this.hermesJobs.filter(
                (j) => j.tenant_id === tenantId && j.case_id === caseId
              );
              return { results: list as unknown as T[] };
            }

            if (
              s.includes('FROM hermes_forensic_jobs') &&
              s.includes('WHERE tenant_id = ? AND client_id = ?')
            ) {
              const [tenantId, clientId] = params;
              const list = this.hermesJobs.filter(
                (j) => j.tenant_id === tenantId && j.client_id === clientId
              );
              return { results: list as unknown as T[] };
            }

            if (s.includes('FROM worm_audit_log WHERE tenant_id = ?')) {
              const tenantId = params[0];
              const list = this.wormAuditLogs.filter((w) => w.tenant_id === tenantId);
              return { results: list as unknown as T[] };
            }

            return { results: [] };
          },

          run: async () => {
            if (s.includes('INSERT INTO hermes_forensic_jobs')) {
              const [
                id,
                tenant_id,
                case_id,
                client_id,
                task_type,
                r2_snapshot_path,
                created_at,
                updated_at,
              ] = params;
              this.hermesJobs.push({
                id,
                tenant_id,
                case_id,
                client_id,
                task_type,
                status: 'processing',
                result_summary: null,
                result_payload: null,
                worm_entry_hash: null,
                r2_snapshot_path,
                created_at,
                updated_at,
              });
              return { success: true };
            }

            if (s.includes('UPDATE hermes_forensic_jobs')) {
              const [result_summary, result_payload, worm_entry_hash, updated_at, tenant_id, id] =
                params;
              const job = this.hermesJobs.find((j) => j.tenant_id === tenant_id && j.id === id);
              if (job) {
                job.status = 'completed';
                job.result_summary = result_summary;
                job.result_payload = result_payload;
                job.worm_entry_hash = worm_entry_hash;
                job.updated_at = updated_at;
              }
              return { success: true };
            }

            if (s.includes('INSERT INTO worm_audit_log')) {
              const [
                id,
                tenant_id,
                case_id,
                record_type,
                record_id,
                action,
                actor,
                prev_hash,
                record_hash,
                entry_hash,
                timestamp_utc,
                metadata,
                created_at,
              ] = params;
              this.wormAuditLogs.push({
                id,
                tenant_id,
                case_id,
                record_type,
                record_id,
                action,
                actor,
                prev_hash,
                record_hash,
                entry_hash,
                timestamp_utc,
                metadata,
                created_at,
              });
              return { success: true };
            }

            return { success: true };
          },
        };
      },
    };
  };
}

class FakeHermesR2Bucket {
  storage: Map<string, { body: string; metadata?: any }> = new Map();

  async put(key: string, value: string, options?: any): Promise<void> {
    this.storage.set(key, { body: value, metadata: options?.customMetadata });
  }

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const item = this.storage.get(key);
    if (!item) return null;
    return {
      text: async () => item.body,
    };
  }
}

describe('Agente Autónomo Hermes en Cloudflare Sandboxes (Hermes-flare)', () => {
  it('ejecuta peritaje forense SAT (Art. 69-B CFF y 27-XV LISR) con bitácora WORM y snapshot en R2', async () => {
    const fakeDb = new FakeHermesD1();
    const fakeR2 = new FakeHermesR2Bucket();
    const env = {
      DB: fakeDb as any,
      HERMES_MEMORY_BUCKET: fakeR2 as any,
      APP_URL: 'https://arkangel.arksystems.site',
    } as Env;

    const ctx: TenantContext = {
      tenantId: 't_hermes',
      tenant: fakeDb.tenants[0] as any,
      config: {} as any,
      channels: [],
      principal: {
        tipo: 'usuario',
        id: 'usr_hermes',
        email: 'perito@garza.mx',
        rol: 'admin',
      } as any,
      env,
    };

    const job = await dispatchHermesForensicJob(ctx, {
      caseId: 'cas_hermes_1',
      taskType: 'sat_materiality',
      documentsR2Urls: ['r2://arkangel/sat-docs/factura-101.xml'],
    });

    expect(job.status).toBe('completed');
    expect(job.taskType).toBe('sat_materiality');
    expect(job.resultSummary).toContain('Peritaje SAT: Materialidad 69-B verificada al 100%');
    expect(job.wormEntryHash).toBeTruthy();

    const payload = job.resultPayload as unknown as SatMaterialityResult;
    expect(payload.materialidadArt69BValida).toBe(true);
    expect(payload.cumpleArt27FraccXVLISR).toBe(true);
    expect(payload.efosEncontrados).toHaveLength(0);

    // Verificación de bitácora WORM inmutable
    expect(fakeDb.wormAuditLogs.length).toBeGreaterThanOrEqual(1);
    const wormEntry = fakeDb.wormAuditLogs[0];
    expect(wormEntry.record_type).toBe('hermes_forensic_opinion');
    expect(wormEntry.actor).toBe('hermes_agent');

    // Verificación de snapshot en R2
    expect(fakeR2.storage.size).toBe(1);
    const r2Key = Array.from(fakeR2.storage.keys())[0];
    expect(r2Key).toContain('snapshots/hermes-t_hermes-cas_hermes_1.json');
  });

  it('ejecuta skip-tracing de solvencia patrimonial con clasificación A/B/C', async () => {
    const fakeDb = new FakeHermesD1();
    const env = {
      DB: fakeDb as any,
      APP_URL: 'https://arkangel.arksystems.site',
    } as Env;

    const ctx: TenantContext = {
      tenantId: 't_hermes',
      tenant: fakeDb.tenants[0] as any,
      config: {} as any,
      channels: [],
      principal: {
        tipo: 'usuario',
        id: 'usr_hermes',
        email: 'perito@garza.mx',
        rol: 'admin',
      } as any,
      env,
    };

    const job = await dispatchHermesForensicJob(ctx, {
      clientId: 'cli_hermes_1',
      taskType: 'skip_trace',
    });

    expect(job.status).toBe('completed');
    expect(job.taskType).toBe('skip_trace');
    const payload = job.resultPayload as unknown as SkipTraceResult;
    expect(payload.dictamenSolvencia).toBe('A');
    expect(payload.procedeEjecutivoMercantil).toBe(true);
    expect(payload.bienesInscritos.length).toBeGreaterThanOrEqual(1);
    expect(payload.bienesInscritos[0]!.tipo).toBe('inmueble');
    expect(payload.domiciliosDetectados.length).toBeGreaterThanOrEqual(1);
  });

  it('ejecuta redacción pericial y liquidación de intereses moratorios (Art. 362 y 1298-A CCom)', async () => {
    const fakeDb = new FakeHermesD1();
    const env = {
      DB: fakeDb as any,
      APP_URL: 'https://arkangel.arksystems.site',
    } as Env;

    const ctx: TenantContext = {
      tenantId: 't_hermes',
      tenant: fakeDb.tenants[0] as any,
      config: {} as any,
      channels: [],
      principal: {
        tipo: 'usuario',
        id: 'usr_hermes',
        email: 'perito@garza.mx',
        rol: 'admin',
      } as any,
      env,
    };

    const job = await dispatchHermesForensicJob(ctx, {
      caseId: 'cas_hermes_1',
      taskType: 'judicial_synthesis',
    });

    expect(job.status).toBe('completed');
    expect(job.taskType).toBe('judicial_synthesis');
    const payload = job.resultPayload as unknown as JudicialSynthesisResult;
    expect(payload.capituloHechos.length).toBeGreaterThanOrEqual(3);
    expect(payload.capituloAgravios.length).toBeGreaterThanOrEqual(2);
    expect(payload.liquidacionInteresesMoratorios.tasaAnualPct).toBe(6.0);
    expect(payload.liquidacionInteresesMoratorios.fundamentoLegal).toContain(
      'Artículo 362 del Código de Comercio'
    );
    expect(payload.liquidacionInteresesMoratorios.interesMoratorioCalculadoCents).toBeGreaterThan(
      0
    );
  });

  it('permite consultar trabajos forenses por ID y listar por caso', async () => {
    const fakeDb = new FakeHermesD1();
    const env = {
      DB: fakeDb as any,
      APP_URL: 'https://arkangel.arksystems.site',
    } as Env;

    const ctx: TenantContext = {
      tenantId: 't_hermes',
      tenant: fakeDb.tenants[0] as any,
      config: {} as any,
      channels: [],
      principal: {
        tipo: 'usuario',
        id: 'usr_hermes',
        email: 'perito@garza.mx',
        rol: 'admin',
      } as any,
      env,
    };

    const job = await dispatchHermesForensicJob(ctx, {
      caseId: 'cas_hermes_1',
      taskType: 'sat_materiality',
    });

    const retrieved = await getHermesForensicJob(ctx, job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(job.id);

    const list = await listHermesJobsForCase(ctx, 'cas_hermes_1');
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.id).toBe(job.id);

    // Listar jobs por cliente
    const clientJobs = await listHermesJobsForClient(ctx, 'cli_hermes_1');
    expect(clientJobs).toBeDefined();
  });

  it('expone las rutas HTTP de la API de Hermes', async () => {
    const fakeDb = new FakeHermesD1();
    const env = {
      DB: fakeDb as any,
      ADMIN_TOKEN: 'admin_secret',
      APP_URL: 'https://arkangel.arksystems.site',
    } as Env;

    const app = new Hono<{ Bindings: Env; Variables: any }>();
    app.route('/api/v1/hermes', hermes);

    // 1. Iniciar skip-tracing por cliente
    const skipRes = await app.fetch(
      new Request('http://localhost/api/v1/hermes/skip-trace/cli_hermes_1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 't_hermes',
          'x-admin-token': 'admin_secret',
        },
      }),
      env
    );
    expect(skipRes.status).toBe(200);
    const skipBody = (await skipRes.json()) as any;
    expect(skipBody.ok).toBe(true);
    expect(skipBody.job.taskType).toBe('skip_trace');

    const jobId = skipBody.job.id;

    // 2. Consultar el job por ID
    const getJobRes = await app.fetch(
      new Request(`http://localhost/api/v1/hermes/jobs/${jobId}`, {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 't_hermes',
          'x-admin-token': 'admin_secret',
        },
      }),
      env
    );
    expect(getJobRes.status).toBe(200);
    const getJobBody = (await getJobRes.json()) as any;
    expect(getJobBody.ok).toBe(true);
    expect(getJobBody.job.id).toBe(jobId);

    // 3. Detonar peritaje SAT por caso
    const satRes = await app.fetch(
      new Request('http://localhost/api/v1/hermes/forensics/cas_hermes_1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 't_hermes',
          'x-admin-token': 'admin_secret',
        },
      }),
      env
    );
    expect(satRes.status).toBe(200);
    const satBody = (await satRes.json()) as any;
    expect(satBody.ok).toBe(true);
    expect(satBody.job.taskType).toBe('sat_materiality');

    // 4. Detonar síntesis para Cuaderno Judicial
    const synthesisRes = await app.fetch(
      new Request('http://localhost/api/v1/hermes/docket-synthesis/cas_hermes_1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 't_hermes',
          'x-admin-token': 'admin_secret',
        },
      }),
      env
    );
    expect(synthesisRes.status).toBe(200);
    const synthesisBody = (await synthesisRes.json()) as any;
    expect(synthesisBody.ok).toBe(true);
    expect(synthesisBody.job.taskType).toBe('judicial_synthesis');

    // 5. Listar jobs por caso
    const listRes = await app.fetch(
      new Request('http://localhost/api/v1/hermes/cases/cas_hermes_1/jobs', {
        method: 'GET',
        headers: {
          'X-Tenant-Id': 't_hermes',
          'x-admin-token': 'admin_secret',
        },
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.ok).toBe(true);
    expect(listBody.jobs.length).toBeGreaterThanOrEqual(2);
  });
});
