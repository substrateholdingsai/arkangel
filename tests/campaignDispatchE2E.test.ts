import { describe, expect, it } from 'vitest';
import { CampaignRunnerDO } from '../src/durable/campaign-runner';
import type { CampaignDispatchV1 } from '../src/comunicacion/contrato';
import type { Env } from '../src/types/env';

interface MockDbRows {
  comm_envios: any[];
  usage_events: any[];
  comm_consents: any[];
  comm_suppressions: any[];
  comm_templates: any[];
  comm_repep_versions: any[];
  comm_repep_numbers: any[];
  tenants: any[];
  clients: any[];
  cases: any[];
}

function createMockCampaignEnv(): { env: Env; dbRows: MockDbRows } {
  const dbRows: MockDbRows = {
    comm_envios: [],
    usage_events: [],
    comm_consents: [],
    comm_suppressions: [],
    comm_repep_versions: [
      {
        id: 'rep_activo',
        list_date: new Date().toISOString().slice(0, 10),
        total: 500,
        status: 'active',
      },
    ],
    comm_repep_numbers: [],
    comm_templates: [
      {
        id: 'tpl_bienvenida_socio',
        tenant_id: 'canaco_merida',
        channel: 'whatsapp',
        nombre: 'Bienvenida Socio',
        meta_name: 'bienvenida_socio_canaco',
        lang: 'es_MX',
        categoria: 'marketing',
        status: 'APPROVED',
        subject: null,
        body_preview: 'Hola {{nombre}}, {{marca}} te da la bienvenida.',
        variables_json: JSON.stringify(['nombre']),
        shared: 1,
      },
    ],
    tenants: [
      {
        id: 'canaco_merida',
        slug: 'canaco-merida',
        nombre: 'CANACO SERVYTUR Mérida',
        status: 'active',
        config_mode: 'db',
        razon_social: 'CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA',
        condusef_registro: 'CANACO-MERIDA-SIEM-2026',
        allowed_payment_domains: 'arksystems.site',
        tz: 'America/Merida',
        send_window_start: 8,
        send_window_end: 20,
        max_contacts_per_day: 2,
        legal_monto_tolerancia_cents: 0,
        legal_horario_en_respuestas: 0,
        rate_limit_rpm: 42,
        dedupe_window_hours: 24,
        score_amount_ceiling_cents: 200000,
        agent_mode: 'supervised',
        agent_auto_threshold_cents: 200000,
        dry_run: 1, // DRY_RUN en el tenant para pruebas seguras
        cron_auto_fire: 0,
        is_default: 0,
        created_at: '2026-10-20',
        updated_at: '2026-10-20',
        tenant_level: 'organizacion',
        marca_comercial: 'CANACO SERVYTUR Mérida',
        comm_max_por_semana: 2,
        comm_optout_scope: 'marca',
      },
    ],
    clients: [
      {
        id: 'cli_cobranza_activa',
        tenant_id: 'canaco_merida',
        phone: '+529990000005',
      },
    ],
    cases: [
      {
        id: 'cas_1',
        client_id: 'cli_cobranza_activa',
        tenant_id: 'canaco_merida',
        status: 'sending',
      },
    ],
  };

  const env: Env = {
    DRY_RUN: 'true',
    TELNYX_API_KEY: 'mock_key',
    TELNYX_FROM_NUMBER: '+529999253060',
    DB: {
      prepare: (sql: string) => {
        let boundArgs: any[] = [];
        const stmt = {
          bind: (...args: any[]) => {
            boundArgs = args;
            return stmt;
          },
          first: async <T>() => {
            if (sql.includes('FROM tenants WHERE id = ?')) {
              return dbRows.tenants[0] as T;
            }
            if (sql.includes('FROM comm_templates')) {
              return dbRows.comm_templates[0] as T;
            }
            if (sql.includes('comm_repep_versions') && sql.includes("status = 'active'")) {
              return dbRows.comm_repep_versions[0] as T;
            }
            if (sql.includes('comm_repep_numbers')) {
              const [phoneHash, versionId] = boundArgs;
              const found = dbRows.comm_repep_numbers.find(
                (r) => r.phone_hash === phoneHash && r.version_id === versionId
              );
              return (found ?? null) as T;
            }
            if (sql.includes('FROM comm_consents')) {
              const [tid, contacto] = boundArgs;
              const found = dbRows.comm_consents.find(
                (c) => c.tenant_id === tid && c.contacto === contacto
              );
              return (found ?? null) as T;
            }
            if (sql.includes('FROM comm_suppressions')) {
              const [tid, contacto] = boundArgs;
              const found = dbRows.comm_suppressions.find(
                (s) => s.tenant_id === tid && s.contacto === contacto
              );
              return (found ?? null) as T;
            }
            if (sql.includes('FROM clients cl')) {
              const [tid, phone] = boundArgs;
              const foundCli = dbRows.clients.find((c) => c.tenant_id === tid && c.phone === phone);
              if (foundCli) {
                const foundCase = dbRows.cases.find(
                  (k) => k.client_id === foundCli.id && k.tenant_id === tid
                );
                if (foundCase) return { id: foundCase.id } as T;
              }
              return null as T;
            }
            return null as T;
          },
          all: async <T>() => {
            if (sql.includes('tenant_channels')) {
              return { results: [] as T[] };
            }
            return { results: [] as T[] };
          },
          run: async () => {
            if (sql.includes('INSERT OR REPLACE INTO comm_envios')) {
              const [id, tid, oid, campId, contacto, channel, tplId, cat, param9] = boundArgs;
              const status = sql.includes("'excluded'")
                ? 'excluded'
                : sql.includes("'deferred'")
                  ? 'deferred'
                  : 'sent';
              dbRows.comm_envios.push({
                id,
                tenant_id: tid,
                org_tenant_id: oid,
                campaign_id: campId,
                contacto,
                channel,
                template_id: tplId,
                categoria: cat,
                status,
                motivo: status === 'excluded' ? param9 : null,
                scheduled_for: status === 'deferred' ? param9 : null,
                provider_id: status === 'sent' ? param9 : null,
              });
            }
            if (sql.includes('INSERT INTO usage_events')) {
              const [id, tid, pid, campId, channel, unitCost, totalCost] = boundArgs;
              dbRows.usage_events.push({
                id,
                tenant_id: tid,
                parent_tenant_id: pid,
                campaign_id: campId,
                channel,
                unit_cost_cents: unitCost,
                total_cost_cents: totalCost,
              });
            }
            return { success: true };
          },
        };
        return stmt;
      },
    } as any,
  } as Env;

  return { env, dbRows };
}

