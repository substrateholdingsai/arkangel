import { describe, expect, it, vi, beforeEach } from 'vitest';
import { validateRecordingPolicy, startRecordingGoverned } from '../src/channels/telnyxVoice';
import type { Env } from '../src/types/env';
import type { RecordingPolicy } from '../src/channels/telnyxVoice';

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

const fakeEnv: Env = {
  ENVIRONMENT: 'test',
  TELNYX_API_KEY: 'KEY_TEST_TELNYX_123',
  TELNYX_FROM_NUMBER: '+525500000000',
  TELNYX_MESSAGING_PROFILE_ID: 'prof_123',
  TELNYX_CONNECTION_ID: 'conn_voice_123',
} as unknown as Env;

const validPolicy: RecordingPolicy = {
  enabled: true,
  announcement: 'Esta llamada está siendo grabada para fines de calidad y cumplimiento legal.',
  retentionDays: 30,
  consentRequired: false,
  privacyNoticeUrl: 'https://arkangel.arksystems.site/aviso-privacidad',
};

describe('Gobernanza LFPDPPP de grabación de audio', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateRecordingPolicy', () => {
    it('acepta una política completa y habilitada', () => {
      const res = validateRecordingPolicy(validPolicy);
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('bloquea si la grabación está deshabilitada', () => {
      const res = validateRecordingPolicy({ ...validPolicy, enabled: false });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('recording_disabled');
    });

    it('bloquea si falta la locución de aviso', () => {
      const res = validateRecordingPolicy({ ...validPolicy, announcement: '' });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing_announcement');
    });

    it('bloquea si la retención es 0 o inválida', () => {
      const res = validateRecordingPolicy({ ...validPolicy, retentionDays: 0 });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('invalid_retention_days');
    });

    it('bloquea si falta la URL del aviso de privacidad', () => {
      const res = validateRecordingPolicy({ ...validPolicy, privacyNoticeUrl: '' });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing_privacy_notice_url');
    });

    it('bloquea si requiere consentimiento y no se otorgó', () => {
      const res = validateRecordingPolicy({
        ...validPolicy,
        consentRequired: true,
        consentGranted: false,
      });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('consent_not_granted');
    });

    it('acepta consentimiento otorgado cuando es requerido', () => {
      const res = validateRecordingPolicy({
        ...validPolicy,
        consentRequired: true,
        consentGranted: true,
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('startRecordingGoverned', () => {
    it('no llama a Telnyx si la política es inválida', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await startRecordingGoverned(fakeEnv, 'v3:ctrl_abc', {
        ...validPolicy,
        enabled: false,
      });

      expect(result.ok).toBe(false);
      expect(result.policyErrors).toContain('recording_disabled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('llama a Telnyx si la política es válida', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));

      const result = await startRecordingGoverned(fakeEnv, 'v3:ctrl_abc', validPolicy);

      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0]![0]).toContain('/actions/record_start');
      expect(result.ok).toBe(true);
    });
  });
});
