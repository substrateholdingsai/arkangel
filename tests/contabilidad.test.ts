import { describe, expect, it } from 'vitest';
import {
  SQL_AUDITORIA_DIA,
  SQL_CHECKPOINT_FECHA,
  SQL_LEDGER_HISTORIA,
  buildAccountingPayload,
  construirPayload,
  diaPrevioIso,
  ventanaUtcDeDia,
} from '../src/contabilidad/buildPayload';
import {
  claveR2,
  guardarPayloadEnR2,
  leerUltimoPayload,
  sendToAlegra,
} from '../src/contabilidad/sendToAlegra';
import { handleContabilidadDaily } from '../src/cron/contabilidadDaily';
import { reconciliarCortesPendientes } from '../src/cron/reconciliacion';
import { validarPayload } from '../src/contabilidad/schemas';
import {
  MCP_ERROR_MAP,
  leerRespuestaMcp,
  type AlegraApi,
  type AlegraCuenta,
} from '../src/contabilidad/alegraClient';
import type { Env } from '../src/types/env';
import type { AccountingPayload } from '../src/contabilidad/schemas';
import { platformPrincipal } from '../src/auth/principal';
import { contabilidad } from '../src/routes/contabilidad';
import type { Tenant, TenantContext } from '../src/tenancy/types';

const TZ = 'America/Mexico_City';
const FECHA = '2026-10-19';
const TENANT_ID = 't_arkangel';

