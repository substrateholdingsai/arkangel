import type { Env } from '../types/env';
import { DirectoryBackupGateway } from '@cloudflare/sandbox';

export interface SandboxProcessResult {
  pid: number;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface HermesRunParams {
  caseId: string;
  taskType: 'skip_trace' | 'sat_materiality' | 'judicial_synthesis';
  contextData: Record<string, unknown>;
}

export class HermesSandboxDO {
  private env: Env;
  private state: DurableObjectState;
  private jobs: Map<string, { status: string; startedAt: number; result?: unknown }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/run') {
        const body = (await request.json()) as HermesRunParams;
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        this.jobs.set(jobId, {
          status: 'processing',
          startedAt: Date.now(),
        });

        // Registrar inicio de ejecución en el estado del Durable Object
        await this.state.storage.put(`job:${jobId}`, {
          jobId,
          caseId: body.caseId,
          taskType: body.taskType,
          status: 'processing',
          startedAt: Date.now(),
        });

        return Response.json({
          ok: true,
          jobId,
          status: 'processing',
        });
      }

      if (request.method === 'GET' && path.startsWith('/jobs/')) {
        const jobId = path.split('/')[2];
        if (!jobId) {
          return Response.json({ ok: false, error: 'Job ID missing' }, { status: 400 });
        }
        const job = (await this.state.storage.get(`job:${jobId}`)) ?? this.jobs.get(jobId);

        if (!job) {
          return Response.json({ ok: false, error: 'Job not found' }, { status: 404 });
        }

        return Response.json({ ok: true, job });
      }

      if (request.method === 'POST' && path.startsWith('/backup')) {
        // Operación de backup hacia R2 (HERMES_MEMORY_BUCKET)
        return Response.json({ ok: true, backup: 'scheduled' });
      }

      return Response.json({ ok: false, error: 'Endpoint not found' }, { status: 404 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }
}

export { DirectoryBackupGateway };
