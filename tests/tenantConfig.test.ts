import { describe, expect, it } from 'vitest';
import { buildRedactPrompt } from '../src/ai/prompts';
import { platformPrincipal } from '../src/auth/principal';
import { configLegal } from '../src/legal/config';
import { mergeChannelCredentials } from '../src/tenancy/channels';
import {
  configDesdeEntorno,
  configDesdeFila,
  resolveTenantConfig,
  splitPaymentDomains,
} from '../src/tenancy/config';
import type { Tenant, TenantContext } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't_nuevo',
    slug: 'nuevo',
    nombre: 'Empresa Nueva',
    status: 'active',
    config_mode: 'db',
    razon_social: 'Empresa Nueva, S.A. de C.V.',
    condusef_registro: '999',
    allowed_payment_domains: 'paga.nuevo.mx',
    tz: 'America/Mexico_City',
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
    is_default: 0,
    clerk_org_id: null,
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
    ...overrides,
  };
}

function ctx(t: Tenant): TenantContext {
  return {
    env: {} as Env,
    tenantId: t.id,
    tenant: t,
    config: configDesdeFila({} as Env, t),
    channels: [],
    principal: platformPrincipal(),
  };
}

function promptDe(nombreLegal: string, condusef: string): string {
  return buildRedactPrompt({
    clientName: 'Juan Perez',
    amountCents: 845000,
    amountText: '$8,450.00',
    dueDate: '2026-10-01',
    dueDateText: '1 de octubre de 2026',
    diasRetraso: 19,
    band: 'alto',
    channel: 'whatsapp',
    nombreLegal,
    condusef,
  });
}

describe('identidad legal por tenant', () => {
  it('cada empresa de cobranza se identifica con la suya ante CONDUSEF', () => {
    const alfa = ctx(
      tenant({ id: 't_alfa', razon_social: 'Alfa, S.A. de C.V.', condusef_registro: '111' })
    );
    const beta = ctx(
      tenant({ id: 't_beta', razon_social: 'Beta, S.A. de C.V.', condusef_registro: '222' })
    );

    expect(configLegal(alfa).nombreLegal).toBe('Alfa, S.A. de C.V.');
    expect(configLegal(alfa).condusef).toBe('111');
    expect(configLegal(beta).nombreLegal).toBe('Beta, S.A. de C.V.');
    expect(configLegal(beta).condusef).toBe('222');
  });

  it('un tenant sin razón social NO hereda la de la plataforma', () => {
    const nuevo = ctx(tenant({ id: 't_nuevo', razon_social: '', condusef_registro: '' }));
    expect(configLegal(nuevo).nombreLegal).toBe('');
    expect(configLegal(nuevo).condusef).toBe('');
  });

  it('el prompt de la IA lleva la identidad del tenant que emite', () => {
    const promptA = promptDe('Alfa, S.A. de C.V.', '111');
    const promptB = promptDe('Beta, S.A. de C.V.', '222');

    expect(promptA).toContain('Alfa, S.A. de C.V.');
    expect(promptA).toContain('Reg. CONDUSEF 111');
    expect(promptA).not.toContain('Beta');

    expect(promptB).toContain('Beta, S.A. de C.V.');
    expect(promptB).toContain('Reg. CONDUSEF 222');
    expect(promptB).not.toContain('Alfa');
  });

  it('la ventana y los límites legales también son por tenant', () => {
    const estricto = ctx(
      tenant({ send_window_start: 9, send_window_end: 18, max_contacts_per_day: 1 })
    );
    const laxo = ctx(
      tenant({ send_window_start: 8, send_window_end: 22, max_contacts_per_day: 3 })
    );

    expect(configLegal(estricto).horaInicio).toBe(9);
    expect(configLegal(estricto).horaFin).toBe(18);
    expect(configLegal(estricto).maxContactos24h).toBe(1);
    expect(configLegal(laxo).horaInicio).toBe(8);
    expect(configLegal(laxo).maxContactos24h).toBe(3);
  });
});

