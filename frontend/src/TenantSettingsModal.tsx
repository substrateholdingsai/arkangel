import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  PhoneCall,
  Save,
  Scale,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import { Alert, Button } from '@ds';
import {
  api,
  type MembershipRole,
  type TenantChannelConfig,
  type TenantMember,
  type TenantSettings,
  type TenantWebhooks,
  type TestChannelResult,
} from './api';

interface TenantSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function TenantSettingsModal({ open, onClose, onSaved }: TenantSettingsModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const [form, setForm] = useState<TenantSettings>({
    tenant_id: '',
    slug: '',
    nombre: '',
    config_mode: 'db',
    razon_social: '',
    condusef_registro: '',
    allowed_payment_domains: '',
    tz: 'America/Mexico_City',
    send_window_start: 8,
    send_window_end: 22,
    max_contacts_per_day: 3,
    rate_limit_rpm: 42,
    agent_mode: 'supervised',
    agent_auto_threshold_cents: 200000,
    dry_run: false,
  });

  const [webhooks, setWebhooks] = useState<TenantWebhooks | null>(null);
  const [channels, setChannels] = useState<TenantChannelConfig[]>([
    {
      channel: 'whatsapp',
      status: 'active',
      provider_account_id: '',
      template_name: '',
      from_number: '',
      from_address: '',
    },
    {
      channel: 'sms',
      status: 'active',
      provider_account_id: '',
      template_name: '',
      from_number: '',
      from_address: '',
    },
    {
      channel: 'email',
      status: 'active',
      provider_account_id: '',
      template_name: '',
      from_number: '',
      from_address: '',
    },
  ]);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestChannelResult>>({});
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<MembershipRole>('admin');
  const [inviting, setInviting] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [syncingAssistant, setSyncingAssistant] = useState(false);
  const [syncAssistantResult, setSyncAssistantResult] = useState<{
    ok: boolean;
    assistantId?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setLastInviteUrl(null);
    void (async () => {
      try {
        const [res, membersRes, channelsRes] = await Promise.all([
          api.getTenantSettings(),
          api.listTenantMembers().catch(() => ({ ok: true, members: [] })),
          api.getTenantChannels().catch(() => null),
        ]);
        setForm(res.settings);
        setWebhooks(res.webhooks);
        setMembers(membersRes.members);
        if (channelsRes?.channels?.length) {
          setChannels(channelsRes.channels);
        }
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'No se pudo cargar la configuración del despacho'
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  const aplicarPresetDemo = () => {
    setForm((prev) => ({
      ...prev,
      razon_social: prev.razon_social || 'Arkangel Cobranza Legal S.A.P.I. de C.V.',
      condusef_registro: prev.condusef_registro || 'REDECO-2026-0042',
      allowed_payment_domains:
        prev.allowed_payment_domains || 'arksystems.site, pagos.arksystems.site',
      send_window_start: 8,
      send_window_end: 22,
      max_contacts_per_day: 3,
      rate_limit_rpm: 42,
    }));
    setNotice('Preset sintético cargado. Haz clic en "Guardar y Aplicar" para persistirlo en D1.');
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const [res, chRes] = await Promise.all([
        api.updateTenantSettings(form),
        api.updateTenantChannels(channels),
      ]);
      setForm(res.settings);
      setChannels(chRes.channels);
      setNotice(
        `Configuración y canales activos (${chRes.enabled_channels.join(', ').toUpperCase()}) guardados en D1.`
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar configuración');
    } finally {
      setSaving(false);
    }
  };

  const updateChannelField = (
    channelName: 'whatsapp' | 'sms' | 'email',
    patch: Partial<TenantChannelConfig>
  ) => {
    setChannels((prev) =>
      prev.map((ch) => (ch.channel === channelName ? { ...ch, ...patch } : ch))
    );
  };

  const handleTestChannel = async (ch: TenantChannelConfig) => {
    setTestingChannel(ch.channel);
    try {
      const res = await api.testChannel({
        channel: ch.channel,
        provider_account_id: ch.provider_account_id,
        template_name: ch.template_name,
        from_number: ch.from_number,
        from_address: ch.from_address,
      });
      setTestResults((prev) => ({ ...prev, [ch.channel]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [ch.channel]: {
          ok: false,
          channel: ch.channel,
          latency_ms: 0,
          provider: 'unknown',
          status: 'error',
          error: err instanceof Error ? err.message : 'Error al conectar con el servidor',
        },
      }));
    } finally {
      setTestingChannel(null);
    }
  };

  const handleSyncAssistant = async () => {
    setSyncingAssistant(true);
    setSyncAssistantResult(null);
    setError(null);
    setNotice(null);
    try {
      const res = await api.syncTelnyxAssistant({
        name: `${form.razon_social || 'Despacho'} - Asistente de Cobranza`,
      });
      setSyncAssistantResult(res);
      if (res.ok) {
        setNotice(
          `Asistente de Voz Telnyx sincronizado exitosamente (ID: ${res.assistantId || 'registrado'}).`
        );
      } else {
        setError(res.error || 'Error al sincronizar el asistente en Telnyx');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error inesperado al contactar Telnyx Voice API';
      setSyncAssistantResult({ ok: false, error: msg });
      setError(msg);
    } finally {
      setSyncingAssistant(false);
    }
  };

  const copiarUrl = async (key: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(key);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      /* ignore */
    }
  };

  const invitarMiembro = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    setLastInviteUrl(null);
    try {
      const res = await api.inviteTenantMember({
        email: inviteEmail.trim(),
        full_name: inviteName.trim(),
        role: inviteRole,
      });
      setMembers(res.members);
      setLastInviteUrl(res.invite_url);
      setInviteEmail('');
      setInviteName('');
      setNotice(
        res.email_sent
          ? `Invitación enviada por correo a ${res.invited.email} (${res.invited.role}).`
          : `Miembro ${res.invited.email} dado de alta (${res.invited.role}). Copia el enlace de activación debajo.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo invitar al miembro.');
    } finally {
      setInviting(false);
    }
  };

  const revocarMiembro = async (userId: string, email: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.removeTenantMember(userId);
      setMembers(res.members);
      setNotice(`Acceso de ${email} revocado del despacho.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo revocar al miembro.');
    }
  };

  const identidadCompleta = Boolean(form.razon_social.trim() && form.condusef_registro.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-[1px] p-4">
      <div className="w-full max-w-3xl max-h-[90vh] rounded-xl bg-white border border-slate-300 shadow-2xl flex flex-col overflow-hidden">
        {/* Header Meridian Core (#0F172A) */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <Settings className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">
                  Configuración del Despacho
                </h2>
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-emerald-400 border border-slate-700">
                  {form.tenant_id || 't_arkangel'}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-mono font-semibold ${
                    identidadCompleta
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-red-500/20 text-red-300'
                  }`}
                >
                  {identidadCompleta ? '● MOTOR LEGAL ACTIVO' : '● FAIL-CLOSED (FALTA IDENTIDAD)'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Identidad jurídica CONDUSEF, límites NOM-184, umbrales de IA y webhooks de pago
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Cerrar configuración"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Contenido scrollable */}
        <form onSubmit={guardar} className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#F8FAFC]">
          {loading ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Cargando parámetros del despacho desde D1…
            </div>
          ) : (
            <>
              {error ? (
                <Alert tone="err" title="Error de configuración">
                  {error}
                </Alert>
              ) : null}

              {notice ? (
                <Alert tone="ok" title="Actualización aplicada">
                  {notice}
                </Alert>
              ) : null}

              {/* Sección 1: Identidad Legal CONDUSEF / REDECO */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Scale className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      1 · Identidad Jurídica y Dominios Autorizados (Reglas 1.1 y 3.1)
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={aplicarPresetDemo}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
                  >
                    <Sparkles className="h-3 w-3" /> Rellenar datos sintéticos
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Nombre Comercial del Despacho
                    </label>
                    <input
                      type="text"
                      required
                      value={form.nombre}
                      onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                      placeholder="Ej. Arkangel"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Folio REDECO / CONDUSEF (Obligatorio Regla 1.1)
                    </label>
                    <input
                      type="text"
                      value={form.condusef_registro}
                      onChange={(e) => setForm({ ...form, condusef_registro: e.target.value })}
                      placeholder="Ej. REDECO-2026-0042"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Razón Social Registrada (Se imprime en primer contacto y guion Softphone)
                    </label>
                    <input
                      type="text"
                      value={form.razon_social}
                      onChange={(e) => setForm({ ...form, razon_social: e.target.value })}
                      placeholder="Ej. Arkangel Cobranza Legal S.A.P.I. de C.V."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Dominios de Pago Autorizados (Separados por coma · Regla 3.1 Antiphishing)
                    </label>
                    <input
                      type="text"
                      value={form.allowed_payment_domains}
                      onChange={(e) =>
                        setForm({ ...form, allowed_payment_domains: e.target.value })
                      }
                      placeholder="arksystems.site, pagos.arksystems.site, conekta.com"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Cualquier link en un mensaje saliente fuera de esta lista (o acortadores como{' '}
                      <code>bit.ly</code>) será bloqueado con error 422.
                    </p>
                  </div>
                </div>
              </div>

              {/* Sección 2: Parámetros NOM-184 y Orquestación IA */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    2 · Ventana Legal NOM-184, Límites 24h y Umbral de Escalamiento IA
                  </h3>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Hora Inicio (CDMX)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={22}
                      value={form.send_window_start}
                      onChange={(e) =>
                        setForm({ ...form, send_window_start: Number(e.target.value) })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Hora Fin (CDMX)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={form.send_window_end}
                      onChange={(e) =>
                        setForm({ ...form, send_window_end: Number(e.target.value) })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Máx. Contactos / 24h
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={form.max_contacts_per_day}
                      onChange={(e) =>
                        setForm({ ...form, max_contacts_per_day: Number(e.target.value) })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Rate Limit (RPM)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={600}
                      value={form.rate_limit_rpm}
                      onChange={(e) => setForm({ ...form, rate_limit_rpm: Number(e.target.value) })}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Modo del Agente IA
                    </label>
                    <select
                      value={form.agent_mode}
                      onChange={(e) => setForm({ ...form, agent_mode: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                    >
                      <option value="supervised">Supervisado (Disparo 1-clic)</option>
                      <option value="autonomous">Autónomo (Cron automático)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Umbral Escalamiento ($ MXN)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={Math.round(form.agent_auto_threshold_cents / 100)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          agent_auto_threshold_cents: Math.max(0, Number(e.target.value) * 100),
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
                    />
                  </div>

                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700 select-none">
                      <input
                        type="checkbox"
                        checked={form.dry_run}
                        onChange={(e) => setForm({ ...form, dry_run: e.target.checked })}
                        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>
                        Modo <strong>Dry-Run</strong> (Simular envíos sin cobrar)
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Sección 3: Canales Operativos del Despacho (tenant_channels) */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Settings className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      3 · Canales Operativos del Despacho (Mix de Plan y Enrutado)
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    Solo el Manager decide qué canales usa la IA y el Agente
                  </span>
                </div>

                <div className="space-y-3">
                  {channels.map((ch) => {
                    const isActive = ch.status === 'active';
                    const meta =
                      ch.channel === 'whatsapp'
                        ? {
                            title: 'WhatsApp Business (Telnyx API v2)',
                            idLabel: 'Número Remitente WhatsApp (E.164)',
                            idPlaceholder: 'Ej. +525512345678',
                            extraLabel: 'Plantilla aprobada (template_name)',
                            extraKey: 'template_name' as const,
                            extraValue: ch.template_name,
                            extraPlaceholder: 'Ej. recordatorio_pago_mx',
                          }
                        : ch.channel === 'sms'
                          ? {
                              title: 'SMS Transaccional (Telnyx)',
                              idLabel: 'Messaging Profile ID (Telnyx)',
                              idPlaceholder: 'Ej. 40017f8e-99a1-4b2c-8001',
                              extraLabel: 'Número remitente (from_number)',
                              extraKey: 'from_number' as const,
                              extraValue: ch.from_number,
                              extraPlaceholder: 'Ej. +525590001122',
                            }
                          : {
                              title: 'Correo Electrónico (Resend)',
                              idLabel: 'Dominio receptor verificado',
                              idPlaceholder: 'Ej. cobranza.despacho.mx',
                              extraLabel: 'Correo remitente (from_address)',
                              extraKey: 'from_address' as const,
                              extraValue: ch.from_address,
                              extraPlaceholder: 'Ej. Cobranza <avisos@despacho.mx>',
                            };

                    const testResult = testResults[ch.channel];

                    return (
                      <div
                        key={ch.channel}
                        className={`rounded-lg border p-3.5 transition-colors ${
                          isActive
                            ? 'border-emerald-200 bg-emerald-50/30'
                            : 'border-slate-200 bg-slate-50 opacity-75'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2.5">
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={isActive}
                              onChange={(e) =>
                                updateChannelField(ch.channel, {
                                  status: e.target.checked ? 'active' : 'inactive',
                                })
                              }
                              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className="text-xs font-semibold text-slate-900">
                              {meta.title}
                            </span>
                          </label>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={!isActive || testingChannel === ch.channel}
                              onClick={() => void handleTestChannel(ch)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:text-emerald-700 disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-slate-700 transition-colors shadow-2xs"
                              title="Probar handshake y credenciales de este canal"
                            >
                              {testingChannel === ch.channel ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin text-emerald-600" />
                                  <span>Probando…</span>
                                </>
                              ) : (
                                <>
                                  <Activity className="h-3 w-3 text-emerald-600" />
                                  <span>Probar canal</span>
                                </>
                              )}
                            </button>
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-mono font-semibold uppercase ${
                                isActive
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-slate-200 text-slate-600'
                              }`}
                            >
                              {isActive ? 'HABILITADO' : 'APAGADO'}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              {meta.idLabel}
                            </label>
                            <input
                              type="text"
                              disabled={!isActive}
                              value={ch.provider_account_id}
                              onChange={(e) =>
                                updateChannelField(ch.channel, {
                                  provider_account_id: e.target.value,
                                })
                              }
                              placeholder={meta.idPlaceholder}
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-900 disabled:bg-slate-100"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              {meta.extraLabel}
                            </label>
                            <input
                              type="text"
                              disabled={!isActive}
                              value={meta.extraValue}
                              onChange={(e) =>
                                updateChannelField(ch.channel, {
                                  [meta.extraKey]: e.target.value,
                                })
                              }
                              placeholder={meta.extraPlaceholder}
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-900 disabled:bg-slate-100"
                            />
                          </div>
                        </div>

                        {testResult ? (
                          <div
                            className={`mt-3 rounded-md p-2.5 text-xs flex items-start gap-2 border transition-all ${
                              testResult.ok
                                ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                                : 'bg-red-50 border-red-200 text-red-950'
                            }`}
                          >
                            {testResult.ok ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                            ) : (
                              <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold flex items-center justify-between gap-2">
                                <span>{testResult.ok ? 'Canal verificado' : 'Fallo en canal'}</span>
                                {testResult.latency_ms > 0 ? (
                                  <span className="font-mono text-[10px] text-slate-500">
                                    {testResult.latency_ms}ms
                                  </span>
                                ) : null}
                              </div>
                              <p className="text-[11px] mt-0.5 opacity-90 leading-relaxed">
                                {testResult.ok ? testResult.details : testResult.error}
                              </p>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* Telefonía y Asistente de Voz Telnyx Voice AI */}
                <div className="mt-4 rounded-lg border border-indigo-200 bg-linear-to-r from-indigo-50/60 to-purple-50/40 p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <PhoneCall className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                      <div>
                        <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          Telefonía & Voice AI (Telnyx Voice Assistants)
                          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-mono font-bold text-indigo-700">
                            PRODUCCIÓN
                          </span>
                        </h4>
                        <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                          Marcación PSTN directa a México (+52), latencia conversacional &lt; 800ms, detección de buzón (AMD) y audio firmado para Cuaderno Judicial.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={syncingAssistant}
                      onClick={() => void handleSyncAssistant()}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors disabled:opacity-50 shrink-0 cursor-pointer"
                    >
                      {syncingAssistant ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                          <span>Sincronizando…</span>
                        </>
                      ) : (
                        <>
                          <Bot className="h-3.5 w-3.5" />
                          <span>Sincronizar Asistente de Voz Telnyx</span>
                        </>
                      )}
                    </button>
                  </div>

                  {syncAssistantResult ? (
                    <div
                      className={`rounded-md p-2.5 text-xs flex items-start gap-2 border ${
                        syncAssistantResult.ok
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                          : 'bg-red-50 border-red-200 text-red-950'
                      }`}
                    >
                      {syncAssistantResult.ok ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">
                          {syncAssistantResult.ok
                            ? 'Asistente de Voz Telnyx Sincronizado'
                            : 'Error al Sincronizar Asistente'}
                        </div>
                        <p className="text-[11px] mt-0.5 opacity-90 leading-relaxed font-mono">
                          {syncAssistantResult.ok
                            ? `Assistant ID: ${syncAssistantResult.assistantId || 'Activo en Telnyx'} — Guion de cobranza y webhook configurados.`
                            : syncAssistantResult.error}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Sección 4: Webhooks de Conciliación y Canales */}
              {webhooks ? (
                <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
                    <Webhook className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      4 · URLs de Webhooks para Pasarelas de Pago y Canales
                    </h3>
                  </div>

                  <div className="space-y-2 text-xs">
                    {[
                      {
                        key: 'conekta',
                        label: 'Conekta (SPEI / OXXO Pay · Recomendado PyME)',
                        url: webhooks.conekta,
                      },
                      {
                        key: 'cobre',
                        label: 'Cobre (SPEI Cash-In · Enterprise)',
                        url: webhooks.cobre,
                      },
                      {
                        key: 'whatsapp',
                        label: 'WhatsApp (Telnyx API · Webhook)',
                        url: webhooks.whatsapp,
                      },
                      {
                        key: 'telnyx',
                        label: 'Telnyx (SMS y WhatsApp unificado · Ed25519)',
                        url: webhooks.telnyx,
                      },
                    ].map((item) => (
                      <div
                        key={item.key}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <span className="font-medium text-slate-700">{item.label}</span>
                        <div className="flex items-center gap-2">
                          <code className="text-[11px] font-mono text-slate-800 bg-white px-2 py-0.5 rounded border border-slate-200">
                            {item.url}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copiarUrl(item.key, item.url)}
                            className="inline-flex items-center gap-1 rounded bg-slate-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-800"
                          >
                            {copiedUrl === item.key ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" /> Copiado
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" /> Copiar
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Sección 5: Equipo del Despacho (Invitaciones Self-Serve) */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      5 · Equipo del Despacho e Invitaciones ({members.length})
                    </h3>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    RBAC: Owner · Operador (Admin) · Auditor (Viewer)
                  </span>
                </div>

                {/* Formulario rápido de invitación */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Correo electrónico
                    </label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="operador@despacho.mx"
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Nombre
                    </label>
                    <input
                      type="text"
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                      placeholder="Ej. Ana López"
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Rol en el Despacho
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as MembershipRole)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    >
                      <option value="admin">Operador (Admin)</option>
                      <option value="member">Auditor (Solo lectura)</option>
                      <option value="owner">Propietario (Owner)</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      disabled={inviting || !inviteEmail.trim()}
                      onClick={() => void invitarMiembro()}
                      className="w-full inline-flex items-center justify-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      {inviting ? '…' : 'Invitar'}
                    </button>
                  </div>
                </div>

                {lastInviteUrl ? (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
                    <span className="font-medium text-emerald-900">
                      Enlace de activación (válido 7 días):
                    </span>
                    <div className="flex items-center gap-2">
                      <code className="text-[11px] font-mono text-emerald-950 bg-white px-2 py-0.5 rounded border border-emerald-200 truncate max-w-[260px]">
                        {lastInviteUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => void copiarUrl('invite_link', lastInviteUrl)}
                        className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-800"
                      >
                        {copiedUrl === 'invite_link' ? (
                          <>
                            <Check className="h-3 w-3" /> Copiado
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copiar enlace
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Lista de miembros */}
                {members.length > 0 ? (
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {members.map((m) => (
                      <div
                        key={m.userId}
                        className="flex items-center justify-between px-3 py-2 text-xs"
                      >
                        <div>
                          <div className="font-medium text-slate-900 flex items-center gap-2">
                            <span>{m.fullName || m.email}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono uppercase text-slate-700">
                              {m.role === 'owner'
                                ? 'owner'
                                : m.role === 'admin'
                                  ? 'operador'
                                  : 'viewer'}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                                m.active
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-amber-50 text-amber-700'
                              }`}
                            >
                              {m.active ? 'activo' : 'pendiente'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono">{m.email}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void revocarMiembro(m.userId, m.email)}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-red-50 hover:text-red-700 transition-colors"
                          title="Revocar acceso al despacho"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Revocar
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    Aún no hay miembros listados en este despacho.
                  </p>
                )}
              </div>
            </>
          )}

          {/* Footer con acciones */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cerrar
            </Button>
            <Button
              variant="accent"
              size="sm"
              type="submit"
              icon={Save}
              disabled={saving || loading}
            >
              {saving ? 'Guardando en D1…' : 'Guardar y Aplicar al Worker'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
