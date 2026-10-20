import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AlegraMcpClient, KV_SESION_MCP, type AlegraApi } from '../src/contabilidad/alegraClient';
import type { AccountingPayload, AsientoContable } from '../src/contabilidad/schemas';

/** KV en memoria para el cache de sesión. */
class FakeKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const ASIENTO: AsientoContable = {
  cuenta_debito: '5101-001',
  cuenta_credito: '1102-003',
  concepto: 'Provisión Art. 284 Bis — ref legal_audit: leg_1',
  monto: 800,
  tipo_asiento: 'provision',
  regla_id: '2.1',
  ley: 'CPF',
  articulo: 'Art. 284 Bis',
  castigo: 'Prisión de 2 a 5 años',
  referencia_ledger: '0x7a1f9c3d4e5f6a7b8c9d',
  cfdi_relacionado: null,
  legal_audit_id: 'leg_1',
};

const PAYLOAD = {
  idempotency_key: 'sha256:test',
  fecha_corte: '2026-10-19',
  periodo: '2026-10',
  ventana: {
    inicio_utc: '2026-10-19T06:00:00.000Z',
    fin_utc: '2026-10-20T06:00:00.000Z',
    inicio_cdmx: '2026-10-19T00:00:00-06:00',
    fin_cdmx: '2026-10-20T00:00:00-06:00',
  },
  resumen: {
    ingresos_reconocidos: 800,
    ingresos_no_reconocidos_por_bloqueo: 0,
    provision_cartera_ilegal: 800,
    iva_trasladado: 128,
    iva_acreditable_estimado: 0,
  },
  desglose_bloqueos: { '2.1': { count: 1, monto: 800 } },
  asientos: [ASIENTO],
  ledger_integrity: {
    hash_primer_registro: '0xabc',
    hash_ultimo_registro: '0xdef',
    total_registros: 1,
    verificado: true,
  },
  metadata: {
    fuente_iva_acreditable: 'estimado_por_gastos_arkangel',
    nota: 'nota',
    regla_ingreso_reconocido: 'delivered, read, promise_made',
    version: '1.0.0',
  },
} as unknown as AccountingPayload;

const servidores: Server[] = [];