describe('modo db vs. puente platform_env', () => {
  const env = {
    LEGAL_RAZON_SOCIAL: 'Legacy, S.A. de C.V.',
    LEGAL_CONDUSEF_REGISTRO: '777',
    ALLOWED_PAYMENT_DOMAINS: '',
    SEND_WINDOW_START: '8',
    SEND_WINDOW_END: '22',
    MAX_CONTACTS_PER_DAY: '3',
    LEGAL_MONTO_TOLERANCIA_CENTS: '0',
    LEGAL_HORARIO_EN_RESPUESTAS: 'false',
    TZ: 'America/Mexico_City',
    RATE_LIMIT_RPM: '42',
    DEDUPE_WINDOW_HOURS: '24',
    SCORE_AMOUNT_CEILING_CENTS: '200000',
    AGENT_MODE: 'supervised',
    AGENT_AUTO_THRESHOLD_CENTS: '200000',
    DRY_RUN: 'false',
    CRON_AUTO_FIRE: 'false',
  } as unknown as Env;

  it('platform_env conserva exactamente la configuración del entorno', () => {
    const config = resolveTenantConfig(env, tenant({ config_mode: 'platform_env' }));
    expect(config.razonSocial).toBe('Legacy, S.A. de C.V.');
    expect(config.condusef).toBe('777');
    expect(config.horaInicio).toBe(8);
    expect(config.horaFin).toBe(22);
    expect(config.dominiosPermitidos).toEqual([]);
  });

  it('db toma la configuración de la fila e ignora el entorno', () => {
    const config = resolveTenantConfig(
      env,
      tenant({ config_mode: 'db', razon_social: 'Propia, S.A. de C.V.', send_window_start: 10 })
    );
    expect(config.razonSocial).toBe('Propia, S.A. de C.V.');
    expect(config.horaInicio).toBe(10);
    expect(config.razonSocial).not.toContain('Legacy');
  });

  it('en modo db la allowlist vacía significa "sin links" (fail-closed)', () => {
    const config = configDesdeFila(env, tenant({ allowed_payment_domains: '' }));
    expect(config.dominiosPermitidos).toEqual([]);
  });

  it('la variable de entorno no definida usa el dominio por defecto', () => {
    const sinDominio = { ...env } as Record<string, unknown>;
    delete sinDominio.ALLOWED_PAYMENT_DOMAINS;
    const config = configDesdeEntorno(sinDominio as unknown as Env);
    expect(config.dominiosPermitidos).toEqual(['prestamoclaro.com']);
  });
});

describe('utilidades de configuración', () => {
  it('splitPaymentDomains normaliza y descarta vacíos', () => {
    expect(splitPaymentDomains(' Paga.MX , , otros.com ')).toEqual(['paga.mx', 'otros.com']);
    expect(splitPaymentDomains('')).toEqual([]);
  });

  it('un tenant puede tener su propio número de WhatsApp', () => {
    const propias = mergeChannelCredentials([
      {
        id: 'ch_1',
        tenant_id: 't_alfa',
        channel: 'whatsapp',
        provider_account_id: '998877',
        credentials: {
          whatsapp: { phone_number_id: '998877', template_name: 'alfa_recordatorio' },
        },
        status: 'active',
        created_at: '2026-10-01T00:00:00Z',
      },
      {
        id: 'ch_2',
        tenant_id: 't_alfa',
        channel: 'sms',
        provider_account_id: 'tg_1',
        credentials: { sms: { from_number: '+5255000002' } },
        status: 'active',
        created_at: '2026-10-01T00:00:00Z',
      },
    ]);

    expect(propias.whatsapp?.phone_number_id).toBe('998877');
    expect(propias.whatsapp?.template_name).toBe('alfa_recordatorio');
    expect(propias.sms?.from_number).toBe('+5255000002');
    expect(propias.email).toBeUndefined();
  });

  it('las credenciales se indexan por canal, no por proveedor', () => {
    const propias = mergeChannelCredentials([
      {
        id: 'ch_1',
        tenant_id: 't_alfa',
        channel: 'sms',
        provider_account_id: 'tg_1',
        credentials: { sms: { from_number: '+5255000002' } },
        status: 'active',
        created_at: '2026-10-01T00:00:00Z',
      },
    ]);

    // Un JSON indexado por proveedor ("telnyx", "resend") no se reconoce: la
    // clave se descartaría en silencio y saldría desde la cuenta de la
    // plataforma, con la identidad equivocada ante el deudor.
    expect(propias.sms?.from_number).toBe('+5255000002');
    expect((propias as Record<string, unknown>).telnyx).toBeUndefined();
    expect((propias as Record<string, unknown>).resend).toBeUndefined();
  });

  it('no combina filas del mismo canal: gana la más reciente', () => {
    const propias = mergeChannelCredentials([
      {
        id: 'ch_viejo',
        tenant_id: 't_alfa',
        channel: 'sms',
        provider_account_id: 'tg_1',
        credentials: { sms: { from_number: '+5255000001' } },
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ch_nuevo',
        tenant_id: 't_alfa',
        channel: 'sms',
        provider_account_id: 'tg_1',
        credentials: { sms: { from_number: '+5255000002', api_key: 'k' } },
        status: 'active',
        created_at: '2026-10-01T00:00:00Z',
      },
    ]);

    expect(propias.sms?.from_number).toBe('+5255000002');
    expect(propias.sms?.api_key).toBe('k');
  });

  it('una credencial vacía no puede sombrear la de la plataforma', () => {
    const propias = mergeChannelCredentials([
      {
        id: 'ch_1',
        tenant_id: 't_alfa',
        channel: 'whatsapp',
        provider_account_id: '998877',
        credentials: { whatsapp: { token: '   ', phone_number_id: '998877' } },
        status: 'active',
        created_at: '2026-10-01T00:00:00Z',
      },
    ]);

    expect(propias.whatsapp?.token).toBeUndefined();
    expect(propias.whatsapp?.phone_number_id).toBe('998877');
  });
});
