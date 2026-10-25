import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  dialCall,
  answerCall,
  hangupCall,
  transferCall,
  speakCall,
  startRecording,
  generateWebRTCCredentials,
  isTelnyxVoiceEvent,
  parseTelnyxVoiceEvent,
  processTelnyxVoiceEvent,
} from '../src/channels/telnyxVoice';
import type { Env } from '../src/types/env';

function mockJsonResponse(data: unknown, status = 200): Response {
  const jsonStr = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => jsonStr,
    json: async () => data,
  } as unknown as Response;
}

describe('Telnyx Voice (Call Control v2 & WebRTC)', () => {
  const fakeEnv: Env = {
    ENVIRONMENT: 'test',
    TELNYX_API_KEY: 'KEY_TEST_TELNYX_123',
    TELNYX_FROM_NUMBER: '+525500000000',
    TELNYX_MESSAGING_PROFILE_ID: 'prof_123',
    TELNYX_CONNECTION_ID: 'conn_voice_123',
  } as unknown as Env;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isTelnyxVoiceEvent y parseTelnyxVoiceEvent', () => {
    it('reconoce eventos de voz de Telnyx Call Control', () => {
      const voicePayload = {
        data: {
          event_type: 'call.answered',
          payload: {
            call_control_id: 'v3:call_123',
            from: '+525511112222',
            to: '+525533334444',
            client_state: 'cas_test_999',
          },
        },
      };

      expect(isTelnyxVoiceEvent(voicePayload)).toBe(true);
      const parsed = parseTelnyxVoiceEvent(voicePayload);
      expect(parsed).not.toBeNull();
      expect(parsed?.eventType).toBe('call.answered');
      expect(parsed?.callControlId).toBe('v3:call_123');
      expect(parsed?.clientState).toBe('cas_test_999');
    });

    it('descarta payloads que no son de voz', () => {
      expect(isTelnyxVoiceEvent(null)).toBe(false);
      expect(isTelnyxVoiceEvent({ data: { event_type: 'message.received' } })).toBe(false);
      expect(parseTelnyxVoiceEvent({ data: { event_type: 'message.received' } })).toBeNull();
    });

    it('parsea evento de Answering Machine Detection (AMD)', () => {
      const amdPayload = {
        data: {
          event_type: 'call.machine.detection.ended',
          payload: {
            call_control_id: 'v3:call_amd_1',
            result: 'machine',
          },
        },
      };
      const parsed = parseTelnyxVoiceEvent(amdPayload);
      expect(parsed?.eventType).toBe('call.machine.detection.ended');
      expect(parsed?.amdResult).toBe('machine');
    });

    it('parsea evento de grabación guardada', () => {
      const recPayload = {
        data: {
          event_type: 'call.recording.saved',
          payload: {
            call_control_id: 'v3:call_rec_1',
            recording_urls: {
              mp3: 'https://storage.telnyx.com/recordings/call_1.mp3',
            },
            duration_millis: 18500,
          },
        },
      };
      const parsed = parseTelnyxVoiceEvent(recPayload);
      expect(parsed?.eventType).toBe('call.recording.saved');
      expect(parsed?.recordingUrl).toBe('https://storage.telnyx.com/recordings/call_1.mp3');
      expect(parsed?.durationSeconds).toBe(19);
    });
  });

  describe('Acciones de llamada HTTP (Call Control)', () => {
    it('dialCall ejecuta POST /v2/calls con AMD activado', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockJsonResponse({
          data: {
            call_control_id: 'v3:ctrl_abc',
            call_leg_id: 'leg_123',
            call_session_id: 'sess_123',
          },
        })
      );

      const result = await dialCall(fakeEnv, {
        to: '+525599998888',
        customHeaders: { 'X-Case-ID': 'cas_1' },
      });

      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(calledUrl).toBe('https://api.telnyx.com/v2/calls');
      expect(result.ok).toBe(true);
      expect(result.callControlId).toBe('v3:ctrl_abc');
    });

    it('hangupCall ejecuta POST /v2/calls/:id/actions/hangup', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await hangupCall(fakeEnv, 'v3:ctrl_abc');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/hangup');
      expect(result.ok).toBe(true);
    });

    it('answerCall ejecuta POST /v2/calls/:id/actions/answer', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await answerCall(fakeEnv, 'v3:ctrl_abc', 'state_1');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/answer');
      expect(result.ok).toBe(true);
    });

    it('startRecording ejecuta POST /v2/calls/:id/actions/record_start', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await startRecording(fakeEnv, 'v3:ctrl_abc');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/record_start');
      expect(result.ok).toBe(true);
    });

    it('transferCall ejecuta POST /v2/calls/:id/actions/transfer (Call Bridging AI -> Humano)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await transferCall(fakeEnv, 'v3:ctrl_abc', '+525544443333');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/transfer');
      expect(result.ok).toBe(true);
    });

    it('speakCall ejecuta POST /v2/calls/:id/actions/speak con voz en español', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await speakCall(fakeEnv, 'v3:ctrl_abc', {
        payload: 'Buenas tardes, le contactamos de Despacho Autorizado.',
      });
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/speak');
      expect(result.ok).toBe(true);
    });

    it('generateWebRTCCredentials emite credenciales SIP para el Softphone', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockJsonResponse({
          data: {
            sip_username: 'op_ana123',
            token: 'jwt_mock_token_abc',
          },
        })
      );

      const result = await generateWebRTCCredentials(fakeEnv, 'op_ana123');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.telnyx.com/v2/telephony_credentials');
      expect(result.ok).toBe(true);
      expect(result.sipUsername).toBe('op_ana123');
      expect(result.jwt).toBe('jwt_mock_token_abc');
    });
  });

  describe('processTelnyxVoiceEvent (Webhooks en vivo)', () => {
    it('al detectar contestador automático (machine) en AMD, cuelga la llamada de inmediato', async () => {
      const hangupSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const defaultTenantRow = {
        id: 't_default',
        slug: 'default',
        nombre: 'Tenant Default',
        status: 'active',
        is_default: 1,
        send_window_start: 8,
        send_window_end: 22,
        max_contacts_per_day: 3,
        rate_limit_rpm: 42,
        dedupe_window_hours: 24,
        tz: 'America/Mexico_City',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      };
      const stmt = {
        bind: () => stmt,
        run: async () => ({ success: true }),
        first: async () => defaultTenantRow,
        all: async () => ({ results: [defaultTenantRow] }),
      };
      const mockDb = {
        prepare: () => stmt,
      };

      const testEnv = {
        ...fakeEnv,
        DB: mockDb,
      } as unknown as Env;

      const event = {
        eventType: 'call.machine.detection.ended',
        callControlId: 'v3:amd_call',
        amdResult: 'machine' as const,
        clientState: JSON.stringify({ caseId: 'cas_1' }),
        raw: {},
      };

      const res = await processTelnyxVoiceEvent(testEnv, event);
      expect(res.ok).toBe(true);
      expect(res.actionTaken).toBe('machine_hangup');
      expect(hangupSpy).toHaveBeenCalled();
    });
  });
});