/** Normaliza el SQL para comparar sin depender de saltos de línea. */
function normalizar(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface FakeRow {
  [key: string]: unknown;
}

class FakeD1 {
  tenants: FakeRow[] = [];
  auditoria: FakeRow[] = [];
  mapa: FakeRow[] = [];
  ingresos: FakeRow[] = [];
  historia: FakeRow[] = [];
  casos: FakeRow[] = [];
  contratos: FakeRow[] = [];
  cfdis: FakeRow[] = [];
  checkpoints: FakeRow[] = [];
  sync: FakeRow[] = [];
  lineas: FakeRow[] = [];
  eventos: FakeRow[] = [];
  /** Simula que el UPDATE a alegra_sync falla (caída de D1 a media sesión). */
  fallarUpdateSync = false;

  prepare = (sql: string) => {
    const limpio = normalizar(sql);
    const todas = async <T>(args: unknown[]): Promise<{ results: T[] }> => ({
      results: this.consulta<T>(limpio, args),
    });
    const primera = async <T>(args: unknown[]): Promise<T | null> => {
      const filas = this.consulta<T>(limpio, args);
      return filas[0] ?? null;
    };
    const correr = async (args: unknown[]): Promise<{ success: boolean }> => {
      this.ejecuta(limpio, args);
      return { success: true };
    };

    return {
      all: () => todas([]),
      first: () => primera([]),
      run: () => correr([]),
      bind(...args: unknown[]) {
        return {
          all: () => todas(args),
          first: () => primera(args),
          run: () => correr(args),
        };
      },
    };
  };

  /**
   * Filtra por tenant.
   *
   * En el esquema multi-tenant la primera columna de estos SQL es siempre el
   * tenant: es lo que impide que el corte de una empresa se mezcle con el de
   * otra. Las filas sin `tenant_id` se consideran del tenant de la prueba.
   */
  deTenant(filas: FakeRow[], args: unknown[]): FakeRow[] {
    const tenantId = args[0] === undefined ? null : String(args[0]);
    if (tenantId === null) return filas;
    return filas.filter((fila) => String(fila.tenant_id ?? TENANT_ID) === tenantId);
  }

  consulta<T>(sql: string, args: unknown[]): T[] {
    if (sql.includes('FROM tenants')) {
      if (sql.includes('WHERE id = ?') || sql.includes('WHERE slug = ?')) {
        const ref = String(args[0]);
        return this.tenants.filter((fila) => fila.id === ref || fila.slug === ref) as T[];
      }
      if (sql.includes('is_default = 1')) {
        return this.tenants.filter((fila) => Number(fila.is_default ?? 1) === 1) as T[];
      }
      const status = String(args[0] ?? 'active');
      return this.tenants.filter((fila) => String(fila.status) === status) as T[];
    }
    if (sql.includes('FROM legal_audit')) {
      if (sql.includes("replace(created_at, ' ', 'T') >= ?")) {
        const desde = String(args[1]);
        const hasta = String(args[2]);
        return this.deTenant(this.auditoria, args).filter(
          (fila) => String(fila.created_at) >= desde && String(fila.created_at) < hasta
        ) as T[];
      }
      return this.deTenant(this.historia, args) as T[];
    }
    if (sql.includes('FROM tenant_accounting_map')) return this.deTenant(this.mapa, args) as T[];
    if (sql.includes('FROM messages')) {
      const estados = args.slice(1, 4).map((valor) => String(valor));
      const [desde, hasta] = args.slice(4) as [string, string];
      return this.deTenant(this.ingresos, args).filter(
        (fila) =>
          estados.includes(String(fila.status)) &&
          String(fila.created_at) >= desde &&
          String(fila.created_at) < hasta
      ) as T[];
    }
    if (sql.includes('FROM cases')) return this.deTenant(this.casos, args) as T[];
    if (sql.includes('FROM contracts')) return this.deTenant(this.contratos, args) as T[];
    if (sql.includes('FROM contract_cfdi')) return this.deTenant(this.cfdis, args) as T[];
    if (sql.includes('FROM ledger_checkpoint')) {
      const fecha = String(args[1]);
      if (sql.includes('WHERE tenant_id = ? AND fecha_corte = ?')) {
        return this.deTenant(this.checkpoints, args).filter(
          (fila) => fila.fecha_corte === fecha
        ) as T[];
      }
      const filtrados = this.deTenant(this.checkpoints, args)
        .filter((fila) => String(fila.fecha_corte) <= fecha)
        .sort((a, b) => String(b.fecha_corte).localeCompare(String(a.fecha_corte)));
      return (filtrados[0] ? [filtrados[0]] : []) as T[];
    }
    if (sql.includes('FROM alegra_sync')) {
      if (sql.includes("status IN ('pending', 'failed')")) {
        return this.deTenant(this.sync, args).filter(
          (fila) => fila.status === 'pending' || fila.status === 'failed'
        ) as T[];
      }
      const clave = String(args[1]);
      return this.deTenant(this.sync, args).filter((fila) => fila.idempotency_key === clave) as T[];
    }
    if (sql.includes('FROM alegra_journal_lines')) {
      const clave = String(args[1]);
      const lineas = this.deTenant(this.lineas, args).filter(
        (fila) => fila.idempotency_key === clave
      );
      // La lectura de una línea concreta filtra por `legal_audit_id`; el
      // listado del corte devuelve todas las del corte.
      if (args.length > 2) {
        const legalAuditId = String(args[2]);
        return lineas.filter((fila) => fila.legal_audit_id === legalAuditId) as T[];
      }
      return lineas as T[];
    }
    return [];
  }

  ejecuta(sql: string, args: unknown[]): void {
    if (sql.includes('INSERT INTO events')) {
      this.eventos.push({ tenant_id: args[1], type: args[2], payload: args[5] });
      return;
    }
    if (sql.includes('INSERT OR IGNORE INTO tenant_accounting_map')) {
      const exists = this.mapa.some(
        (m) => String(m.tenant_id ?? TENANT_ID) === String(args[0]) && m.regla_id === args[1]
      );
      if (!exists) {
        this.mapa.push({
          tenant_id: args[0],
          regla_id: args[1],
          cuenta_debito: args[2],
          cuenta_credito: args[3],
          tipo_asiento: args[4],
          descripcion: args[5],
        });
      }
      return;
    }
    if (sql.includes('INSERT INTO tenant_accounting_map')) {
      const existing = this.mapa.find(
        (m) => String(m.tenant_id ?? TENANT_ID) === String(args[0]) && m.regla_id === args[1]
      );
      if (existing) {
        existing.cuenta_debito = args[2];
        existing.cuenta_credito = args[3];
        existing.tipo_asiento = args[4];
        if (args[5]) existing.descripcion = args[5];
      } else {
        this.mapa.push({
          tenant_id: args[0],
          regla_id: args[1],
          cuenta_debito: args[2],
          cuenta_credito: args[3],
          tipo_asiento: args[4],
          descripcion: args[5],
        });
      }
      return;
    }
    if (sql.includes('INSERT INTO alegra_sync')) {
      const id = args[0];
      const fechaCorte = args[2];
      const idempotencyKey = args[3];
      const payloadR2Key = args[4];
      const existente = this.sync.find((fila) => fila.idempotency_key === idempotencyKey);
      if (existente) {
        existente.status = 'pending';
        existente.payload_r2_key = payloadR2Key;
        existente.error_message = null;
        return;
      }
      this.sync.push({
        id,
        tenant_id: args[1],
        fecha_corte: fechaCorte,
        idempotency_key: idempotencyKey,
        status: 'pending',
        payload_r2_key: payloadR2Key,
        alegra_journal_id: null,
        error_message: null,
      });
      return;
    }
    if (sql.startsWith('UPDATE alegra_sync')) {
      if (this.fallarUpdateSync) {
        // Caída puntual de D1: sólo falla el primer UPDATE.
        this.fallarUpdateSync = false;
        throw new Error('D1 no disponible (simulado)');
      }
      const status = args[0];
      const journalId = args[1];
      const errorMessage = args[2];
      const idempotencyKey = args[4];
      const fila = this.sync.find((item) => item.idempotency_key === idempotencyKey);
      if (!fila) return;
      fila.status = status;
      if (journalId) fila.alegra_journal_id = journalId;
      fila.error_message = errorMessage;
      return;
    }
    if (sql.includes('alegra_journal_lines')) {
      if (sql.startsWith('UPDATE')) {
        const journalId = args[0];
        const idempotencyKey = args[2];
        const legalAuditId = args[3];
        const fila = this.lineas.find(
          (item) => item.idempotency_key === idempotencyKey && item.legal_audit_id === legalAuditId
        );
        if (fila) fila.alegra_journal_id = journalId;
        return;
      }
      const alegraSyncId = args[0];
      const lineaNumero = args[2];
      const idempotencyKey = args[3];
      const legalAuditId = args[4];
      const journalId = args[5];
      const existe = this.lineas.some(
        (fila) => fila.idempotency_key === idempotencyKey && fila.legal_audit_id === legalAuditId
      );
      if (!existe) {
        this.lineas.push({
          alegra_sync_id: alegraSyncId,
          tenant_id: args[1],
          linea_numero: lineaNumero,
          idempotency_key: idempotencyKey,
          legal_audit_id: legalAuditId,
          alegra_journal_id: journalId,
        });
      }
      return;
    }
    if (sql.includes('ledger_checkpoint')) {
      if (sql.startsWith('UPDATE')) {
        const hash = args[0];
        const total = args[1];
        const fechaCorte = args[3];
        const fila = this.checkpoints.find((item) => item.fecha_corte === fechaCorte);
        if (fila) {
          fila.hash_cadena = hash;
          fila.total_registros = total;
          fila.verificado = 1;
        }
        return;
      }
      const fechaCorte = args[1];
      const hash = args[2];
      const total = args[3];
      const existe = this.checkpoints.some((fila) => fila.fecha_corte === fechaCorte);
      if (!existe) {
        this.checkpoints.push({
          tenant_id: args[0],
          fecha_corte: fechaCorte,
          hash_cadena: hash,
          total_registros: total,
          verificado: 1,
        });
      }
    }
  }
}

class FakeR2 {
  store = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const valor = this.store.get(key);
    return valor === undefined ? null : { text: async () => valor };
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[] }> {
    const prefix = options?.prefix ?? '';
    return {
      objects: [...this.store.keys()]
        .filter((clave) => clave.startsWith(prefix))
        .map((clave) => ({ key: clave })),
    };
  }
}

class FakeKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** MCP de Alegra simulado: cuenta las llamadas y devuelve ids deterministas. */
class FakeAlegra implements AlegraApi {
  llamadas = 0;
  llamadasListAccounts = 0;
  asientosCreados: { legal_audit_id: string; journal_id: string }[] = [];
  cuentas: AlegraCuenta[] = [
    { codigo: '5101-001', nombre: 'Gastos de cobranza' },
    { codigo: '5101-003', nombre: 'Contingencias legales' },
    { codigo: '6101-001', nombre: 'Multas y sanciones' },
    { codigo: '1102-003', nombre: 'Provisión por cartera ilegal' },
  ];
  /** Asientos que Alegra "tiene" (para la reconciliación). */
  existentes: string[] = [];

  async listAccounts(): Promise<AlegraCuenta[]> {
    this.llamadas += 1;
    this.llamadasListAccounts += 1;
    return this.cuentas;
  }

  async createJournalEntry(asiento: {
    legal_audit_id: string;
  }): Promise<{ id: string; raw: unknown }> {
    this.llamadas += 1;
    const id = `jest_${this.asientosCreados.length + 1}`;
    this.asientosCreados.push({ legal_audit_id: asiento.legal_audit_id, journal_id: id });
    this.existentes.push(id);
    return { id, raw: { id } };
  }

  async listJournalEntries(): Promise<{ id: string }[]> {
    this.llamadas += 1;
    return this.existentes.map((id) => ({ id }));
  }
}

function entorno(db: FakeD1, r2 = new FakeR2(), kv = new FakeKV()): Env {
  return {
    ENVIRONMENT: 'test',
    TZ,
    DB: db as unknown as D1Database,
    R2: r2 as unknown as R2Bucket,
    KV: kv as unknown as KVNamespace,
    COBRANZA_QUEUE: {
      send: async () => undefined,
    } as unknown as Queue,
  } as unknown as Env;
}

/**
 * Contexto de tenant para los servicios de contabilidad.
 *
 * La contabilidad ya no recibe el `env` pelado: recibe el contexto con el
 * tenant, que es lo que hace que el corte contable de una empresa no se
 * mezcle con el de otra. El módulo sólo usa `ctx.config.tz` y `ctx.tenantId`,
 * así que el resto va con valores de referencia.
 */
