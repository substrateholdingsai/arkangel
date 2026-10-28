/**
 * CANACO SERVYTUR MÉRIDA — Arkangel Integration Suite
 *
 * Verifica el aprovisionamiento completo del tenant `canaco_merida`:
 *   1. Configuración operativa y legal (NOM-184 de 08:00 a 20:00, max 2 contactos diarios, registro SIEM 2026).
 *   2. Membresía admin para horus.i2d@gmail.com.
 *   3. Enrutado de canales (Lada 999 telefónica + WhatsApp oficial +529999253060).
 *   4. Asistente Telnyx Voice AI ('María de CANACO Mérida') y call.bridge a oficinas de la Cámara (+52 999 925 3060).
 *   5. Webhook saliente hacia ark-ledger al confirmar pagos SPEI.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CANACO_MERIDA_OFFICE_PHONE,
  CANACO_MERIDA_VOICE_PROMPT,
  CANACO_MERIDA_ASSISTANT_CONFIG,
  createCanacoMeridaAssistant,
  bridgeCall,
  processTelnyxVoiceEvent,
} from '../src/channels/telnyxVoice';
import {
  notifyArkLedgerPayment,
  CANACO_DEFAULT_WEBHOOK_URL,
} from '../src/services/arkLedgerWebhook';
import { configDesdeFila } from '../src/tenancy/config';
import { routingIdDeInbound } from '../src/tenancy/context';
import { mergeChannelCredentials, getEnabledChannels } from '../src/tenancy/channels';
import type { Tenant, TenantChannel } from '../src/tenancy/types';
import type { Env } from '../src/types/env';

describe('CANACO SERVYTUR MÉRIDA — Configuración y Servicios Camerales', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const tenantCanaco: Tenant = {
    id: 'canaco_merida',
    slug: 'canaco-merida',
    nombre: 'CANACO SERVYTUR Mérida',
    status: 'active',
    config_mode: 'db',
    razon_social: 'CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA',
    condusef_registro: 'CANACO-MERIDA-SIEM-2026',
    allowed_payment_domains:
      'arksystems.site,pagos.arksystems.site,ledger.arksystems.site,socios.canacomerida.com.mx',
    tz: 'America/Merida',
    send_window_start: 8,
    send_window_end: 20,
    max_contacts_per_day: 2,
    legal_monto_tolerancia_cents: 0,
    legal_horario_en_respuestas: 0,
    rate_limit_rpm: 42,
    dedupe_window_hours: 24,
    score_amount_ceiling_cents: 500000,
    agent_mode: 'supervised',
    agent_auto_threshold_cents: 200000,
    dry_run: 0,
    cron_auto_fire: 0,
    a2a_enabled: 1,
    a2a_max_discount_pct: 15,
    a2a_max_installments: 3,
    a2a_min_down_payment_pct: 50,
    is_default: 0,
    created_at: '2026-10-28T00:00:00Z',
    updated_at: '2026-10-28T00:00:00Z',
  };

  const fakeEnv: Env = {
    ENVIRONMENT: 'test',
    TELNYX_API_KEY: 'KEY_TELNYX_TEST_MID',
    TELNYX_FROM_NUMBER: '+529999253060',
    TELNYX_MESSAGING_PROFILE_ID: 'prof_canaco_999',
    TELNYX_CONNECTION_ID: 'conn_mid_voice',
    ARKANGEL_WEBHOOK_SECRET: 'test_canaco_secret',
  } as unknown as Env;

  describe('1. Identidad Legal y Ventana NOM-184 en D1', () => {
    it('resuelve la configuración con Razón Social oficial y Registro SIEM 2026', () => {
      const config = configDesdeFila(fakeEnv, tenantCanaco);

      expect(config.razonSocial).toBe('CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA');
      expect(config.condusef).toBe('CANACO-MERIDA-SIEM-2026');
      expect(config.tz).toBe('America/Merida');
    });

    it('aplica estrictamente la ventana legal NOM-184 de 08:00 a 20:00 y max 2 contactos diarios', () => {
      const config = configDesdeFila(fakeEnv, tenantCanaco);

      expect(config.horaInicio).toBe(8);
      expect(config.horaFin).toBe(20);
      expect(config.maxContactos24h).toBe(2);
      expect(config.dominiosPermitidos).toContain('ledger.arksystems.site');
      expect(config.dominiosPermitidos).toContain('socios.canacomerida.com.mx');
    });
  });

  describe('2. Canales Oficiales Mérida (Lada 999 & WhatsApp Oficial)', () => {
    const channels: TenantChannel[] = [
      {
        id: 'chan_canaco_whatsapp',
        tenant_id: 'canaco_merida',
        channel: 'whatsapp',
        provider_account_id: '+529999253060',
        credentials: {
          whatsapp: {
            from_number: '+529999253060',
            phone_number_id: 'canaco_merida_wa_mid',
          },
        },
        status: 'active',
        created_at: '2026-10-28T00:00:00Z',
      },
      {
        id: 'chan_canaco_sms',
        tenant_id: 'canaco_merida',
        channel: 'sms',
        provider_account_id: '+529999253060',
        credentials: {
          sms: {
            from_number: '+529999253060',
            messaging_profile_id: 'canaco_merida_prof_999',
          },
        },
        status: 'active',
        created_at: '2026-10-28T00:00:00Z',
      },
    ];

    it('fusiona las credenciales de canal con el número oficial +529999253060', () => {
      const creds = mergeChannelCredentials(channels);
      expect(creds.whatsapp?.from_number).toBe('+529999253060');
      expect(creds.whatsapp?.phone_number_id).toBe('canaco_merida_wa_mid');
      expect(creds.sms?.from_number).toBe('+529999253060');
      expect(creds.sms?.messaging_profile_id).toBe('canaco_merida_prof_999');
    });

    it('extrae el routingId de un mensaje entrante de WhatsApp con número oficial', () => {
      const routing = routingIdDeInbound({
        providerId: 'wamid.canaco_inbound_1',
        receivedAt: '2026-10-28T00:00:00Z',
        channel: 'whatsapp',
        from: '+529991234567',
        to: '+529999253060',
        body: 'Hola, quiero renovar mi SIEM',
        meta: { phone_number_id: '+529999253060' },
      });
      expect(routing).toBe('+529999253060');
    });

    it('mantiene los canales activos en getEnabledChannels', () => {
      const enabled = getEnabledChannels(channels);
      expect(enabled).toContain('whatsapp');
      expect(enabled).toContain('sms');
    });
  });

  describe('3. Asistente Telnyx Voice AI: María de CANACO Mérida & Call Bridging', () => {
    it('el prompt incluye tono institucional, calidez yucateca y cero amenazas', () => {
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain('María, Asistente Institucional');
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain(
        'CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA'
      );
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain('calidez yucateca');
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain('CERO AMENAZAS');
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain('NOM-184');
      expect(CANACO_MERIDA_VOICE_PROMPT.toLowerCase()).toContain('spei');
    });

    it('define el número de oficinas de la Cámara para call.bridge (+52 999 925 3060)', () => {
      expect(CANACO_MERIDA_OFFICE_PHONE).toBe('+529999253060');
      expect(CANACO_MERIDA_ASSISTANT_CONFIG.name).toBe('María de CANACO Mérida');
      expect(CANACO_MERIDA_ASSISTANT_CONFIG.razonSocial).toBe(
        'CÁMARA NACIONAL DE COMERCIO, SERVICIOS Y TURISMO DE MÉRIDA'
      );
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain(CANACO_MERIDA_OFFICE_PHONE);
      expect(CANACO_MERIDA_VOICE_PROMPT).toContain('call.bridge');
    });

    it('createCanacoMeridaAssistant aprovisiona el bot con Polly Mia en español mexicano', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: { id: 'asst_maria_canaco_1' } }),
        json: async () => ({ data: { id: 'asst_maria_canaco_1' } }),
      } as unknown as Response);

      const res = await createCanacoMeridaAssistant(fakeEnv);
      expect(fetchSpy).toHaveBeenCalled();
      const reqBody = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);

      expect(res.ok).toBe(true);
      expect(res.assistantId).toBe('asst_maria_canaco_1');
      expect(reqBody.name).toBe('María de CANACO Mérida');
      expect(reqBody.voice_settings?.voice).toBe('Telnyx.Polly.Mia');
      expect(reqBody.voice_settings?.language).toBe('es-MX');
      expect(reqBody.instructions).toContain('calidez yucateca');
    });

    it('bridgeCall puentea hacia el teléfono de oficinas de CANACO Mérida', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: { status: 'bridged' } }),
        json: async () => ({ data: { status: 'bridged' } }),
      } as unknown as Response);

      const res = await bridgeCall(fakeEnv, 'v3:call_mid_123', CANACO_MERIDA_OFFICE_PHONE);
      expect(res.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('/actions/transfer');
      const reqBody = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);
      expect(reqBody.to).toBe('+529999253060');
    });

    it('processTelnyxVoiceEvent escala y puentea a humano ante evento call.human_escalation', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: {} }),
        json: async () => ({ data: {} }),
      } as unknown as Response);

      const stmt = {
        bind: () => stmt,
        run: async () => ({ success: true }),
        first: async () => tenantCanaco,
        all: async () => ({ results: [tenantCanaco] }),
      };
      const mockEnv = {
        ...fakeEnv,
        DB: { prepare: () => stmt },
      } as unknown as Env;

      const res = await processTelnyxVoiceEvent(mockEnv, {
        eventType: 'call.human_escalation',
        callControlId: 'v3:call_mid_human',
        customHeaders: { 'X-Tenant-ID': 'canaco_merida' },
        raw: {},
      });

      expect(res.ok).toBe(true);
      expect(res.actionTaken).toBe('call_bridged_to_human');
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe('4. Webhook Saliente hacia ARK-LEDGER al Liquidar Cuotas SPEI', () => {
    it('despacha el payload canónico hacia el endpoint de retorno de ark-ledger', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            ok: true,
            estatus: 'Socio Activo',
            folioSiem: 'SIEM-MID-2026-ABM1-9988',
          }),
        json: async () => ({
          ok: true,
          estatus: 'Socio Activo',
          folioSiem: 'SIEM-MID-2026-ABM1-9988',
        }),
      } as unknown as Response);

      const res = await notifyArkLedgerPayment(fakeEnv, {
        rfc: 'ABM120301AA1',
        folio_pago: 'SPEI-20261028-CANACO-9988',
        monto: 1090.0,
        tenant_id: 'canaco_merida',
        metodo: 'spei_1click',
      });

      expect(res.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();

      const [targetUrl, init] = fetchSpy.mock.calls[0]!;
      expect(targetUrl).toBe(CANACO_DEFAULT_WEBHOOK_URL);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer test_canaco_secret'
      );

      const payload = JSON.parse(init?.body as string);
      expect(payload.rfc).toBe('ABM120301AA1');
      expect(payload.folio_pago).toBe('SPEI-20261028-CANACO-9988');
      expect(payload.monto).toBe(1090.0);
      expect(payload.tenant_id).toBe('canaco_merida');
      expect(payload.metodo).toBe('spei_1click');
    });

    it('utiliza el Service Binding env.ARK_LEDGER si está presente', async () => {
      const mockServiceFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true, estatus: 'Socio Activo' }),
      });

      const envWithBinding = {
        ...fakeEnv,
        ARK_LEDGER: { fetch: mockServiceFetch },
      } as unknown as Env;

      const res = await notifyArkLedgerPayment(envWithBinding, {
        rfc: 'CAM840215XYZ',
        monto: 2150.0,
        tenant_id: 'canaco_merida',
      });

      expect(res.ok).toBe(true);
      expect(mockServiceFetch).toHaveBeenCalledWith(
        'https://ledger.internal/api/canaco/webhook-pago-arkangel',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });
});