afterEach(async () => {
  while (servidores.length > 0) {
    const server = servidores.pop();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

interface Peticion {
  method: string;
  headers: Record<string, unknown>;
  body: unknown;
}

async function levantarServidor(
  responder: (peticion: Peticion) => {
    status?: number;
    headers?: Record<string, string>;
    cuerpo: string;
  }
): Promise<{ url: string; peticiones: Peticion[] }> {
  const peticiones: Peticion[] = [];
  const server = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (trozo) => {
      cuerpo += trozo;
    });
    req.on('end', () => {
      let parseado: unknown = {};
      try {
        parseado = JSON.parse(cuerpo);
      } catch {
        parseado = {};
      }
      const peticion: Peticion = {
        method: (parseado as { method?: string }).method ?? '',
        headers: req.headers as Record<string, unknown>,
        body: parseado,
      };
      peticiones.push(peticion);
      const respuesta = responder(peticion);
      res.writeHead(respuesta.status ?? 200, {
        'content-type': 'application/json',
        ...(respuesta.headers ?? {}),
      });
      res.end(respuesta.cuerpo);
    });
  });
  servidores.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const puerto = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${puerto}`, peticiones };
}

function respuestaJson(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

describe('AlegraMcpClient sobre HTTP real', () => {
  it('hace initialize + tools/call y devuelve el journal id', async () => {
    const { url, peticiones } = await levantarServidor((peticion) => {
      const id = (peticion.body as { id: number }).id;
      if (peticion.method === 'initialize') {
        return {
          headers: { 'mcp-session-id': 'ses_abc' },
          cuerpo: respuestaJson(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'alegra', version: '1.0.0' },
          }),
        };
      }
      return {
        cuerpo: respuestaJson(id, {
          content: [{ type: 'text', text: JSON.stringify({ id: 'jest_42' }) }],
        }),
      };
    });

    const cliente = new AlegraMcpClient({ url });
    const creado = await cliente.createJournalEntry(ASIENTO, PAYLOAD);

    expect(creado.id).toBe('jest_42');
    expect(peticiones.map((peticion) => peticion.method)).toEqual(['initialize', 'tools/call']);

    const toolCall = peticiones[1]?.body as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(toolCall.params.name).toBe('alegra.create_journal_entry');
    expect(toolCall.params.arguments.referencia).toContain('legal_audit:leg_1');
    expect(toolCall.params.arguments.referencia).toContain('ledger:0x7a1f9c3d4e5f6a7b8c9d');
    const partidas = toolCall.params.arguments.partidas as {
      cuenta: string;
      debe: number;
      haber: number;
    }[];
    expect(partidas).toHaveLength(2);
    expect(partidas[0]).toEqual({ cuenta: '5101-001', debe: 800, haber: 0 });
    expect(partidas[1]).toEqual({ cuenta: '1102-003', debe: 0, haber: 800 });
  });

  it('parsea una respuesta text/event-stream real', async () => {
    const { url } = await levantarServidor((peticion) => {
      const id = (peticion.body as { id: number }).id;
      if (peticion.method === 'initialize') {
        return { cuerpo: respuestaJson(id, { capabilities: {} }) };
      }
      return {
        headers: { 'content-type': 'text/event-stream' },
        cuerpo: [
          'event: message',
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify({ id: 'jest_sse' }) }] },
          })}`,
          '',
          '',
        ].join('\n'),
      };
    });

    const cliente = new AlegraMcpClient({ url });
    const creado = await cliente.createJournalEntry(ASIENTO, PAYLOAD);
    expect(creado.id).toBe('jest_sse');
  });

  it('cachea la sesión MCP en KV y la reusa (no re-inicializa)', async () => {
    const { url, peticiones } = await levantarServidor((peticion) => {
      const id = (peticion.body as { id: number }).id;
      if (peticion.method === 'initialize') {
        return {
          headers: { 'mcp-session-id': 'ses_cache' },
          cuerpo: respuestaJson(id, { capabilities: {} }),
        };
      }
      return {
        cuerpo: respuestaJson(id, {
          content: [{ type: 'text', text: JSON.stringify({ id: 'jest_kv' }) }],
        }),
      };
    });

    const kv = new FakeKV();
    const cliente = new AlegraMcpClient({ url, kv: kv as unknown as KVNamespace });

    await cliente.createJournalEntry(ASIENTO, PAYLOAD);
    expect(kv.store.get(KV_SESION_MCP)).toBe('ses_cache');

    await cliente.createJournalEntry(ASIENTO, PAYLOAD);
    // Sólo una llamada a initialize: la segunda usa la sesión cacheada.
    expect(peticiones.filter((peticion) => peticion.method === 'initialize')).toHaveLength(1);
  });

  it('mapea un error JSON-RPC a un error no reintentable', async () => {
    const { url } = await levantarServidor((peticion) => {
      const id = (peticion.body as { id: number }).id;
      if (peticion.method === 'initialize') {
        return { cuerpo: respuestaJson(id, { capabilities: {} }) };
      }
      return {
        cuerpo: JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid Request: cuenta inexistente' },
        }),
      };
    });

    const cliente = new AlegraMcpClient({ url, retries: 0 });
    await expect(cliente.createJournalEntry(ASIENTO, PAYLOAD)).rejects.toThrow(/Invalid Request/);

    try {
      await cliente.createJournalEntry(ASIENTO, PAYLOAD);
    } catch (error) {
      const alegra = error as { codigo?: number; reintentable?: boolean };
      expect(alegra.codigo).toBe(-32600);
      expect(alegra.reintentable).toBe(false);
    }
  });

  it('normaliza el catálogo de cuentas de Alegra', async () => {
    const { url } = await levantarServidor((peticion) => {
      const id = (peticion.body as { id: number }).id;
      if (peticion.method === 'initialize') {
        return { cuerpo: respuestaJson(id, { capabilities: {} }) };
      }
      return {
        cuerpo: respuestaJson(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                accounts: [
                  { codigo: '5101-001', nombre: 'Gastos de cobranza' },
                  { code: '1102-003', name: 'Provisión por cartera ilegal' },
                ],
              }),
            },
          ],
        }),
      };
    });

    const cliente: AlegraApi = new AlegraMcpClient({ url });
    const cuentas = await cliente.listAccounts();
    expect(cuentas).toEqual([
      { codigo: '5101-001', nombre: 'Gastos de cobranza' },
      { codigo: '1102-003', nombre: 'Provisión por cartera ilegal' },
    ]);
  });
});