function contextoDe(env: Env, tenantId = 't_arkangel'): TenantContext {
  return {
    env,
    tenantId,
    tenant: { id: tenantId } as Tenant,
    config: {
      tz: TZ,
      razonSocial: '',
      condusef: '',
      dominiosPermitidos: [],
      horaInicio: 8,
      horaFin: 22,
      maxContactos24h: 3,
      montoToleranciaCents: 0,
      horarioEnRespuestas: false,
      rateLimitRpm: 42,
      dedupeWindowHours: 24,
      scoreAmountCeilingCents: 200000,
      agentMode: 'supervised',
      agentAutoThresholdCents: 200000,
      dryRun: false,
      cronAutoFire: false,
    },
    channels: [],
    principal: platformPrincipal('test'),
  };
}

function auditoria(
  id: string,
  reglaId: string,
  accion: string,
  caseId: string,
  clientId: string
): FakeRow {
  return {
    id,
    tenant_id: TENANT_ID,
    regla_id: reglaId,
    ley: 'Código Penal Federal',
    articulo: 'Art. 284 Bis',
    castigo: 'Prisión de 2 a 5 años',
    accion,
    detalle: `violación ${reglaId}`,
    evidencia: 'mensaje original',
    case_id: caseId,
    client_id: clientId,
    canal: 'whatsapp',
    created_at: '2026-10-19T12:00:00.000Z',
  };
}

function datosBase(): FakeD1 {
  const db = new FakeD1();
  db.tenants = [
    {
      id: TENANT_ID,
      slug: 'arkangel',
      nombre: 'Arkangel',
      status: 'active',
      config_mode: 'db',
      razon_social: 'Cobranzas Arkangel S.A. de C.V.',
      condusef_registro: 'CONDUSEF-0001',
      allowed_payment_domains: 'pago.example.com',
      tz: TZ,
      send_window_start: 8,
      send_window_end: 22,
      max_contacts_per_day: 3,
      legal_monto_tolerancia_cents: 0,
      legal_horario_en_respuestas: 0,
      rate_limit_rpm: 42,
      dedupe_window_hours: 24,
      score_amount_ceiling_cents: 200000,
      agent_mode: 'supervised',
      agent_auto_threshold_cents: 200000,
      dry_run: 0,
      cron_auto_fire: 0,
      is_default: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    },
  ];
  db.mapa = [
    {
      regla_id: '2.1',
      cuenta_debito: '5101-001',
      cuenta_credito: '1102-003',
      tipo_asiento: 'provision',
    },
    {
      regla_id: '2.4',
      cuenta_debito: '6101-001',
      cuenta_credito: '1102-003',
      tipo_asiento: 'gasto',
    },
    {
      regla_id: '8.1',
      cuenta_debito: '5101-003',
      cuenta_credito: '1102-003',
      tipo_asiento: 'contingencia',
    },
  ];
  db.auditoria = [
    auditoria('leg_1', '2.1', 'SANITIZE', 'cas_1', 'cli_1'),
    auditoria('leg_2', '2.4', 'BLOCK', 'cas_2', 'cli_2'),
    auditoria('leg_3', '8.1', 'BLOCK', 'cas_3', 'cli_3'),
  ];
  db.historia = db.auditoria;
  db.casos = [
    { id: 'cas_1', client_id: 'cli_1', amount_cents: 80000, status: 'sent' },
    { id: 'cas_2', client_id: 'cli_2', amount_cents: 20000, status: 'human' },
    { id: 'cas_3', client_id: 'cli_3', amount_cents: 100000, status: 'human' },
  ];
  db.contratos = [
    { id: 'con_1', client_id: 'cli_1', monto_pactado_cents: 80000 },
    { id: 'con_2', client_id: 'cli_2', monto_pactado_cents: 20000 },
    { id: 'con_3', client_id: 'cli_3', monto_pactado_cents: 100000 },
  ];
  db.ingresos = [
    {
      client_id: 'cli_1',
      contract_id: 'con_1',
      monto_pactado_cents: 80000,
      mensajes: 1,
      status: 'delivered',
      created_at: '2026-10-19T12:00:00.000Z',
    },
  ];
  return db;
}

