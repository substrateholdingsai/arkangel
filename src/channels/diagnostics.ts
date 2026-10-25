import type { Env } from '../types/env';
import { isDryRun } from './types';
import { logger } from '../lib/logger';

export interface TestChannelInput {
  channel: 'whatsapp' | 'sms' | 'email';
  provider_account_id?: string;
  template_name?: string;
  from_number?: string;
  from_address?: string;
}

export interface TestChannelResult {
  ok: boolean;
  channel: 'whatsapp' | 'sms' | 'email';
  latency_ms: number;
  provider: string;
  status: 'connected' | 'error';
  details?: string;
  error?: string;
}

export async function testChannelConnectivity(
  env: Env,
  input: TestChannelInput
): Promise<TestChannelResult> {
  const channel = input.channel;

  if (channel === 'whatsapp') {
    const apiKey = env.TELNYX_API_KEY ?? env.WHATSAPP_TOKEN;
    const fromNumber =
      input.provider_account_id?.trim() ||
      input.from_number?.trim() ||
      env.TELNYX_WHATSAPP_FROM ||
      env.TELNYX_FROM_NUMBER ||
      env.WHATSAPP_PHONE_NUMBER_ID;

    if (!apiKey) {
      return {
        ok: false,
        channel: 'whatsapp',
        latency_ms: 0,
        provider: 'telnyx',
        status: 'error',
        error: 'Falta TELNYX_API_KEY en la configuración de entorno del Worker.',
      };
    }

    const isMeta = apiKey.startsWith('EAA');
    const isValidSender = !fromNumber
      ? true
      : isMeta
        ? /^\d{10,20}$/.test(fromNumber) || /^\+[1-9]\d{7,14}$/.test(fromNumber)
        : /^\+[1-9]\d{7,14}$/.test(fromNumber);

    if (fromNumber && !isValidSender) {
      return {
        ok: false,
        channel: 'whatsapp',
        latency_ms: 0,
        provider: isMeta ? 'meta' : 'telnyx',
        status: 'error',
        error: isMeta
          ? 'El remitente de Meta debe ser un Phone Number ID (15 dígitos) o número E.164 (+52...).'
          : 'El número remitente de WhatsApp (Telnyx) debe estar en formato internacional E.164 (ej. +525512345678).',
      };
    }

    if (isDryRun(env)) {
      return {
        ok: true,
        channel: 'whatsapp',
        latency_ms: 4,
        provider: 'telnyx',
        status: 'connected',
        details: 'Modo Dry-Run activo: credenciales y formato E.164 validados.',
      };
    }

    const t0 = Date.now();
    try {
      const isMeta = apiKey.startsWith('EAA');
      const url = isMeta
        ? `https://graph.facebook.com/v20.0/${fromNumber || 'me'}`
        : 'https://api.telnyx.com/v2/phone_numbers';

      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });

      const latency = Date.now() - t0;
      if (response.ok) {
        return {
          ok: true,
          channel: 'whatsapp',
          latency_ms: latency,
          provider: isMeta ? 'meta' : 'telnyx',
          status: 'connected',
          details: `Conectividad exitosa con ${isMeta ? 'Meta Graph' : 'Telnyx WhatsApp v2'} (${latency}ms).`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          channel: 'whatsapp',
          latency_ms: latency,
          provider: isMeta ? 'meta' : 'telnyx',
          status: 'error',
          error: 'Credenciales rechazadas por el proveedor (HTTP 401: API key o token inválido).',
        };
      }

      return {
        ok: false,
        channel: 'whatsapp',
        latency_ms: latency,
        provider: isMeta ? 'meta' : 'telnyx',
        status: 'error',
        error: `Proveedor devolvió HTTP ${response.status}.`,
      };
    } catch (err) {
      logger.error('Error probando conectividad de WhatsApp', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        channel: 'whatsapp',
        latency_ms: Date.now() - t0,
        provider: 'telnyx',
        status: 'error',
        error: `Fallo de red contactando al proveedor: ${err instanceof Error ? err.message : 'timeout'}`,
      };
    }
  }

  if (channel === 'sms') {
    const apiKey = env.TELNYX_API_KEY;
    const messagingProfileId = input.provider_account_id?.trim() || env.TELNYX_MESSAGING_PROFILE_ID;

    if (!apiKey) {
      return {
        ok: false,
        channel: 'sms',
        latency_ms: 0,
        provider: 'telnyx',
        status: 'error',
        error: 'Falta TELNYX_API_KEY en la configuración del Worker.',
      };
    }

    if (isDryRun(env)) {
      return {
        ok: true,
        channel: 'sms',
        latency_ms: 4,
        provider: 'telnyx',
        status: 'connected',
        details: 'Modo Dry-Run activo: credenciales y perfiles SMS validados.',
      };
    }

    const t0 = Date.now();
    try {
      const url = messagingProfileId
        ? `https://api.telnyx.com/v2/messaging_profiles/${messagingProfileId}`
        : 'https://api.telnyx.com/v2/messaging_profiles';

      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });

      const latency = Date.now() - t0;
      if (response.ok) {
        return {
          ok: true,
          channel: 'sms',
          latency_ms: latency,
          provider: 'telnyx',
          status: 'connected',
          details: `Conexión exitosa a Telnyx SMS API (${latency}ms). Perfil de mensajería activo.`,
        };
      }

      if (response.status === 404) {
        return {
          ok: false,
          channel: 'sms',
          latency_ms: latency,
          provider: 'telnyx',
          status: 'error',
          error: 'Messaging Profile ID no encontrado en tu cuenta de Telnyx (HTTP 404).',
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          channel: 'sms',
          latency_ms: latency,
          provider: 'telnyx',
          status: 'error',
          error: 'Telnyx rechazó la API Key (HTTP 401: no autorizada).',
        };
      }

      return {
        ok: false,
        channel: 'sms',
        latency_ms: latency,
        provider: 'telnyx',
        status: 'error',
        error: `Telnyx devolvió HTTP ${response.status}.`,
      };
    } catch (err) {
      logger.error('Error probando conectividad SMS', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        channel: 'sms',
        latency_ms: Date.now() - t0,
        provider: 'telnyx',
        status: 'error',
        error: `Fallo de red contactando Telnyx: ${err instanceof Error ? err.message : 'timeout'}`,
      };
    }
  }

  // email
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromEmail =
    input.from_address?.trim() || input.provider_account_id?.trim() || env.RESEND_FROM_EMAIL;

  if (!apiKey) {
    return {
      ok: false,
      channel: 'email',
      latency_ms: 0,
      provider: 'resend',
      status: 'error',
      error: 'Falta RESEND_API_KEY en la configuración del Worker.',
    };
  }

  if (fromEmail && !fromEmail.includes('@') && !fromEmail.includes('.')) {
    return {
      ok: false,
      channel: 'email',
      latency_ms: 0,
      provider: 'resend',
      status: 'error',
      error: 'El remitente debe ser un correo o dominio válido (ej. avisos@despacho.mx).',
    };
  }

  if (isDryRun(env)) {
    return {
      ok: true,
      channel: 'email',
      latency_ms: 4,
      provider: 'resend',
      status: 'connected',
      details: 'Modo Dry-Run activo: credenciales y dominio de correo validados.',
    };
  }

  const t0 = Date.now();
  try {
    const url = 'https://api.resend.com/domains';
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });

    const latency = Date.now() - t0;
    if (response.ok) {
      return {
        ok: true,
        channel: 'email',
        latency_ms: latency,
        provider: 'resend',
        status: 'connected',
        details: `Conexión exitosa a Resend Email API (${latency}ms). Credenciales autorizadas.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        channel: 'email',
        latency_ms: latency,
        provider: 'resend',
        status: 'error',
        error: 'Resend rechazó la API Key (HTTP 401: no autorizada).',
      };
    }

    return {
      ok: false,
      channel: 'email',
      latency_ms: latency,
      provider: 'resend',
      status: 'error',
      error: `Resend devolvió HTTP ${response.status}.`,
    };
  } catch (err) {
    logger.error('Error probando conectividad de correo', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      channel: 'email',
      latency_ms: Date.now() - t0,
      provider: 'resend',
      status: 'error',
      error: `Fallo de red contactando Resend: ${err instanceof Error ? err.message : 'timeout'}`,
    };
  }
}
