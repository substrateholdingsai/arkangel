import { describe, expect, it } from 'vitest';
import { IdempotencyKey, reserveOnce, reserveOnceConLegado } from '../src/lib/idempotencia';
import { resolveChannels } from '../src/channels';
import type { Client } from '../src/types/cobranza';

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

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'cli_1',
    name: 'Juan Perez',
    phone: '+525512345678',
    email: 'juan@example.com',
    curp: null,
    whatsapp_opt_in: 1,
    sms_opt_in: 1,
    email_opt_in: 0,
    do_not_disturb: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('reserveOnce', () => {
  it('permite una sola vez por ventana', async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    const key = IdempotencyKey.forCase('cas_1', 'whatsapp');

    expect(await reserveOnce(kv, key, 3600)).toBe(true);
    expect(await reserveOnce(kv, key, 3600)).toBe(false);
  });

  it('usa llaves distintas por canal', () => {
    expect(IdempotencyKey.forCase('cas_1', 'whatsapp')).not.toBe(
      IdempotencyKey.forCase('cas_1', 'sms')
    );
  });
});

describe('reserveOnceConLegado', () => {
  it('una reserva legacy viva bloquea la nueva: no se reinicia la ventana', async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    const nuevo = IdempotencyKey.forTenantCase('t_a', 'cas_1', 'whatsapp');
    const legacy = IdempotencyKey.forCase('cas_1', 'whatsapp');

    // Reserva hecha antes del despliegue con el namespace viejo.
    await kv.put(legacy, '{"at":1}');

    expect(await reserveOnceConLegado(kv, nuevo, legacy, 3600)).toBe(false);
    expect(await kv.get(nuevo)).toBeNull();
  });

  it('sin reserva legacy reserva la nueva', async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    const nuevo = IdempotencyKey.forTenantCase('t_a', 'cas_1', 'whatsapp');
    const legacy = IdempotencyKey.forCase('cas_1', 'whatsapp');

    expect(await reserveOnceConLegado(kv, nuevo, legacy, 3600)).toBe(true);
    expect(await kv.get(nuevo)).not.toBeNull();
  });
});

describe('resolveChannels', () => {
  it('exige opt-in explícito para email', () => {
    const channels = resolveChannels(client({ email_opt_in: 0 }), 'alto');
    expect(channels).not.toContain('email');
  });

  it('incluye email con opt-in', () => {
    const channels = resolveChannels(client({ email_opt_in: 1 }), 'alto');
    expect(channels).toContain('email');
  });

  it('respeta el no-contacto de WhatsApp', () => {
    const channels = resolveChannels(client({ whatsapp_opt_in: 0 }), 'alto');
    expect(channels).not.toContain('whatsapp');
    expect(channels).toContain('sms');
  });

  it('prioriza por banda de riesgo', () => {
    expect(resolveChannels(client({ email_opt_in: 1 }), 'alto')[0]).toBe('whatsapp');
    expect(resolveChannels(client({ email_opt_in: 1 }), 'bajo')[0]).toBe('email');
  });
});