describe('ventana contable', () => {
  it('mapea el día hábil de CDMX a una ventana UTC semiabierta', () => {
    const ventana = ventanaUtcDeDia(FECHA, TZ);
    expect(ventana.desde).toBe('2026-10-19T06:00:00.000Z');
    expect(ventana.hasta).toBe('2026-10-20T06:00:00.000Z');
  });

  it('el payload declara la ventana en UTC y en CDMX', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);

    expect(payload.ventana.inicio_utc).toBe('2026-10-19T06:00:00.000Z');
    expect(payload.ventana.fin_utc).toBe('2026-10-20T06:00:00.000Z');
    expect(payload.ventana.inicio_cdmx).toBe('2026-10-19T00:00:00-06:00');
    expect(payload.ventana.fin_cdmx).toBe('2026-10-20T00:00:00-06:00');
  });

  it('el corte es el día hábil cerrado (no un día UTC partido)', () => {
    expect(diaPrevioIso(TZ)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildAccountingPayload', () => {
  it('genera un asiento por violación con la cuenta del mapa contable', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);

    expect(payload.asientos).toHaveLength(3);
    expect(payload.asientos.map((asiento) => asiento.regla_id)).toEqual(['2.1', '2.4', '8.1']);

    const [amenaza, horario, contrato] = payload.asientos;
    expect(amenaza?.cuenta_debito).toBe('5101-001');
    expect(amenaza?.cuenta_credito).toBe('1102-003');
    expect(amenaza?.tipo_asiento).toBe('provision');
    expect(amenaza?.monto).toBe(800);

    expect(horario?.cuenta_debito).toBe('6101-001');
    expect(horario?.tipo_asiento).toBe('gasto');
    expect(horario?.monto).toBe(200);

    expect(contrato?.cuenta_debito).toBe('5101-003');
    expect(contrato?.tipo_asiento).toBe('contingencia');
    expect(contrato?.monto).toBe(1000);
  });

  it('el concepto y la referencia ledger apuntan al legal_audit original', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);
    const asiento = payload.asientos[0];

    expect(asiento?.legal_audit_id).toBe('leg_1');
    expect(asiento?.concepto).toContain('leg_1');
    expect(asiento?.referencia_ledger).toMatch(/^0x[0-9a-f]{20}$/);
    expect(asiento?.cfdi_relacionado).toBeNull();
    expect(asiento?.concepto).toContain('sin CFDI');
  });

  it('el resumen cuadra con los montos del corte', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);

    expect(payload.resumen.ingresos_reconocidos).toBe(800);
    expect(payload.resumen.ingresos_no_reconocidos_por_bloqueo).toBe(1200);
    expect(payload.resumen.provision_cartera_ilegal).toBe(2000);
    expect(payload.resumen.iva_trasladado).toBe(128);
    expect(payload.desglose_bloqueos['2.1']).toEqual({ count: 1, monto: 800 });
    expect(payload.desglose_bloqueos['8.1']).toEqual({ count: 1, monto: 1000 });
  });

  it('el IVA acreditable se publica como estimado, con su fuente', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);

    expect(payload.resumen.iva_acreditable_estimado).toBe(32);
    expect(payload.metadata.fuente_iva_acreditable).toBe('estimado_por_gastos_arkangel');
    expect(payload.metadata.nota).toContain('CFDI de proveedores');
  });

  it('el payload valida contra el esquema Zod', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);
    const validado = validarPayload(payload);
    expect(validado.ok).toBe(true);
    expect(payload.idempotency_key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.periodo).toBe('2026-10');
  });

  it('la idempotency key cambia con el salt', async () => {
    const db = datosBase();
    const env = entorno(db);
    const conSalt = await buildAccountingPayload(
      contextoDe({
        ...env,
        ALEGRA_IDEMPOTENCY_SALT: 'pepita',
      } as Env),
      FECHA
    );
    const sinSalt = await buildAccountingPayload(contextoDe(env), FECHA);
    expect(conSalt.idempotency_key).not.toBe(sinSalt.idempotency_key);
  });

  it('una regla sin mapeo contable no genera asiento y deja warning', async () => {
    const db = datosBase();
    db.auditoria.push(auditoria('leg_4', '9.9', 'BLOCK', 'cas_4', 'cli_4'));
    db.historia = db.auditoria;

    const { payload, reglasSinMapa } = await construirPayload(contextoDe(entorno(db)), FECHA);
    expect(payload.asientos).toHaveLength(3);
    expect(reglasSinMapa).toEqual(['9.9']);
    expect(db.eventos.some((evento) => evento.type === 'contabilidad.regla_sin_mapa')).toBe(true);
  });
});

describe('regla de reconocimiento de ingreso', () => {
  it('un mensaje en estado sent NO genera ingreso reconocido', async () => {
    const db = datosBase();
    db.ingresos = [
      {
        client_id: 'cli_1',
        contract_id: 'con_1',
        monto_pactado_cents: 80000,
        mensajes: 1,
        status: 'sent',
        created_at: '2026-10-19T12:00:00.000Z',
      },
    ];

    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);
    expect(payload.resumen.ingresos_reconocidos).toBe(0);
  });

  it('un mensaje delivered sí genera ingreso reconocido', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);
    expect(payload.resumen.ingresos_reconocidos).toBe(800);
    expect(payload.metadata.regla_ingreso_reconocido).toContain('delivered');
  });
});

