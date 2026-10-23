import { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Lock,
  Mail,
  RefreshCw,
  Save,
  ShieldAlert,
  X,
} from 'lucide-react';
import { Alert, Button } from '@ds';
import {
  api,
  type AccountingLivePayload,
  type AccountingMapRule,
  type DailyExecutiveReport,
} from './api';

interface AccountingReportModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'corte' | 'mapa' | 'reporte';

function formatMoney(mxn: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(mxn || 0);
}

export function AccountingReportModal({ open, onClose }: AccountingReportModalProps) {
  const [tab, setTab] = useState<Tab>('corte');
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [savingMap, setSavingMap] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [corte, setCorte] = useState<AccountingLivePayload | null>(null);
  const [rules, setRules] = useState<AccountingMapRule[]>([]);
  const [report, setReport] = useState<DailyExecutiveReport | null>(null);

  const cargarTodo = async (targetDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const [corteRes, mapRes, reportRes] = await Promise.all([
        api.getAccountingLive(targetDate),
        api.getAccountingMap(),
        api.getDailyReport(targetDate),
      ]);
      setCorte(corteRes);
      setRules(mapRes.rules);
      setReport(reportRes.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el corte contable en vivo.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    void cargarTodo(fecha);
  }, [open, fecha]);

  if (!open) return null;

  const guardarMapa = async () => {
    setSavingMap(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateAccountingMap(rules);
      setRules(res.rules);
      setNotice(
        `Catálogo contable actualizado (${res.updated} reglas guardadas en tenant_accounting_map).`
      );
      void cargarTodo(fecha);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el mapa contable.');
    } finally {
      setSavingMap(false);
    }
  };

  const enviarReporteCorreo = async () => {
    setSendingEmail(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.sendDailyReport({
        date: fecha,
        to: emailTo.trim() || undefined,
      });
      setReport(res.report);
      setNotice(
        res.email_sent
          ? `Reporte Ejecutivo enviado por Resend a: ${res.recipients.join(', ')}`
          : `Reporte generado y registrado en bitácora (${res.recipients.length ? res.recipients.join(', ') : 'sin destinatario SMTP activo'}).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el reporte diario.');
    } finally {
      setSendingEmail(false);
    }
  };

  const descargarJson = () => {
    const payload = tab === 'reporte' ? report : corte;
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `arkangel-${tab}-${fecha}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const verificado = corte?.ledger_integrity.verificado ?? true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-[1px] p-4">
      <div className="w-full max-w-4xl max-h-[90vh] rounded-xl bg-white border border-slate-300 shadow-2xl flex flex-col overflow-hidden">
        {/* Header Meridian Core */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">
                  Corte Contable, Ledger & Reporte Ejecutivo
                </h2>
                <span
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono font-semibold ${
                    verificado ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
                  }`}
                >
                  {verificado ? (
                    <>
                      <Lock className="h-3 w-3" /> LEDGER ÍNTEGRO
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="h-3 w-3" /> ALERTA DE CADENA
                    </>
                  )}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Pólizas Alegra MCP en vivo, catálogo de cuentas por despacho (Fase 6) y reporte
                diario
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1 text-xs font-mono text-white"
            />
            <button
              type="button"
              onClick={() => void cargarTodo(fecha)}
              className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
              title="Recalcular en vivo"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Cerrar"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Pestañas */}
        <div className="flex items-center justify-between px-6 py-2.5 bg-slate-100 border-b border-slate-200">
          <div className="flex items-center gap-1.5">
            {[
              { id: 'corte' as const, label: '1 · Corte Contable & Cadena Ledger' },
              { id: 'mapa' as const, label: '2 · Catálogo de Cuentas Alegra (12 Reglas)' },
              { id: 'reporte' as const, label: '3 · Reporte Ejecutivo Diario' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  setNotice(null);
                  setError(null);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === item.id
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={descargarJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" /> Exportar JSON
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-[#F8FAFC]">
          {error ? (
            <Alert tone="err" title="Error">
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert tone="ok" title="Listo">
              {notice}
            </Alert>
          ) : null}

          {loading ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Calculando cadena criptográfica del ledger y pólizas contables en vivo…
            </div>
          ) : tab === 'corte' && corte ? (
            <>
              {/* Tarjeta de Integridad del Ledger */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      Cadena Append-Only (`legal_audit`) · {corte.ledger_integrity.total_registros}{' '}
                      registros hoy
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-500 mt-1">
                    Hash cabeza: {corte.ledger_integrity.hash_ultimo_registro}
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-block rounded bg-slate-100 px-2 py-1 text-[11px] font-mono text-slate-700">
                    Idempotency: {corte.idempotency_key.slice(0, 26)}…
                  </span>
                </div>
              </div>

              {/* KPIs Contables */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-mono uppercase text-slate-500">
                    Ingresos Reconocidos
                  </p>
                  <p className="mt-1 text-lg font-bold font-mono text-emerald-700">
                    {formatMoney(corte.resumen.ingresos_reconocidos)}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    delivered · read · promise_made
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-mono uppercase text-slate-500">
                    Provisión Cartera Ilegal
                  </p>
                  <p className="mt-1 text-lg font-bold font-mono text-amber-700">
                    {formatMoney(corte.resumen.provision_cartera_ilegal)}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Conductas auditadas hoy</p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-mono uppercase text-slate-500">
                    IVA Trasladado (16%)
                  </p>
                  <p className="mt-1 text-lg font-bold font-mono text-slate-900">
                    {formatMoney(corte.resumen.iva_trasladado)}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    IVA acred. est.: {formatMoney(corte.resumen.iva_acreditable_estimado)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-mono uppercase text-slate-500">
                    Pólizas Alegra MCP
                  </p>
                  <p className="mt-1 text-lg font-bold font-mono text-slate-900">
                    {corte.asientos.length}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Asientos listos para envío</p>
                </div>
              </div>

              {/* Tabla de Asientos */}
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Desglose de Pólizas Contables ({corte.asientos.length})
                  </h3>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Fecha de corte: {corte.fecha_corte}
                  </span>
                </div>
                {corte.asientos.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    Sin asientos de provisión o contingencia para esta fecha (0 violaciones con
                    impacto contable).
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-[11px] font-mono uppercase text-slate-500 border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3">Regla</th>
                          <th className="py-2.5 px-3">Débito</th>
                          <th className="py-2.5 px-3">Crédito</th>
                          <th className="py-2.5 px-3">Tipo</th>
                          <th className="py-2.5 px-3">Concepto / Ref. Ledger</th>
                          <th className="py-2.5 px-3 text-right">Monto</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {corte.asientos.map((a) => (
                          <tr key={a.legal_audit_id}>
                            <td className="py-2 px-3 font-mono font-semibold text-emerald-700">
                              {a.regla_id}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-800">
                              {a.cuenta_debito}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-800">
                              {a.cuenta_credito}
                            </td>
                            <td className="py-2 px-3 font-mono uppercase text-[10px] text-slate-600">
                              {a.tipo_asiento}
                            </td>
                            <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                              {a.concepto}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-medium text-slate-900">
                              {formatMoney(a.monto)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : tab === 'mapa' ? (
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Catálogo de Cuentas Contables por Regla Legal (`tenant_accounting_map`)
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Personaliza las cuentas Débito y Crédito de tu catálogo de Alegra para cada una
                    de las 12 reglas del Motor Legal.
                  </p>
                </div>
                <Button
                  variant="accent"
                  size="sm"
                  icon={Save}
                  disabled={savingMap}
                  onClick={() => void guardarMapa()}
                >
                  {savingMap ? 'Guardando…' : 'Guardar Catálogo en D1'}
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] font-mono uppercase text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-2.5">Regla</th>
                      <th className="py-2 px-2.5">Cuenta Débito</th>
                      <th className="py-2 px-2.5">Cuenta Crédito</th>
                      <th className="py-2 px-2.5">Tipo Póliza</th>
                      <th className="py-2 px-2.5">Descripción Contable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rules.map((r, idx) => (
                      <tr key={r.regla_id}>
                        <td className="py-2 px-2.5 font-mono font-bold text-emerald-700">
                          {r.regla_id}
                        </td>
                        <td className="py-2 px-2.5">
                          <input
                            type="text"
                            value={r.cuenta_debito}
                            onChange={(e) => {
                              const next = [...rules];
                              next[idx] = { ...r, cuenta_debito: e.target.value };
                              setRules(next);
                            }}
                            className="w-28 rounded border border-slate-300 px-2 py-1 font-mono text-xs text-slate-900"
                          />
                        </td>
                        <td className="py-2 px-2.5">
                          <input
                            type="text"
                            value={r.cuenta_credito}
                            onChange={(e) => {
                              const next = [...rules];
                              next[idx] = { ...r, cuenta_credito: e.target.value };
                              setRules(next);
                            }}
                            className="w-28 rounded border border-slate-300 px-2 py-1 font-mono text-xs text-slate-900"
                          />
                        </td>
                        <td className="py-2 px-2.5">
                          <select
                            value={r.tipo_asiento}
                            onChange={(e) => {
                              const next = [...rules];
                              next[idx] = {
                                ...r,
                                tipo_asiento: e.target.value as AccountingMapRule['tipo_asiento'],
                              };
                              setRules(next);
                            }}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                          >
                            <option value="provision">Provisión</option>
                            <option value="gasto">Gasto</option>
                            <option value="contingencia">Contingencia</option>
                          </select>
                        </td>
                        <td className="py-2 px-2.5">
                          <input
                            type="text"
                            value={r.descripcion}
                            onChange={(e) => {
                              const next = [...rules];
                              next[idx] = { ...r, descripcion: e.target.value };
                              setRules(next);
                            }}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-800"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : tab === 'reporte' && report ? (
            <div className="space-y-4">
              {/* Envío por correo */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      Envío Automatizado del Reporte Ejecutivo Diario
                    </h3>
                    <p className="text-xs text-slate-500">
                      Envía el corte consolidado por Resend al correo indicado (o a los propietarios
                      del despacho si se deja vacío).
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="direccion@despacho.mx (opcional)"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 w-56"
                  />
                  <Button
                    variant="accent"
                    size="sm"
                    icon={Mail}
                    disabled={sendingEmail}
                    onClick={() => void enviarReporteCorreo()}
                  >
                    {sendingEmail ? 'Enviando…' : 'Enviar por Correo'}
                  </Button>
                </div>
              </div>

              {/* Resumen Consolidado */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2">
                    1 · Operación y Recuperación
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Casos del día:</span>
                      <span className="font-mono font-semibold">
                        {report.operacion.total_casos}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Mensajes enviados:</span>
                      <span className="font-mono font-semibold">
                        {report.operacion.mensajes_enviados}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Promesas registradas:</span>
                      <span className="font-mono font-semibold text-emerald-700">
                        {report.operacion.promesas_registradas} (
                        {formatMoney(report.operacion.monto_prometido_cents / 100)})
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Cobrado / Conciliado:</span>
                      <span className="font-mono font-semibold text-emerald-700">
                        {formatMoney(report.operacion.monto_cobrado_cents / 100)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Escalados a humano:</span>
                      <span className="font-mono font-semibold text-red-600">
                        {report.operacion.escalados_humano}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2">
                    2 · Cumplimiento CONDUSEF
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Auditorías hoy:</span>
                      <span className="font-mono font-semibold">
                        {report.cumplimiento_legal.total_auditorias}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Bloqueos preventivos:</span>
                      <span className="font-mono font-semibold text-red-600">
                        {report.cumplimiento_legal.bloqueos}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Saneos automáticos:</span>
                      <span className="font-mono font-semibold text-amber-600">
                        {report.cumplimiento_legal.saneos}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Folio REDECO:</span>
                      <span className="font-mono text-slate-800">
                        {report.tenant.condusef ?? 'Pendiente'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2">
                    3 · Cierre Contable Alegra
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Ingresos reconocidos:</span>
                      <span className="font-mono font-semibold text-emerald-700">
                        {formatMoney(report.contabilidad.ingresos_reconocidos_mxn)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Provisión legal:</span>
                      <span className="font-mono font-semibold text-amber-700">
                        {formatMoney(report.contabilidad.provision_cartera_ilegal_mxn)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">IVA trasladado:</span>
                      <span className="font-mono font-semibold">
                        {formatMoney(report.contabilidad.iva_trasladado_mxn)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Integridad Ledger:</span>
                      <span className="font-mono font-semibold text-emerald-700">
                        {report.contabilidad.ledger_verificado ? 'VERIFICADO' : 'ERROR'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