describe('Campaña End-to-End de 10 Contactos (WhatsApp)', () => {
  it('aplica todas las reglas fail-closed, registra envíos, exclusiones y eventos de consumo', async () => {
    const { env, dbRows } = createMockCampaignEnv();

    // 1. Configurar consentimientos en D1:
    // Contactos 1, 2, 3: SIN consentimiento
    // Contactos 4, 7, 8, 9, 10: CON consentimiento
    // Contacto 5: con cobranza activa
    // Contacto 6: en lista de supresión (Opt-out previo)
    const telefonosConOptIn = [
      '+529990000004',
      '+529990000007',
      '+529990000008',
      '+529990000009',
      '+529990000010',
    ];
    for (const tel of telefonosConOptIn) {
      dbRows.comm_consents.push({
        id: `c_${tel}`,
        tenant_id: 'canaco_merida',
        contacto: tel,
        channel: 'whatsapp',
        categoria: 'marketing',
        opt_in_at: '2026-02-01T12:00:00Z',
        opt_in_source: 'registro_agremiados_canaco',
        revoked_at: null,
      });
    }

    // Contacto 6 suprimido
    dbRows.comm_suppressions.push({
      id: 'supp_6',
      tenant_id: 'canaco_merida',
      contacto: '+529990000006',
      reason: 'opt_out',
    });

    // Audiencia de prueba de 10 contactos
    const audience = [
      { phone: '+529990000001', name: 'Contacto 1' }, // Sin opt-in -> Excluido
      { phone: '+529990000002', name: 'Contacto 2' }, // Sin opt-in -> Excluido
      { phone: '+529990000003', name: 'Contacto 3' }, // Sin opt-in -> Excluido
      { phone: '+529990000004', name: 'Contacto 4' }, // Con opt-in -> ENVIADO
      { phone: '+529990000005', name: 'Contacto 5' }, // Cobranza activa -> Excluido
      { phone: '+529990000006', name: 'Contacto 6' }, // Suprimido -> Excluido
      { phone: '+529990000007', name: 'Contacto 7' }, // Con opt-in -> ENVIADO
      { phone: '+529990000008', name: 'Contacto 8' }, // Con opt-in -> ENVIADO
      { phone: '+529990000009', name: 'Contacto 9' }, // Con opt-in -> ENVIADO
      { phone: '+529990000010', name: 'Contacto 10' }, // Con opt-in -> ENVIADO
    ];

    const campaignPayload: CampaignDispatchV1 = {
      version: 'CAMPAIGN_DISPATCH_V1',
      campaign_id: 'camp_e2e_prueba_10',
      motor: 'comunicacion',
      tenant_id: 'canaco_merida',
      canal: 'whatsapp',
      proposito: 'promocion',
      template_id: 'tpl_bienvenida_socio',
      audience,
      frequency_cap: 2,
    };

    const mockState = {
      storage: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
      },
    } as unknown as DurableObjectState;

    const runner = new CampaignRunnerDO(mockState, env);
    const req = new Request('http://campaign-runner/?action=start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campaignPayload),
    });

    const res = await runner.fetch(req);
    expect(res.status).toBe(200);
    const finalState = await res.json<any>();

    // Verificación de conteos esperados
    // 5 enviados, 5 excluidos (3 sin opt-in + 1 cobranza activa + 1 suprimido)
    expect(finalState.total).toBe(10);
    expect(finalState.sent).toBe(5);
    expect(finalState.excluded).toBe(5);

    // Verificar filas registradas en comm_envios
    expect(dbRows.comm_envios).toHaveLength(10);
    const enviados = dbRows.comm_envios.filter((e) => e.status === 'sent');
    const excluidos = dbRows.comm_envios.filter((e) => e.status === 'excluded');

    expect(enviados).toHaveLength(5);
    expect(excluidos).toHaveLength(5);

    // Validar motivos de exclusión registrados
    const sinConsent = excluidos.filter((e) => e.motivo === 'sin_consentimiento');
    const cobranza = excluidos.filter((e) => e.motivo === 'cobranza_activa');
    const suprimidos = excluidos.filter((e) => e.motivo === 'suprimido');

    expect(sinConsent).toHaveLength(3);
    expect(cobranza).toHaveLength(1);
    expect(suprimidos).toHaveLength(1);

    // Verificar que los 5 envíos generaron eventos de consumo para la bolsa de créditos
    expect(dbRows.usage_events).toHaveLength(5);
    for (const event of dbRows.usage_events) {
      expect(event.parent_tenant_id).toBe('canaco_merida');
      expect(event.campaign_id).toBe('camp_e2e_prueba_10');
      expect(event.channel).toBe('whatsapp');
      expect(event.unit_cost_cents).toBe(95);
    }
  });
});