describe('sendToAlegra', () => {
  it('crea un asiento por violación y registra la trazabilidad', async () => {
    const db = datosBase();
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    const resultado = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });

    expect(resultado.ok).toBe(true);
    expect(resultado.estado).toBe('sent');
    expect(alegra.asientosCreados).toHaveLength(3);
    expect(db.lineas).toHaveLength(3);
    expect(db.sync[0]?.status).toBe('sent');
    expect(db.sync[0]?.alegra_journal_id).toBe('jest_1');
    expect(db.eventos.some((evento) => evento.type === 'alegra_sync')).toBe(true);
  });

  it('no duplica asientos si el mismo día se procesa dos veces', async () => {
    const db = datosBase();
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    const creados = alegra.asientosCreados.length;
    const segunda = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });

    expect(segunda.estado).toBe('omitido');
    expect(alegra.asientosCreados).toHaveLength(creados);
    expect(db.lineas).toHaveLength(3);
  });

  it('no llama a Alegra si el ledger no verifica', async () => {
    const db = datosBase();
    db.checkpoints = [
      {
        fecha_corte: '2026-10-18',
        hash_cadena: '0xalterado',
        total_registros: 99,
        verificado: 1,
      },
    ];
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    expect(payload.ledger_integrity.verificado).toBe(false);
    const resultado = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });

    expect(resultado.ok).toBe(false);
    expect(resultado.estado).toBe('skipped');
    expect(resultado.motivo).toBe('ledger_broken');
    expect(alegra.llamadas).toBe(0);
    expect(db.eventos.some((evento) => evento.type === 'ledger_broken')).toBe(true);
  });

  it('un checkpoint marcado como no verificado detiene el envío', async () => {
    const db = datosBase();
    db.checkpoints = [
      {
        fecha_corte: '2026-10-18',
        hash_cadena: '0xalterado',
        total_registros: 99,
        verificado: 0,
      },
    ];
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    expect(payload.ledger_integrity.verificado).toBe(false);
    await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    expect(alegra.llamadas).toBe(0);
  });

  it('un día sin violaciones no rompe la verificación (checkpoint en el génesis)', async () => {
    const db = datosBase();
    db.checkpoints = [
      {
        fecha_corte: '2026-10-18',
        hash_cadena: '0x0',
        total_registros: 0,
        verificado: 1,
      },
    ];
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);

    expect(payload.ledger_integrity.verificado).toBe(true);
  });

  it('el catálogo de cuentas se cachea 24 h en KV', async () => {
    const db = datosBase();
    const kv = new FakeKV();
    const env = entorno(db, new FakeR2(), kv);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    expect(alegra.llamadasListAccounts).toBe(1);
    expect(kv.store.has(`alegra:accounts:${TENANT_ID}:${FECHA}`)).toBe(true);

    // Segundo envío (idempotente): no vuelve a listar cuentas.
    await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    expect(alegra.llamadasListAccounts).toBe(1);
  });

  it('fallback de cuenta: warning accionable en events y cuenta 5101-004', async () => {
    const db = datosBase();
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();
    alegra.cuentas = [{ codigo: '1102-003', nombre: 'Provisión por cartera ilegal' }];

    const resultado = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });

    expect(resultado.ok).toBe(true);
    const evento = db.eventos.find((item) => item.type === 'alegra_account_fallback');
    expect(evento).toBeDefined();
    const payloadEvento = JSON.parse(String(evento?.payload)) as Record<string, unknown>;
    expect(payloadEvento.regla_id).toBe('2.1');
    expect(payloadEvento.cuenta_esperada).toBe('5101-001');
    expect(payloadEvento.cuenta_usada).toBe('5101-004');
    expect(payloadEvento.motivo).toBe('cuenta_no_existe_en_alegra');
    expect(payloadEvento.accion_requerida).toBe('Verificar catálogo de cuentas en Alegra');
  });

  it('si Alegra rechaza la cuenta, reintenta el asiento con la cuenta de contingencia', async () => {
    const db = datosBase();
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);

    class Rechazador implements AlegraApi {
      intentos = 0;

      async listAccounts(): Promise<AlegraCuenta[]> {
        return [
          { codigo: '5101-001', nombre: 'Gastos de cobranza' },
          { codigo: '5101-003', nombre: 'Contingencias legales' },
          { codigo: '6101-001', nombre: 'Multas y sanciones' },
          { codigo: '1102-003', nombre: 'Provisión por cartera ilegal' },
        ];
      }

      async createJournalEntry(): Promise<{ id: string; raw: unknown }> {
        this.intentos += 1;
        if (this.intentos === 1) {
          throw new Error('Alegra rechazó la cuenta 5101-001: no existe en el catálogo');
        }
        return { id: `jest_${this.intentos}`, raw: {} };
      }
    }

    const alegra = new Rechazador();
    const resultado = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });

    expect(resultado.ok).toBe(true);
    // 3 asientos: el primero se rechaza y se reintenta con la cuenta de contingencia.
    expect(alegra.intentos).toBe(4);
    expect(db.lineas).toHaveLength(3);
  });
});

