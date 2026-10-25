import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Gauge,
  Mic,
  MicOff,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  Send,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react';
import { Alert, Button, ChannelBadge, StatusBadge } from '@ds';
import { api, ApiError, type CaseWorkspace, type Nom151Certificate } from './api';
import { Nom151Modal } from './Nom151Modal';

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
  canOperate = true,
  onClose,
  onUpdated,
}: {
  caseId: string | null;
  canOperate?: boolean;
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
  const [callControlId, setCallControlId] = useState<string | null>(null);
  const [callDialMode, setCallDialMode] = useState<'telnyx' | 'telnyx_ai' | 'mock'>('telnyx');
  const [transferTarget, setTransferTarget] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [callNotes, setCallNotes] = useState('');
  const [callOutcome, setCallOutcome] = useState<'promesa' | 'aclaracion' | 'buzon' | 'contactado'>(
    'contactado'
  );
  const [callingBusy, setCallingBusy] = useState(false);

  // Notas internas del operador (estilo Payments by Wix) y conciliación Cobre SPEI
  const [manualNote, setManualNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [simulatingSpei, setSimulatingSpei] = useState(false);

  // Vinculación CFDI SAT (contract_cfdi)
  const [cfdiInput, setCfdiInput] = useState('');
  const [savingCfdi, setSavingCfdi] = useState(false);

  // Constancias Digitales NOM-151-SCFI-2016
  const [nomCertificates, setNomCertificates] = useState<Nom151Certificate[]>([]);
  const [selectedNomFolio, setSelectedNomFolio] = useState<string | null>(null);
  const [certifyWithNom151, setCertifyWithNom151] = useState(true);
  const [issuingManualNom, setIssuingManualNom] = useState(false);

  const cargarNom151 = useCallback(async (id: string) => {
    try {
      const res = await api.getCaseNom151Certificates(id);
      setNomCertificates(res.certificates);
    } catch {
      // Sin constancias
    }
  }, []);

  const cargarFicha = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const [data] = await Promise.all([
        api.caseWorkspace(id),
        cargarNom151(id),
      ]);
      setWs(data);
      setPromisePesos(String(Math.round(data.case.amount_cents / 100)));
      setCfdiInput(data.cfdi_uuid ?? data.contract?.cfdi_uuid ?? '');
      const enabled = data.legal.enabled_channels ?? ['whatsapp', 'sms', 'email'];
      if (enabled.length > 0) {
        setChannel((prev) => (enabled.includes(prev) ? prev : enabled[0]!));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el expediente');
    } finally {
      setLoading(false);
    }
  }, [cargarNom151]);

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

  const insertarEnlacePortal = () => {
    if (!ws) return;
    const portalUrl = `${window.location.origin}/pay/${ws.case.id}`;
    setReplyText((prev) =>
      prev
        ? `${prev} Puede consultar su descuento y liquidar en 1-click SPEI aquí: ${portalUrl}`
        : `Consulte su descuento y liquide en 1-click SPEI aquí: ${portalUrl}`
    );
  };

  const certificarNotificacionManual = async () => {
    if (!ws) return;
    setIssuingManualNom(true);
    setError(null);
    try {
      const razon = ws.contract?.nombre_legal || ws.legal.nombre_legal || 'Despacho Autorizado';
      const condusef = ws.contract?.condusef || ws.legal.condusef || 'REDECO';
      const clabe = ws.contract?.clabe ? ` CLABE: ${ws.contract.clabe}.` : '';
      const monto = formatMXN(ws.case.amount_cents);
      const texto = `REQUERIMIENTO FORMAL DE PAGO: Estimado(a) ${ws.case.name}, le contactamos de ${razon} (Registro CONDUSEF ${condusef}) en seguimiento a su saldo pendiente por ${monto}.${clabe} Notificación formal emitida conforme al Código de Comercio y la NOM-151-SCFI-2016.`;

      const res = await api.issueCaseNom151Certificate(ws.case.id, {
        clientId: ws.case.client_id,
        tipoNotificacion: 'requerimiento_pago',
        channel,
        messageContent: texto,
      });

      setNotice(`Constancia NOM-151 emitida con éxito. Folio: ${res.certificate.certificateFolio}`);
      await cargarNom151(ws.case.id);
      setSelectedNomFolio(res.certificate.certificateFolio);
    } catch (err: any) {
      setError(err?.message || 'No se pudo emitir la constancia NOM-151');
    } finally {
      setIssuingManualNom(false);
    }
  };

  const enviarMensaje = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws || !replyText.trim()) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.replyCase(ws.case.id, { channel, body: replyText.trim() });
      if (certifyWithNom151) {
        try {
          await api.issueCaseNom151Certificate(ws.case.id, {
            clientId: ws.case.client_id,
            tipoNotificacion: 'aviso_cobranza',
            channel,
            messageContent: res.message?.body || replyText.trim(),
            messageId: res.message?.id,
            providerId: res.message?.provider_id || undefined,
          });
          void cargarNom151(ws.case.id);
        } catch {
          // Si falla emisión secundaria de constancia, el mensaje principal ya fue enviado
        }
      }
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
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          mediaStreamRef.current = stream;
        } catch {
          // Si el operador rechaza o no tiene micro, continúa con la línea
        }
      }

      const res = await api.callCase(ws.case.id, {
        phase: 'start',
        dial: callDialMode === 'telnyx',
        mode: callDialMode,
      });
      setCallScript(res.guion_obligatorio ?? null);
      setCallControlId(res.call_control_id ?? null);
      setCallSeconds(0);
      setCallMuted(false);
      setCallActive(true);
      setShowTransfer(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Llamada bloqueada por el Motor Legal');
    } finally {
      setCallingBusy(false);
    }
  };

  const toggleMute = () => {
    setCallMuted((prev) => {
      const next = !prev;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !next;
        });
      }
      return next;
    });
  };

  const finalizarLlamada = async () => {
    if (!ws) return;
    setCallingBusy(true);
    setError(null);
    try {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      await api.callCase(ws.case.id, {
        phase: 'complete',
        duration_seconds: callSeconds,
        outcome: callOutcome,
        notes: callNotes,
      });
      setCallActive(false);
      setCallControlId(null);
      setCallNotes('');
      setShowTransfer(false);
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

  const transferirLlamada = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws || !callControlId || !transferTarget.trim()) return;
    setTransferring(true);
    setError(null);
    try {
      const res = await api.transferCall(ws.case.id, {
        call_control_id: callControlId,
        to: transferTarget.trim(),
      });
      if (res.ok) {
        setNotice(`Llamada transferida a ${transferTarget.trim()} con éxito.`);
        setShowTransfer(false);
        setTransferTarget('');
      } else {
        setError(res.error ?? 'No se pudo transferir la llamada');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al transferir llamada');
    } finally {
      setTransferring(false);
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

  const guardarCfdiUuid = async (uuidOverride?: string) => {
    if (!ws) return;
    const targetUuid = (uuidOverride ?? cfdiInput).trim();
    if (!targetUuid) return;
    setSavingCfdi(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateCaseCfdi(ws.case.id, targetUuid);
      setCfdiInput(res.cfdi_uuid);
      setNotice(`CFDI SAT (${res.cfdi_uuid}) vinculado al contrato y listo para póliza Alegra.`);
      await cargarFicha(ws.case.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo vincular el UUID de CFDI');
    } finally {
      setSavingCfdi(false);
    }
  };

  const generarCfdiDemo = () => {
    const hex = (len: number) =>
      Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16))
        .join('')
        .toUpperCase();
    const uuid = `${hex(8)}-${hex(4)}-4${hex(3)}-A${hex(3)}-${hex(12)}`;
    setCfdiInput(uuid);
    void guardarCfdiUuid(uuid);
  };

  const enabledChannels = ws?.legal.enabled_channels ?? ['whatsapp', 'sms', 'email'];

  const score = ws?.case.score ?? 50;
  const scoreTone =
    score >= 70
      ? {
          bar: 'bg-emerald-500',
          text: 'text-emerald-700',
          pill: 'bg-emerald-100 text-emerald-800 border-emerald-200',
          label: 'Alta Propensión',
          hint: 'Prioridad alta · Resolución ágil',
        }
      : score >= 40
        ? {
            bar: 'bg-amber-500',
            text: 'text-amber-700',
            pill: 'bg-amber-100 text-amber-800 border-amber-200',
            label: 'Media Propensión',
            hint: 'Proponer facilidades de pago',
          }
        : {
            bar: 'bg-rose-500',
            text: 'text-rose-700',
            pill: 'bg-rose-100 text-rose-800 border-rose-200',
            label: 'Baja Propensión',
            hint: 'Alto riesgo · Proceder con cautela',
          };

  const contactosHoy = ws?.contactos_24h ?? 0;
  const maxContactos = ws?.legal.max_contactos_24h ?? 3;
  const limiteAlcanzado = contactosHoy >= maxContactos;
  const limiteCercano = contactosHoy === maxContactos - 1 && !limiteAlcanzado;

  const semaforoTone = limiteAlcanzado
    ? {
        pill: 'bg-rose-100 text-rose-800 border-rose-200',
        label: 'BLOQUEADO',
        desc: 'Límite diario NOM-184 alcanzado (3/3)',
      }
    : limiteCercano
      ? {
          pill: 'bg-amber-100 text-amber-800 border-amber-200',
          label: 'ÚLTIMO INTENTO',
          desc: '1 contacto restante antes de bloqueo legal',
        }
      : {
          pill: 'bg-emerald-100 text-emerald-800 border-emerald-200',
          label: 'DISPONIBLE',
          desc: `${maxContactos - contactosHoy} de ${maxContactos} contactos disponibles`,
        };

  const simularSpeiGateway = async (provider: 'cobre' | 'conekta') => {
    if (!ws) return;
    setSimulatingSpei(true);
    setError(null);
    setNotice(null);
    try {
      const suffix = Date.now().toString().slice(-8);
      if (provider === 'cobre') {
        const tracking = `COBRE${suffix}`;
        await api.reconcileCobreSpei({
          clabe: ws.contract?.clabe ?? null,
          reference: ws.case.id,
          amount_cents: ws.case.amount_cents,
          tracking_key: tracking,
        });
        setNotice(
          `Cash-In SPEI conciliado vía Cobre Enterprise (Rastreo ${tracking}). Deuda liquidada.`
        );
      } else {
        const orderId = `ord_cnk_${suffix}`;
        await api.reconcileConektaSpei({
          clabe: ws.contract?.clabe ?? null,
          case_id: ws.case.id,
          amount_cents: ws.case.amount_cents,
          order_id: orderId,
        });
        setNotice(
          `Evento order.paid conciliado vía Conekta SPEI (Orden ${orderId}). Deuda liquidada.`
        );
      }
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
              {!canOperate ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 flex items-center justify-between">
                  <span>
                    <strong>Modo Auditor (Sólo Lectura):</strong> Puedes inspeccionar el expediente,
                    contrato, CFDI y trazabilidad legal. Las acciones de contacto y resolución están
                    reservadas para Operadores y Managers.
                  </span>
                </div>
              ) : null}

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

                    {ws.case.status !== 'paid' && canOperate ? (
                      <div className="flex flex-col gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={simulatingSpei}
                          onClick={() => void simularSpeiGateway('cobre')}
                          className="rounded-lg border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 transition-colors disabled:opacity-50"
                          title="Simular webhook SPEI de Cobre (Enterprise) sobre la CLABE de este contrato"
                        >
                          {simulatingSpei ? 'Conciliando…' : '⚡ SPEI Cobre'}
                        </button>
                        <button
                          type="button"
                          disabled={simulatingSpei}
                          onClick={() => void simularSpeiGateway('conekta')}
                          className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
                          title="Simular webhook order.paid de Conekta (PyME / Mid-Market) sobre la CLABE de este contrato"
                        >
                          ⚡ SPEI Conekta
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* Espacio de Notas Internas Manuales (lo que la IA pasó por alto) */}
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    {canOperate ? (
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
                    ) : null}

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

              {/* 1. Ficha Financiera, Scoring Sherman v2 y Semáforo NOM-184 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Saldo Exigible y CLABE */}
                <div className="bg-white p-3.5 rounded-lg border border-slate-200 flex flex-col justify-between">
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                      Saldo Exigible
                    </div>
                    <div className="text-xl font-bold text-slate-900 data-mono mt-0.5">
                      {formatMXN(ws.case.amount_cents)}
                    </div>
                  </div>
                  <div className="pt-2 mt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                    <div className="text-slate-500 data-mono truncate">
                      CLABE:{' '}
                      <span className="font-semibold text-slate-700">
                        {ws.contract?.clabe || 'Sin contrato'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => window.open(`/pay/${ws.case.id}`, '_blank')}
                      className="text-[10px] text-emerald-700 hover:text-emerald-900 font-semibold underline shrink-0 ml-1"
                      title="Abrir portal de autoservicio del deudor con checkout SPEI"
                    >
                      Ver Portal SPEI ↗
                    </button>
                  </div>
                </div>

                {/* Score Sherman v2 (Propensión IA) */}
                <div className="bg-white p-3.5 rounded-lg border border-slate-200 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                        <Gauge className="w-3.5 h-3.5 text-slate-400" />
                        Sherman v2
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.2 text-[10px] font-semibold border ${scoreTone.pill}`}
                      >
                        {scoreTone.label}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-1 mt-0.5">
                      <span className="text-xl font-bold text-slate-900 data-mono">{score}</span>
                      <span className="text-xs text-slate-400 font-mono">/ 100</span>
                    </div>
                  </div>
                  <div className="pt-2 mt-2 border-t border-slate-100 space-y-1">
                    <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${scoreTone.bar}`}
                        style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">{scoreTone.hint}</div>
                  </div>
                </div>

                {/* Semáforo NOM-184 (Contactos en 24h) */}
                <div
                  className={`p-3.5 rounded-lg border flex flex-col justify-between transition-colors ${
                    limiteAlcanzado
                      ? 'bg-rose-50/50 border-rose-200'
                      : limiteCercano
                        ? 'bg-amber-50/40 border-amber-200'
                        : 'bg-white border-slate-200'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        NOM-184 (24h)
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.2 text-[10px] font-semibold border ${semaforoTone.pill}`}
                      >
                        {semaforoTone.label}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span
                        className={`text-xl font-bold data-mono ${
                          limiteAlcanzado
                            ? 'text-rose-700'
                            : limiteCercano
                              ? 'text-amber-700'
                              : 'text-slate-900'
                        }`}
                      >
                        {contactosHoy} / {maxContactos}
                      </span>
                      <span className="text-[11px] text-slate-500">contactos hoy</span>
                    </div>
                  </div>
                  <div className="pt-2 mt-2 border-t border-slate-100 space-y-1">
                    <div className="flex items-center gap-1.5">
                      {Array.from({ length: maxContactos }).map((_, i) => (
                        <div
                          key={i}
                          className={`h-1.5 flex-1 rounded-full transition-colors ${
                            i < contactosHoy
                              ? limiteAlcanzado
                                ? 'bg-rose-500'
                                : limiteCercano
                                  ? 'bg-amber-500'
                                  : 'bg-emerald-500'
                              : 'bg-slate-200'
                          }`}
                        />
                      ))}
                    </div>
                    <div
                      className={`text-[10px] truncate font-medium ${
                        limiteAlcanzado
                          ? 'text-rose-700'
                          : limiteCercano
                            ? 'text-amber-800'
                            : 'text-slate-500'
                      }`}
                    >
                      {semaforoTone.desc}
                    </div>
                  </div>
                </div>
              </div>

              {/* 1b. Trazabilidad Fiscal CFDI SAT -> Alegra (contract_cfdi) */}
              <div className="bg-white p-3.5 rounded-lg border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                    <span>UUID CFDI Timbrado (SAT · Póliza Alegra)</span>
                    {ws.cfdi_uuid || ws.contract?.cfdi_uuid ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-mono text-emerald-800">
                        VINCULADO
                      </span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600">
                        SIN TIMBRAR
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-slate-700 mt-0.5 truncate">
                    {ws.cfdi_uuid || ws.contract?.cfdi_uuid || 'Provisión sin CFDI adjunto'}
                  </div>
                </div>

                {canOperate ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="text"
                      value={cfdiInput}
                      onChange={(e) => setCfdiInput(e.target.value)}
                      placeholder="UUID SAT (8-4-4-4-12)"
                      className="w-48 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-mono text-slate-900 focus:bg-white"
                    />
                    <button
                      type="button"
                      disabled={savingCfdi || !cfdiInput.trim()}
                      onClick={() => void guardarCfdiUuid()}
                      className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {savingCfdi ? '…' : 'Vincular'}
                    </button>
                    <button
                      type="button"
                      disabled={savingCfdi}
                      onClick={generarCfdiDemo}
                      className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                      title="Generar y vincular UUID fiscal sintético para prueba contable"
                    >
                      UUID Demo
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Alerta de Límite NOM-184 si se alcanzaron los 3 contactos */}
              {limiteAlcanzado ? (
                <div className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-950 flex items-start gap-2.5 shadow-sm">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-bold text-rose-900">
                      Límite Diario NOM-184 Alcanzado ({contactosHoy}/{maxContactos} contactos en
                      24h)
                    </div>
                    <p className="mt-0.5 text-rose-800 leading-relaxed text-[11px]">
                      Este deudor ya completó los {maxContactos} contactos permitidos en 24 horas
                      por la NOM-184 y la Regla 8.1 CONDUSEF. El Softphone y el envío de mensajes
                      están bloqueados preventivamente para proteger al despacho de sanciones
                      regulatorias.
                    </p>
                  </div>
                </div>
              ) : null}

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
                    <div className="flex items-center gap-2">
                      <select
                        value={callDialMode}
                        onChange={(e) =>
                          setCallDialMode(e.target.value as 'telnyx' | 'telnyx_ai' | 'mock')
                        }
                        disabled={callingBusy || limiteAlcanzado}
                        className="rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                        title="Modo de llamada telefónica"
                      >
                        <option value="telnyx">Telnyx PSTN (Humano)</option>
                        <option value="telnyx_ai">Telnyx Voice AI (Autónomo)</option>
                        <option value="mock">Línea Directa</option>
                      </select>
                      <Button
                        variant={limiteAlcanzado ? 'secondary' : 'accent'}
                        size="sm"
                        icon={PhoneCall}
                        disabled={
                          !canOperate ||
                          callingBusy ||
                          Boolean(ws.client?.do_not_disturb) ||
                          limiteAlcanzado
                        }
                        onClick={() => void iniciarLlamada()}
                        title={
                          limiteAlcanzado
                            ? 'Bloqueado: se alcanzó el límite diario de 3 contactos en 24h (NOM-184)'
                            : undefined
                        }
                      >
                        {callingBusy
                          ? 'Conectando…'
                          : limiteAlcanzado
                            ? 'Límite alcanzado'
                            : callDialMode === 'telnyx_ai'
                              ? 'Lanzar Voice AI'
                              : 'Llamar ahora'}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded bg-slate-800 text-emerald-400 text-xs font-semibold data-mono border border-slate-700">
                        ● {formatDuration(callSeconds)}
                      </span>
                      {callControlId ? (
                        <span className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-emerald-950/80 text-[10px] font-mono text-emerald-400 border border-emerald-800">
                          {callDialMode === 'telnyx_ai' ? 'Telnyx Voice AI' : 'Telnyx PSTN'}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={toggleMute}
                        className={`p-2 rounded-md border text-xs ${
                          callMuted
                            ? 'bg-amber-600 border-amber-500 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                        }`}
                        title={callMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
                      >
                        {callMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>
                      {callControlId ? (
                        <button
                          type="button"
                          onClick={() => setShowTransfer((s) => !s)}
                          className="p-2 rounded-md border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
                          title="Transferir llamada a otro agente o supervisor"
                        >
                          <PhoneForwarded className="w-4 h-4" />
                        </button>
                      ) : null}
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

                    {showTransfer && callControlId ? (
                      <form
                        onSubmit={transferirLlamada}
                        className="bg-slate-950 p-3 rounded-lg border border-slate-700 space-y-2"
                      >
                        <div className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                          <span>Transferir llamada activa (Call Bridging)</span>
                          <button
                            type="button"
                            onClick={() => setShowTransfer(false)}
                            className="text-slate-400 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={transferTarget}
                            onChange={(e) => setTransferTarget(e.target.value)}
                            placeholder="Número (+52...) o extensión SIP"
                            className="flex-1 rounded bg-slate-900 border border-slate-700 px-2.5 py-1 text-xs text-white"
                          />
                          <button
                            type="submit"
                            disabled={transferring || !transferTarget.trim()}
                            className="rounded bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 text-xs font-medium disabled:opacity-50"
                          >
                            {transferring ? 'Transfiriendo…' : 'Transferir'}
                          </button>
                        </div>
                      </form>
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
              {canOperate ? (
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
              ) : null}

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

              {/* 5. Constancias Digitales NOM-151-SCFI-2016 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                      Constancias Digitales NOM-151 ({nomCertificates.length})
                    </h3>
                  </div>
                  <button
                    type="button"
                    disabled={issuingManualNom}
                    onClick={() => void certificarNotificacionManual()}
                    className="rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-800 hover:bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50"
                    title="Emitir constancia formal con estampado criptográfico SHA-256 según la NOM-151-SCFI-2016"
                  >
                    {issuingManualNom ? 'Certificando…' : '+ Certificar Notificación'}
                  </button>
                </div>

                <div className="p-3">
                  {nomCertificates.length === 0 ? (
                    <div className="text-center py-4 text-xs text-slate-500">
                      No hay constancias NOM-151 emitidas todavía. Pulse "+ Certificar Notificación"
                      para emitir una constancia formal con valor probatorio pleno ante tribunales y CONDUSEF.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                      {nomCertificates.map((cert) => (
                        <div
                          key={cert.id}
                          className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 bg-slate-50/60 hover:bg-slate-50 text-xs"
                        >
                          <div>
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="font-mono font-bold text-slate-900">
                                {cert.certificateFolio}
                              </span>
                              <span className="rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold px-1.5 py-0.2 uppercase">
                                {cert.tipoNotificacion.replace(/_/g, ' ')}
                              </span>
                              <span className="text-[10px] text-slate-400 capitalize">
                                {cert.channel}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono truncate max-w-sm">
                              SHA-256: {cert.messageDigestSha256.slice(0, 16)}… · {cert.timestampLocal.slice(0, 16)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedNomFolio(cert.certificateFolio)}
                            className="rounded-md border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 px-2.5 py-1 font-semibold text-[11px] shrink-0 ml-2"
                          >
                            Ver Acta ↗
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 6. Compositor del Operador con Filtro Legal Fail-Closed */}
              {canOperate ? (
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
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={insertarPlantillaLegal}
                        className="text-xs font-medium text-emerald-700 hover:text-emerald-600 underline"
                      >
                        Insertar identificación CONDUSEF + CLABE
                      </button>
                      <button
                        type="button"
                        onClick={insertarEnlacePortal}
                        className="text-xs font-medium text-emerald-700 hover:text-emerald-600 underline"
                      >
                        Insertar Enlace 1-Click SPEI
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {(['whatsapp', 'sms', 'email'] as const).map((c) => {
                        const isChannelEnabled = enabledChannels.includes(c);
                        const label = c === 'whatsapp' ? 'WhatsApp' : c === 'sms' ? 'SMS' : 'Email';
                        return (
                          <button
                            key={c}
                            type="button"
                            disabled={!isChannelEnabled}
                            onClick={() => isChannelEnabled && setChannel(c)}
                            title={
                              isChannelEnabled
                                ? `Enviar por ${label}`
                                : `Canal ${label} deshabilitado por el Manager del despacho`
                            }
                            className={`px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                              !isChannelEnabled
                                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed line-through'
                                : channel === c
                                  ? 'bg-slate-900 text-white border-slate-900'
                                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            {label}
                            {!isChannelEnabled ? ' (Off)' : ''}
                          </button>
                        );
                      })}
                    </div>

                    <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={certifyWithNom151}
                        onChange={(e) => setCertifyWithNom151(e.target.checked)}
                        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>Certificar con NOM-151</span>
                    </label>
                  </div>

                  <textarea
                    rows={3}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Escribe el mensaje al deudor. El Motor Legal verificará razón social, horario, CLABE y lenguaje antes de permitir el envío…"
                    className="w-full rounded-lg border border-slate-300 p-3 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-600"
                    required
                  />

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500">
                      {limiteAlcanzado
                        ? '⚠️ Límite NOM-184 alcanzado (3/3): no se pueden enviar más mensajes hoy.'
                        : 'Si el texto infringe alguna de las 12 reglas CONDUSEF, el envío se bloqueará.'}
                    </span>
                    <Button
                      type="submit"
                      variant={limiteAlcanzado ? 'secondary' : 'accent'}
                      size="sm"
                      icon={Send}
                      disabled={sending || !replyText.trim() || limiteAlcanzado}
                      title={
                        limiteAlcanzado
                          ? 'Bloqueado: se alcanzó el límite diario de 3 contactos en 24h (NOM-184)'
                          : undefined
                      }
                    >
                      {sending
                        ? 'Validando y enviando…'
                        : limiteAlcanzado
                          ? 'Límite alcanzado'
                          : 'Validar y Enviar'}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {selectedNomFolio ? (
        <Nom151Modal
          folio={selectedNomFolio}
          onClose={() => setSelectedNomFolio(null)}
        />
      ) : null}
    </div>
  );
}
