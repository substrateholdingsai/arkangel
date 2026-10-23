import { describe, expect, it } from 'vitest';
import { parseResendPayload } from '../src/channels/resend';
import { parseTelnyxPayload } from '../src/channels/telnyx';
import { parseWhatsAppPayload, verifyWhatsAppSignature } from '../src/channels/whatsapp';
import { isDryRun } from '../src/channels/types';
import { webhooks } from '../src/routes/webhooks';
import type { Env } from '../src/types/env';

describe('parseWhatsAppPayload', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PID' },
              contacts: [{ profile: { name: 'Juan Perez' }, wa_id: '525512345678' }],
              messages: [
                {
                  from: '525512345678',
                  id: 'wamid.1',
                  timestamp: '1763000000',
                  type: 'text',
                  text: { body: 'ya pagué' },
                },
              ],
              statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '525512345678' }],
            },
          },
        ],
      },
    ],
  };

  it('extrae mensajes entrantes', () => {
    const parsed = parseWhatsAppPayload(payload);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.body).toBe('ya pagué');
    expect(parsed.messages[0]?.from).toBe('525512345678');
    expect(parsed.messages[0]?.contactName).toBe('Juan Perez');
  });

  it('extrae estados de entrega', () => {
    const parsed = parseWhatsAppPayload(payload);
    expect(parsed.statuses).toHaveLength(1);
    expect(parsed.statuses[0]?.status).toBe('delivered');
  });

  it('no truena con payloads vacíos', () => {
    expect(parseWhatsAppPayload({}).messages).toEqual([]);
    expect(parseWhatsAppPayload(null).statuses).toEqual([]);
  });

  it('verifica la firma HMAC-SHA256 de Meta (X-Hub-Signature-256) y rechaza firmas inválidas en POST /webhooks/whatsapp', async () => {
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const appSecret = 'meta_secret_key_test_123';

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const hex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const validHeader = `sha256=${hex}`;

    expect(await verifyWhatsAppSignature(appSecret, rawBody, validHeader)).toBe(true);
    expect(await verifyWhatsAppSignature(appSecret, rawBody, `sha256=${'0'.repeat(64)}`)).toBe(
      false
    );
    expect(await verifyWhatsAppSignature(appSecret, rawBody, null)).toBe(false);

    const envWithSecret = { WHATSAPP_APP_SECRET: appSecret } as unknown as Env;

    // Sin cabecera -> 401 missing_signature
    const resMissing = await webhooks.request(
      '/whatsapp',
      { method: 'POST', body: rawBody },
      envWithSecret
    );
    expect(resMissing.status).toBe(401);

    // Con firma alterada -> 401 invalid_signature
    const resInvalid = await webhooks.request(
      '/whatsapp',
      {
        method: 'POST',
        headers: { 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` },
        body: rawBody,
      },
      envWithSecret
    );
    expect(resInvalid.status).toBe(401);

    // Con firma válida -> 200 ok
    const resValid = await webhooks.request(
      '/whatsapp',
      {
        method: 'POST',
        headers: { 'x-hub-signature-256': validHeader },
        body: rawBody,
      },
      envWithSecret
    );
    expect(resValid.status).toBe(200);
  });
});

describe('parseTelnyxPayload', () => {
  it('lee el webhook v2 de message.received', () => {
    const parsed = parseTelnyxPayload({
      data: {
        event_type: 'message.received',
        id: 'msg_1',
        payload: { from: '+525512345678', to: '+5215550001111', text: 'lo pago el lunes' },
      },
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.body).toBe('lo pago el lunes');
    expect(parsed.messages[0]?.channel).toBe('sms');
  });

  it('lee el webhook plano', () => {
    const parsed = parseTelnyxPayload({ from: '+525512345678', text: 'hola' });
    expect(parsed.messages).toHaveLength(1);
  });

  it('lee estados', () => {
    const parsed = parseTelnyxPayload({
      data: { event_type: 'message.updated', payload: { id: 'msg_1', status: 'delivered' } },
    });
    expect(parsed.statuses[0]?.status).toBe('delivered');
  });

  it('expone el `messaging_profile_id` para resolver el tenant', () => {
    const parsed = parseTelnyxPayload({
      data: {
        event_type: 'message.received',
        id: 'msg_1',
        payload: {
          from: '+525512345678',
          to: '+5215550001111',
          text: 'lo pago el lunes',
          messaging_profile_id: 'tg_1',
        },
      },
    });

    expect(parsed.messages[0]?.meta?.messaging_profile_id).toBe('tg_1');
  });
});

describe('parseResendPayload', () => {
  it('lee el inbound de email', () => {
    const parsed = parseResendPayload({
      from: 'cliente@example.com',
      to: 'cobranza@arksystems.site',
      subject: 'Re: Recordatorio',
      text: 'ya hice el pago',
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.body).toBe('ya hice el pago');
    expect(parsed.messages[0]?.channel).toBe('email');
  });

  it('ignora payloads sin cuerpo', () => {
    expect(parseResendPayload({ from: 'a@b.com' }).messages).toEqual([]);
  });
});

describe('freno de ensayo (DRY_RUN)', () => {
  function env(dryRun?: string): Env {
    return { DRY_RUN: dryRun } as unknown as Env;
  }

  it('el freno global manda: ningún tenant puede desactivarlo', () => {
    expect(isDryRun(env('true'), false)).toBe(true);
  });

  it('el flag del tenant sólo puede activarlo', () => {
    expect(isDryRun(env('false'), true)).toBe(true);
    expect(isDryRun(env('false'), false)).toBe(false);
  });
});