describe('reconciliación (flujo de dos fases)', () => {
  it('si el UPDATE a alegra_sync falla, la reconciliación no duplica asientos', async () => {
    const db = datosBase();
    const r2 = new FakeR2();
    const env = entorno(db, r2);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const alegra = new FakeAlegra();

    // Fase 1 y 2: el asiento se crea en Alegra pero el UPDATE a D1 revienta.
    db.fallarUpdateSync = true;
    const primerIntento = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    expect(primerIntento.ok).toBe(false);
    expect(alegra.asientosCreados.length).toBeGreaterThan(0);
    expect(db.sync[0]?.status).toBe('failed');
    // Las líneas sí quedaron escritas (se escriben antes del UPDATE).
    expect(db.lineas.length).toBeGreaterThan(0);

    await guardarPayloadEnR2(contextoDe(env), FECHA, payload);
    db.fallarUpdateSync = false;

    // Siguiente corrida: la reconciliación pregunta a Alegra y no re-asienta.
    const resultado = await reconciliarCortesPendientes(env, { cliente: alegra });

    expect(resultado[0]?.reconciliados).toBe(1);
    expect(alegra.asientosCreados).toHaveLength(3);
    expect(db.sync[0]?.status).toBe('reconciled');
    expect(r2.store.has(claveR2(contextoDe(env), FECHA))).toBe(true);
  });

  it('sin confirmación de Alegra no se re-asienta: se avisa al humano', async () => {
    const db = datosBase();
    const env = entorno(db);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);

    class Mudo implements AlegraApi {
      creados = 0;

      async listAccounts(): Promise<AlegraCuenta[]> {
        return [];
      }
      async createJournalEntry(): Promise<{ id: string; raw: unknown }> {
        this.creados += 1;
        return { id: `jest_${this.creados}`, raw: {} };
      }
      async listJournalEntries(): Promise<{ id: string }[]> {
        // Alegra no devuelve nada: no se puede confirmar qué existe.
        return [];
      }
    }

    const alegra = new Mudo();
    db.fallarUpdateSync = true;
    const primerIntento = await sendToAlegra(payload, contextoDe(env), { cliente: alegra });
    expect(primerIntento.ok).toBe(false);
    const creadosAntes = alegra.creados;
    await guardarPayloadEnR2(contextoDe(env), FECHA, payload);

    const resultado = await reconciliarCortesPendientes(env, { cliente: alegra });
    expect(resultado[0]?.sinConfirmar).toBe(1);
    expect(alegra.creados).toBe(creadosAntes);
    expect(
      db.eventos.some((evento) => evento.type === 'alegra_reconciliacion_sin_confirmacion')
    ).toBe(true);
  });
});

describe('cron contable', () => {
  it('el trigger 59 5 * * * dispara a las 23:59 CDMX y corta el día anterior', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toContain('"59 5 * * *"');
    expect(config).not.toContain('"59 23 * * *"');

    // 05:59 UTC = 23:59 CDMX del día anterior.
    const instante = new Date('2026-10-20T05:59:00.000Z');
    const cdmx = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instante);
    expect(cdmx).toContain('2026-10-19');
    expect(cdmx).toContain('23:59');
  });

  it('guarda el JSON en R2 y deja el corte auditado', async () => {
    const db = datosBase();
    const r2 = new FakeR2();
    const env = entorno(db, r2);

    const resultado = await handleContabilidadDaily(env, FECHA);

    expect(resultado[0]?.payloadGuardado).toBe(true);
    expect(r2.store.has(claveR2(contextoDe(env), FECHA))).toBe(true);
    expect(db.eventos.some((evento) => evento.type === 'alegra_sync')).toBe(true);
  });

  it('el payload queda en R2 con la ruta canónica', async () => {
    const db = datosBase();
    const r2 = new FakeR2();
    const env = entorno(db, r2);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    const key = await guardarPayloadEnR2(contextoDe(env), FECHA, payload);

    expect(key).toBe(claveR2(contextoDe(env), FECHA));
    expect(key).toBe('contabilidad/t_arkangel/2026-10-19.json');
    expect(r2.store.get(key)).toContain('idempotency_key');
  });

  it('sin fecha, el endpoint devuelve el último corte publicado', async () => {
    const db = datosBase();
    const r2 = new FakeR2();
    const env = entorno(db, r2);
    const payload = await buildAccountingPayload(contextoDe(env), FECHA);
    await guardarPayloadEnR2(contextoDe(env), FECHA, payload);

    const ultimo = await leerUltimoPayload(contextoDe(env));
    expect(ultimo?.fecha).toBe(FECHA);
    expect(ultimo?.payload.asientos).toHaveLength(3);
  });
});

describe('transporte MCP', () => {
  it('parsea una respuesta text/event-stream (SSE)', async () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}',
      '',
    ].join('\n');

    const response = new Response(sse, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const mensaje = await leerRespuestaMcp(response);
    expect(mensaje?.result?.content?.[0]?.text).toContain('ok');
  });

  it('parsea una respuesta application/json', async () => {
    const response = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { cuentas: [] } } }),
      { headers: { 'content-type': 'application/json' } }
    );

    const mensaje = await leerRespuestaMcp(response);
    expect(mensaje?.result?.structuredContent).toEqual({ cuentas: [] });
  });

  it('mapea los errores JSON-RPC a retry/fail', () => {
    expect(MCP_ERROR_MAP[-32600]).toBe('fail');
    expect(MCP_ERROR_MAP[-32603]).toBe('retry');
    expect(MCP_ERROR_MAP[-32000]).toBe('retry');
  });
});

