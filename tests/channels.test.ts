import { describe, expect, it } from 'vitest';
import { parseResendPayload } from '../src/channels/resend';
import { parseTelnyxPayload } from '../src/channels/telnyx';
import {
  parseWhatsAppPayload,
  sendWhatsApp,
  verifyWhatsAppSignature,
} from '../src/channels/whatsapp';
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

  it('lee webhook de Telnyx WhatsApp y marca canal whatsapp', () => {
    const telnyxPayload = {
      data: {
        record_type: 'event',
        id: 'evt_wa_1',
        event_type: 'message.received',
        payload: {
          record_type: 'message',
          type: 'WHATSAPP',
          id: 'msg_wa_1',
          from: { phone_number: '+525511223344' },
          to: [{ phone_number: '+5215550001111', status: 'received' }],
          body: {
            type: 'text',
            text: { body: 'Mensaje recibido por Telnyx WhatsApp' },
          },
        },
      },
    };
    const parsed = parseWhatsAppPayload(telnyxPayload);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.channel).toBe('whatsapp');
    expect(parsed.messages[0]?.body).toBe('Mensaje recibido por Telnyx WhatsApp');
    expect(parsed.messages[0]?.from).toBe('+525511223344');
    expect(parsed.messages[0]?.to).toBe('+5215550001111');
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

  it('detecta payloads de tipo WHATSAPP y asigna channel whatsapp', () => {
    const parsed = parseTelnyxPayload({
      data: {
        event_type: 'message.received',
        payload: {
          type: 'WHATSAPP',
          id: 'wa_123',
          from: { phone_number: '+525599887766' },
          to: [{ phone_number: '+5215550009999' }],
          text: 'Hola desde Telnyx WA',
        },
      },
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.channel).toBe('whatsapp');
    expect(parsed.messages[0]?.from).toBe('+525599887766');
    expect(parsed.messages[0]?.body).toBe('Hola desde Telnyx WA');
  });

  it('procesa actualizaciones de estado de entrega de WhatsApp en Telnyx (delivered/read)', () => {
    const parsed = parseTelnyxPayload({
      data: {
        event_type: 'message.finalized',
        payload: {
          type: 'WHATSAPP',
          id: 'wa_msg_out',
          to: [{ phone_number: '+525512345678', status: 'read' }],
        },
      },
    });
    expect(parsed.statuses).toHaveLength(1);
    expect(parsed.statuses[0]?.channel).toBe('whatsapp');
    expect(parsed.statuses[0]?.status).toBe('read');
  });
});

describe('sendWhatsApp vía Telnyx', () => {
  it('falla fail-closed si faltan credenciales', async () => {
    const env = {} as unknown as Env;
    const res = await sendWhatsApp(env, {
      to: '+525512345678',
      body: 'hola',
      caseId: 'c1',
      clientId: 'cl1',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
  });

  it('respeta DRY_RUN sin invocar red', async () => {
    const env = {
      TELNYX_API_KEY: 'test_key',
      TELNYX_FROM_NUMBER: '+5215550001111',
      DRY_RUN: 'true',
    } as unknown as Env;
    const res = await sendWhatsApp(env, {
      to: '+525512345678',
      body: 'hola',
      caseId: 'c1',
      clientId: 'cl1',
    });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('whatsapp');
    expect(res.status).toBe('sent');
  });

  it('envía mensaje a través de Telnyx WhatsApp v2 API', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    let requestedHeaders: Record<string, string> = {};
    let requestedBody: {
      from?: string;
      to?: string;
      whatsapp_message?: { text?: { body?: string } };
    } = {};

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedHeaders = (init?.headers as Record<string, string>) ?? {};
      requestedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          data: {
            id: 'telnyx_wa_msg_999',
            record_type: 'message',
            type: 'WHATSAPP',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const env = {
        TELNYX_API_KEY: 'KEY_TELNYX_SECRET',
        TELNYX_WHATSAPP_FROM: '+5215559876543',
      } as unknown as Env;

      const res = await sendWhatsApp(env, {
        to: '+525511223344',
        body: 'Aviso de cobranza Arkangel',
        caseId: 'case_42',
        clientId: 'client_7',
      });

      expect(res.ok).toBe(true);
      expect(res.channel).toBe('whatsapp');
      expect(res.providerId).toBe('telnyx_wa_msg_999');
      expect(requestedUrl).toBe('https://api.telnyx.com/v2/messages/whatsapp');
      expect(requestedHeaders['Authorization']).toBe('Bearer KEY_TELNYX_SECRET');
      expect(requestedBody.from).toBe('+5215559876543');
      expect(requestedBody.to).toBe('+525511223344');
      expect(requestedBody.whatsapp_message?.text?.body).toBe('Aviso de cobranza Arkangel');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('valida firma Ed25519 de Telnyx en /webhooks/whatsapp', async () => {
    const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const rawPublicKey = (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer;
    const pubKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawPublicKey)));
    const timestamp = '1763000000';
    const rawPayload = JSON.stringify({
      data: {
        event_type: 'message.received',
        payload: {
          type: 'WHATSAPP',
          id: 'wa_webhook_1',
          from: { phone_number: '+525512345678' },
          to: [{ phone_number: '+5215559998888' }],
          text: 'hola desde telnyx',
        },
      },
    });
    const signedData = new TextEncoder().encode(`${timestamp}.${rawPayload}`);
    const signatureBytes = await crypto.subtle.sign('Ed25519', keyPair.privateKey, signedData);
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

    const envWithTelnyx = {
      TELNYX_WEBHOOK_PUBLIC_KEY: pubKeyBase64,
    } as unknown as Env;

    // Con firma Ed25519 válida -> 200 ok
    const resValid = await webhooks.request(
      '/whatsapp',
      {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': sigBase64,
          'telnyx-timestamp': timestamp,
        },
        body: rawPayload,
      },
      envWithTelnyx
    );
    expect(resValid.status).toBe(200);

    // Con firma Ed25519 alterada -> 401 invalid_signature
    const invalidSigBase64 = btoa('a'.repeat(64));
    const resInvalid = await webhooks.request(
      '/whatsapp',
      {
        method: 'POST',
        headers: {
          'telnyx-signature-ed25519': invalidSigBase64,
          'telnyx-timestamp': timestamp,
        },
        body: rawPayload,
      },
      envWithTelnyx
    );
    expect(resInvalid.status).toBe(401);
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
