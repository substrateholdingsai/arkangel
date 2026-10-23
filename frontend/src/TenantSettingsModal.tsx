import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  Save,
  Scale,
  Settings,
  ShieldCheck,
  Sparkles,
  Webhook,
  X,
} from 'lucide-react';
import { Alert, Button } from '@ds';
import { api, type TenantSettings, type TenantWebhooks } from './api';

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

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const res = await api.getTenantSettings();
        setForm(res.settings);
        setWebhooks(res.webhooks);
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
      const res = await api.updateTenantSettings(form);
      setForm(res.settings);
      setNotice(
        'Configuración guardada en D1 y sincronizada con los contratos y el Motor Legal en vivo.'
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar configuración');
    } finally {
      setSaving(false);
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

              {/* Sección 3: Webhooks de Conciliación y Canales */}
              {webhooks ? (
                <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5">
                    <Webhook className="h-4 w-4 text-emerald-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      3 · URLs de Webhooks para Pasarelas de Pago y Canales
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
                        label: 'Meta WhatsApp Cloud API',
                        url: webhooks.whatsapp,
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