describe('consultas del módulo', () => {
  it('las consultas del ledger son append-only (sólo SELECT)', () => {
    expect(SQL_AUDITORIA_DIA.trim().startsWith('SELECT')).toBe(true);
    expect(SQL_LEDGER_HISTORIA.trim().startsWith('SELECT')).toBe(true);
    expect(SQL_LEDGER_HISTORIA).not.toContain('UPDATE');
    expect(SQL_LEDGER_HISTORIA).not.toContain('DELETE');
    expect(SQL_CHECKPOINT_FECHA.trim().startsWith('SELECT')).toBe(true);
  });

  it('el payload serializado es JSON puro', async () => {
    const db = datosBase();
    const payload = await buildAccountingPayload(contextoDe(entorno(db)), FECHA);
    const texto = JSON.stringify(payload);
    const parseado = JSON.parse(texto) as AccountingPayload;
    expect(parseado.fecha_corte).toBe(FECHA);
    expect(parseado.asientos).toHaveLength(3);
    expect(parseado.ventana.inicio_utc).toBe('2026-10-19T06:00:00.000Z');
  });

  it('GET /contabilidad/resumen?live=1 calcula el corte en vivo sin depender de R2', async () => {
    const db = datosBase();
    const env = { ...entorno(db), ADMIN_TOKEN: 'adm_test_1' };

    const res = await contabilidad.request(
      `/contabilidad/resumen?live=1&fecha=${FECHA}`,
      { headers: { 'x-admin-token': 'adm_test_1', 'x-tenant-id': TENANT_ID } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      source: string;
      fecha_corte: string;
      ledger_integrity: { verificado: boolean };
      asientos: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe('live');
    expect(body.fecha_corte).toBe(FECHA);
    expect(body.ledger_integrity.verificado).toBe(true);
    expect(body.asientos).toHaveLength(3);
  });

  it('GET y PUT /tenant/accounting-map permiten editar cuentas contables Alegra por despacho (Fase 6)', async () => {
    const db = datosBase();
    const env = { ...entorno(db), ADMIN_TOKEN: 'adm_test_1' };
    const headers = {
      'x-admin-token': 'adm_test_1',
      'x-tenant-id': TENANT_ID,
      'content-type': 'application/json',
    };

    const getRes = await contabilidad.request('/tenant/accounting-map', { headers }, env);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      rules: Array<{ regla_id: string; cuenta_debito: string }>;
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.rules.length).toBeGreaterThanOrEqual(3);

    const putRes = await contabilidad.request(
      '/tenant/accounting-map',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          rules: [
            {
              regla_id: '2.1',
              cuenta_debito: '5999-001',
              cuenta_credito: '2199-009',
              tipo_asiento: 'provision',
              descripcion: 'Cuenta personalizada despacho',
            },
          ],
        }),
      },
      env
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      ok: boolean;
      updated: number;
      rules: Array<{ regla_id: string; cuenta_debito: string; cuenta_credito: string }>;
    };
    expect(putBody.ok).toBe(true);
    expect(putBody.updated).toBe(1);
    const regla21 = putBody.rules.find((r) => r.regla_id === '2.1');
    expect(regla21?.cuenta_debito).toBe('5999-001');
    expect(regla21?.cuenta_credito).toBe('2199-009');
  });

  it('GET /reports/daily y POST /reports/daily/send generan y registran el Reporte Ejecutivo Diario Automatizado', async () => {
    const db = datosBase();
    const env = { ...entorno(db), ADMIN_TOKEN: 'adm_test_1' };
    const headers = {
      'x-admin-token': 'adm_test_1',
      'x-tenant-id': TENANT_ID,
      'content-type': 'application/json',
    };

    const getRes = await contabilidad.request(`/reports/daily?date=${FECHA}`, { headers }, env);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      report: {
        date: string;
        contabilidad: {
          ledger_verificado: boolean;
          ingresos_reconocidos_mxn: number;
          total_asientos: number;
        };
      };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.report.date).toBe(FECHA);
    expect(getBody.report.contabilidad.ledger_verificado).toBe(true);
    expect(getBody.report.contabilidad.ingresos_reconocidos_mxn).toBe(800);
    expect(getBody.report.contabilidad.total_asientos).toBe(3);

    const sendRes = await contabilidad.request(
      '/reports/daily/send',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ date: FECHA, to: 'contador@despacho.mx' }),
      },
      env
    );
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as {
      ok: boolean;
      recipients: string[];
    };
    expect(sendBody.ok).toBe(true);
    expect(sendBody.recipients).toEqual(['contador@despacho.mx']);
    expect(db.eventos.some((e) => e.type === 'reporte.diario_enviado')).toBe(true);
  });
});
