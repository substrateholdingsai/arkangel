import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react';
import { Alert, Button, ChannelBadge, StatusBadge } from '@ds';
import { api, ApiError, type CaseWorkspace } from './api';

function formatMXN(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function OperatorDrawer({
  caseId,
  onClose,
  onUpdated,
}: {
  caseId: string | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [ws, setWs] = useState<CaseWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Respuesta escrita
  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'email'>('whatsapp');
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  // Promesa rápida
  const [showPromiseForm, setShowPromiseForm] = useState(false);
  const [promiseDate, setPromiseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [promisePesos, setPromisePesos] = useState('');
  const [resolving, setResolving] = useState(false);

  // Softphone
  const [callActive, setCallActive] = useState(false);
  const [callMuted, setCallMuted] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [callScript, setCallScript] = useState<string | null>(null);
  const [callNotes, setCallNotes] = useState('');
  const [callOutcome, setCallOutcome] = useState<'promesa' | 'aclaracion' | 'buzon' | 'contactado'>(
    'contactado'
  );
  const [callingBusy, setCallingBusy] = useState(false);

  // Notas internas del operador (estilo Payments by Wix) y conciliación Cobre SPEI
  const [manualNote, setManualNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [simulatingSpei, setSimulatingSpei] = useState(false);

  const cargarFicha = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.caseWorkspace(id);
      setWs(data);
      setPromisePesos(String(Math.round(data.case.amount_cents / 100)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el expediente');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!caseId) {
      setWs(null);
      setCallActive(false);
      setNotice(null);
      setError(null);
      return;
    }
    void cargarFicha(caseId);
  }, [caseId, cargarFicha]);

  // Cronómetro del softphone
  useEffect(() => {
    if (!callActive) return;
    const t = window.setInterval(() => setCallSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(t);
  }, [callActive]);

  if (!caseId) return null;

  const insertarPlantillaLegal = () => {
    if (!ws) return;
    const razon = ws.contract?.nombre_legal || ws.legal.nombre_legal || 'Despacho Autorizado';
    const condusef = ws.contract?.condusef || ws.legal.condusef || 'REDECO';
    const clabe = ws.contract?.clabe ? ` CLABE autorizada: ${ws.contract.clabe}.` : '';
    const monto = formatMXN(ws.case.amount_cents);
    setReplyText(
      `Estimado(a) ${ws.case.name}, le contactamos de ${razon} (Registro CONDUSEF ${condusef}) en seguimiento a su saldo pendiente por ${monto}.${clabe} Quedamos atentos para apoyarle.`
    );
  };

  const enviarMensaje = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws || !replyText.trim()) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.replyCase(ws.case.id, { channel, body: replyText.trim() });
      setReplyText('');
      setNotice(
        res.violaciones.length > 0
          ? `Mensaje enviado con ${res.violaciones.length} ajuste(s) del sanitizador legal.`
          : 'Mensaje validado por el Motor Legal y enviado.'
      );
      await cargarFicha(ws.case.id);
      onUpdated();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('No se pudo enviar el mensaje.');
      }
    } finally {
      setSending(false);
    }
  };

  const ejecutarResolucion = async (action: 'promise' | 'paid' | 'return_ai' | 'dnd') => {
    if (!ws) return;
    setResolving(true);
    setError(null);
    setNotice(null);
    try {
      const amountCents =
        action === 'promise'
          ? Math.max(100, Math.round(Number(promisePesos || 0) * 100))
          : undefined;
      await api.resolveCase(ws.case.id, {
        action,
        promised_date: action === 'promise' ? promiseDate : undefined,
        promised_amount_cents: amountCents,
      });
      setShowPromiseForm(false);
      setNotice(
        action === 'promise'
          ? `Promesa registrada para el ${promiseDate}.`
          : action === 'paid'
            ? 'Caso marcado como pagado.'
            : action === 'return_ai'
              ? 'Caso devuelto a la cola automática de IA.'
              : 'Cliente marcado en No Molestar (DND).'
      );
      await cargarFicha(ws.case.id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el caso');
    } finally {
      setResolving(false);
    }
  };

  const iniciarLlamada = async () => {
    if (!ws) return;
    setCallingBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.callCase(ws.case.id, { phase: 'start' });
      setCallScript(res.guion_obligatorio ?? null);
      setCallSeconds(0);
      setCallMuted(false);
      setCallActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Llamada bloqueada por el Motor Legal');
    } finally {
      setCallingBusy(false);
    }
  };

  const finalizarLlamada = async () => {
    if (!ws) return;
    setCallingBusy(true);
    setError(null);
    try {
      await api.callCase(ws.case.id, {
        phase: 'complete',
        duration_seconds: callSeconds,
        outcome: callOutcome,
        notes: callNotes,
      });
      setCallActive(false);
      setCallNotes('');
      setNotice(
        `Llamada de ${formatDuration(callSeconds)} sellada en el historial y en auditoría legal.`
      );
      await cargarFicha(ws.case.id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar el cierre de llamada');
    } finally {
      setCallingBusy(false);
    }
  };

  const guardarNotaInterna = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws || !manualNote.trim()) return;
    setSavingNote(true);
    setError(null);
    try {
      await api.addCaseNote(ws.case.id, manualNote.trim());
      setManualNote('');
      setNotice('Nota interna guardada en el expediente (no visible para el deudor).');
      await cargarFicha(ws.case.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la nota interna');
    } finally {
      setSavingNote(false);
    }
  };

  const simularSpeiCobre = async () => {
    if (!ws) return;
    setSimulatingSpei(true);
    setError(null);
    setNotice(null);
    try {
      const tracking = `COBRE${Date.now().toString().slice(-8)}`;
      await api.reconcileCobreSpei({
        clabe: ws.contract?.clabe ?? null,
        reference: ws.case.id,
        amount_cents: ws.case.amount_cents,
        tracking_key: tracking,
      });
      setNotice(
        `Cash-In SPEI conciliado vía Cobre (Rastreo ${tracking}). Deuda liquidada y caso retirado de la cola.`
      );
      await cargarFicha(ws.case.id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conciliar el pago SPEI');
    } finally {
      setSimulatingSpei(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-[1px]">
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col overflow-hidden">
        {/* Header Meridian Core (#0F172A) */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between border-b border-slate-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] data-mono uppercase tracking-wider px-2 py-0.5 rounded bg-slate-800 text-emerald-400 border border-slate-700">
                {ws?.case.id ?? caseId}
              </span>
              {ws ? <StatusBadge status={ws.case.status} /> : null}
              {ws?.client?.do_not_disturb ? (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-red-600 text-white">
                  DND · NO MOLESTAR
                </span>
              ) : null}
            </div>
            <h2 className="text-lg font-semibold mt-1 truncate">
              {ws?.case.name ?? 'Cargando expediente…'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Cerrar panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body scrollable */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-[#F8FAFC]">
          {loading && !ws ? (
            <div className="text-sm text-slate-500 py-12 text-center">
              Cargando ficha legal y conversación…
            </div>
          ) : null}

          {error ? (
            <Alert tone="err" title="Escudo Legal / Operación">
              {error}
            </Alert>
          ) : null}

          {notice ? (
            <Alert tone="ok" title="Operación registrada">
              {notice}
            </Alert>
          ) : null}

          {ws ? (
            <>
              {/* 0. Diagnóstico Ejecutivo IA + Notas Internas (Estilo Payments by Wix) */}
              {ws.ai_diagnostic ? (
                <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-emerald-400">
                        <Bot className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                            Diagnóstico Ejecutivo IA
                          </span>
                          {ws.ai_diagnostic.payment_status === 'paid' ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-emerald-800">
                              CONCILIADO
                            </span>
                          ) : ws.ai_diagnostic.payment_status === 'claimed_paid' ? (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-amber-800">
                              REPORTA PAGO
                            </span>
                          ) : null}
                        </div>
                        <p className="text-sm font-semibold text-slate-900 mt-0.5">
                          {ws.ai_diagnostic.headline}
                        </p>
                        <p className="text-xs text-slate-600 mt-1">{ws.ai_diagnostic.reason}</p>
                        <p className="text-xs font-medium text-emerald-800 mt-1.5">
                          → Siguiente paso: {ws.ai_diagnostic.recommended_action}
                        </p>
                      </div>
                    </div>

                    {ws.case.status !== 'paid' ? (
                      <button
                        type="button"
                        disabled={simulatingSpei}
                        onClick={() => void simularSpeiCobre()}
                        className="shrink-0 rounded-lg border border-emerald-600 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 transition-colors disabled:opacity-50"
                        title="Simular webhook SPEI de Cobre en tiempo real sobre la CLABE de este contrato"
                      >
                        {simulatingSpei ? 'Conciliando…' : '⚡ Conciliar SPEI (Cobre)'}
                      </button>
                    ) : null}
                  </div>

                  {/* Espacio de Notas Internas Manuales (lo que la IA pasó por alto) */}
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <form onSubmit={guardarNotaInterna} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={manualNote}
                        onChange={(e) => setManualNote(e.target.value)}
                        placeholder="Nota interna manual (contexto adicional que la IA pasó por alto)…"
                        className="flex-1 rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                      />
                      <button
                        type="submit"
                        disabled={!manualNote.trim() || savingNote}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                      >
                        {savingNote ? 'Guardando…' : 'Guardar nota'}
                      </button>
                    </form>

                    {ws.notes && ws.notes.length > 0 ? (
                      <div className="space-y-1.5 max-h-28 overflow-y-auto">
                        {ws.notes.map((n) => (
                          <div
                            key={n.id}
                            className="rounded bg-amber-50/70 border border-amber-200/80 px-2.5 py-1.5 text-xs text-slate-800 flex items-baseline justify-between gap-2"
                          >
                            <span>
                              <strong className="font-semibold text-amber-900">Nota:</strong>{' '}
                              {n.note}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400 shrink-0">
                              {n.created_at.slice(11, 16)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* 1. Ficha Financiera y Legal (Ley de las Cifras §3.1) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-white p-3.5 rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-500 uppercase">
                    Saldo Exigible
                  </div>
                  <div className="text-lg font-bold text-slate-900 data-mono mt-0.5">
                    {formatMXN(ws.case.amount_cents)}
                  </div>
                  <div className="text-[11px] text-slate-500 data-mono mt-1">
                    Score Sherman: {ws.case.score} ({ws.case.score_band})
                  </div>
                </div>

                <div className="bg-white p-3.5 rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-500 uppercase">
                    Contacto / CURP
                  </div>
                  <div className="text-xs font-medium text-slate-900 data-mono mt-1 truncate">
                    {ws.client?.phone || ws.case.phone || 'Sin teléfono'}
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {ws.client?.email || ws.case.email || 'Sin correo'}
                  </div>
                  <div className="text-[11px] text-slate-400 data-mono mt-0.5 truncate">
                    CURP: {ws.client?.curp || 'N/D'}
                  </div>
                </div>

                <div className="bg-white p-3.5 rounded-lg border border-slate-200">
                  <div className="text-[11px] font-medium text-slate-500 uppercase flex items-center justify-between">
                    <span>Límite Legal 24h</span>
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  </div>
                  <div className="text-lg font-bold text-slate-900 data-mono mt-0.5">
                    {ws.contactos_24h} / {ws.legal.max_contactos_24h}
                  </div>
                  <div className="text-[11px] text-slate-500 data-mono mt-1 truncate">
                    CLABE: {ws.contract?.clabe || 'Sin contrato'}
                  </div>
                </div>
              </div>

              {/* 2. Softphone Integrado (WebRTC + Auditoría Legal) */}
              <div className="bg-slate-900 text-slate-100 rounded-xl p-4 border border-slate-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`p-2 rounded-lg ${callActive ? 'bg-emerald-600 text-white animate-pulse' : 'bg-slate-800 text-emerald-400'}`}
                    >
                      <PhoneCall className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                        Softphone Arkangel · Línea Auditada
                      </div>
                      <div className="text-xs text-slate-400 data-mono">
                        {ws.client?.phone || ws.case.phone || 'Sin número'} · Ventana{' '}
                        {String(ws.legal.ventana.inicio).padStart(2, '0')}:00–
                        {String(ws.legal.ventana.fin).padStart(2, '0')}:00h
                      </div>
                    </div>
                  </div>

                  {!callActive ? (
                    <Button
                      variant="accent"
                      size="sm"
                      icon={PhoneCall}
                      disabled={callingBusy || Boolean(ws.client?.do_not_disturb)}
                      onClick={() => void iniciarLlamada()}
                    >
                      {callingBusy ? 'Verificando…' : 'Llamar ahora'}
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded bg-slate-800 text-emerald-400 text-xs font-semibold data-mono border border-slate-700">
                        ● {formatDuration(callSeconds)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCallMuted((m) => !m)}
                        className={`p-2 rounded-md border text-xs ${
                          callMuted
                            ? 'bg-amber-600 border-amber-500 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                        }`}
                        title={callMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
                      >
                        {callMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={PhoneOff}
                        disabled={callingBusy}
                        onClick={() => void finalizarLlamada()}
                      >
                        Colgar y sellar
                      </Button>
                    </div>
                  )}
                </div>

                {callActive ? (
                  <div className="mt-4 pt-3 border-t border-slate-800 space-y-3">
                    {callScript ? (
                      <div className="bg-slate-950/80 border border-emerald-500/30 rounded-lg p-3 text-xs text-emerald-200">
                        <div className="font-semibold text-emerald-400 mb-1 flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Guion Obligatorio CONDUSEF (Regla 1.1 · leer al iniciar):
                        </div>
                        <p className="leading-relaxed">{callScript}</p>
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">
                          Resultado de la llamada
                        </label>
                        <select
                          value={callOutcome}
                          onChange={(e) =>
                            setCallOutcome(
                              e.target.value as 'promesa' | 'aclaracion' | 'buzon' | 'contactado'
                            )
                          }
                          className="w-full rounded bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100"
                        >
                          <option value="contactado">Contactado · En negociación</option>
                          <option value="promesa">Promesa de pago verbal</option>
                          <option value="aclaracion">Solicita aclaración / factura</option>
                          <option value="buzon">Buzón / No contesta</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] text-slate-400 mb-1">
                          Notas / Resumen auditado
                        </label>
                        <input
                          type="text"
                          value={callNotes}
                          onChange={(e) => setCallNotes(e.target.value)}
                          placeholder="Ej. Confirma transferencia SPEI para el viernes antes de las 14h…"
                          className="w-full rounded bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* 3. Barra de Resolución del Operador Humano */}
              <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-600" />
                    Resolución del Caso
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="accent"
                      size="sm"
                      icon={Clock}
                      disabled={resolving}
                      onClick={() => setShowPromiseForm((v) => !v)}
                    >
                      Registrar Promesa
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={CheckCircle2}
                      disabled={resolving}
                      onClick={() => void ejecutarResolucion('paid')}
                    >
                      Marcar Pagado
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={Bot}
                      disabled={resolving}
                      onClick={() => void ejecutarResolucion('return_ai')}
                    >
                      Devolver a IA
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      icon={AlertTriangle}
                      disabled={resolving}
                      onClick={() => void ejecutarResolucion('dnd')}
                    >
                      No Molestar (DND)
                    </Button>
                  </div>
                </div>

                {showPromiseForm ? (
                  <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Fecha prometida
                      </label>
                      <input
                        type="date"
                        value={promiseDate}
                        onChange={(e) => setPromiseDate(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs data-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Monto prometido (MXN)
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={promisePesos}
                        onChange={(e) => setPromisePesos(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs data-mono"
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={resolving}
                      onClick={() => void ejecutarResolucion('promise')}
                    >
                      Guardar Promesa
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* 4. Historial Omnicanal (IA + Humano + Softphone) */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Historial Omnicanal ({ws.messages.length})
                  </h3>
                  <span className="text-[11px] text-slate-500">
                    WhatsApp · SMS · Email · Softphone
                  </span>
                </div>
                <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                  {ws.messages.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400">
                      Sin mensajes registrados todavía.
                    </div>
                  ) : (
                    ws.messages.map((m) => {
                      const esEntrada = m.direction === 'inbound';
                      const esHumano =
                        m.meta?.includes('"human_operator":true') ||
                        m.meta?.includes('"softphone":true');
                      return (
                        <div
                          key={m.id}
                          className={`p-3.5 text-xs ${esEntrada ? 'bg-amber-50/40' : 'bg-white'}`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-semibold px-1.5 py-0.5 rounded text-[10px] uppercase ${
                                  esEntrada
                                    ? 'bg-amber-100 text-amber-800'
                                    : esHumano
                                      ? 'bg-slate-900 text-white'
                                      : 'bg-emerald-50 text-emerald-700'
                                }`}
                              >
                                {esEntrada ? 'Deudor' : esHumano ? 'Operador Humano' : 'Agente IA'}
                              </span>
                              <ChannelBadge channel={m.channel} />
                              <span className="text-[11px] text-slate-400 data-mono">
                                {m.status}
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-400 data-mono">
                              {m.created_at.replace('T', ' ').slice(0, 16)}
                            </span>
                          </div>
                          <p className="text-slate-800 whitespace-pre-wrap leading-relaxed">
                            {m.body}
                          </p>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 5. Compositor del Operador con Filtro Legal Fail-Closed */}
              <form
                onSubmit={(e) => void enviarMensaje(e)}
                className="bg-white p-4 rounded-xl border border-slate-200 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-emerald-600" />
                    <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                      Responder como Operador (Protegido por Motor Legal)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={insertarPlantillaLegal}
                    className="text-xs font-medium text-emerald-700 hover:text-emerald-600 underline"
                  >
                    Insertar identificación CONDUSEF + CLABE
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {(['whatsapp', 'sms', 'email'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setChannel(c)}
                      className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                        channel === c
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {c === 'whatsapp' ? 'WhatsApp' : c === 'sms' ? 'SMS' : 'Email'}
                    </button>
                  ))}
                </div>

                <textarea
                  rows={3}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Escribe el mensaje al deudor. El Motor Legal verificará razón social, horario, CLABE y lenguaje antes de permitir el envío…"
                  className="w-full rounded-lg border border-slate-300 p-3 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-600"
                  required
                />

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">
                    Si el texto infringe alguna de las 12 reglas CONDUSEF, el envío se bloqueará.
                  </span>
                  <Button
                    type="submit"
                    variant="accent"
                    size="sm"
                    icon={Send}
                    disabled={sending || !replyText.trim()}
                  >
                    {sending ? 'Validando y enviando…' : 'Validar y Enviar'}
                  </Button>
                </div>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
