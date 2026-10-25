import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileCheck,
  FileText,
  HelpCircle,
  Lock,
  Printer,
  Scale,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  api,
  type DebtorLegalDocument,
  type DebtorPortalData,
} from './api';

export function DebtorPortal({
  portalId,
  onBackToDashboard,
}: {
  portalId: string;
  onBackToDashboard?: () => void;
}) {
  const [data, setData] = useState<DebtorPortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Estados de interacción
  const [copiedClabe, setCopiedClabe] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showDocModal, setShowDocModal] = useState(false);
  const [legalDoc, setLegalDoc] = useState<DebtorLegalDocument | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);

  // Formulario de confirmación SPEI
  const [trackingKey, setTrackingKey] = useState('');
  const [bankOrigin, setBankOrigin] = useState('');
  const [payerEmail, setPayerEmail] = useState('');
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [confirmSuccessNotice, setConfirmSuccessNotice] = useState<string | null>(null);

  const cargarPortal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDebtorPortal(portalId);
      setData(res.portal);
    } catch (e: any) {
      setError(
        e?.message ||
          'No se pudo localizar el convenio o enlace de pago. Verifique que el enlace sea correcto.'
      );
    } finally {
      setLoading(false);
    }
  }, [portalId]);

  useEffect(() => {
    void cargarPortal();
  }, [cargarPortal]);

  const copiarClabe = async (clabe: string) => {
    try {
      await navigator.clipboard.writeText(clabe);
      setCopiedClabe(true);
      setTimeout(() => setCopiedClabe(false), 2500);
    } catch {
      // Fallback si navigator.clipboard falla
      const input = document.createElement('input');
      input.value = clabe;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedClabe(true);
      setTimeout(() => setCopiedClabe(false), 2500);
    }
  };

  const copiarReferencia = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 2500);
    } catch {
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 2500);
    }
  };

  const abrirDocumentoLegal = async () => {
    setShowDocModal(true);
    if (!legalDoc) {
      setLoadingDoc(true);
      try {
        const res = await api.getDebtorDocument(portalId);
        setLegalDoc(res.document);
      } catch (err: any) {
        setError(err?.message || 'No se pudo generar el documento legal');
      } finally {
        setLoadingDoc(false);
      }
    }
  };

  const enviarReportePago = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingPayment(true);
    try {
      const res = await api.confirmDebtorPayment(portalId, {
        trackingKey: trackingKey.trim() || undefined,
        bankOrigin: bankOrigin.trim() || undefined,
        payerEmail: payerEmail.trim() || undefined,
      });
      setConfirmSuccessNotice(res.message);
      setShowConfirmModal(false);
      // Recargar estado del portal
      void cargarPortal();
    } catch (err: any) {
      setError(err?.message || 'Error al enviar reporte de pago');
    } finally {
      setSubmittingPayment(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-medium text-slate-600">
          Cargando portal seguro de autoservicio…
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-6 text-center">
          <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 mb-2">Enlace no localizado</h2>
          <p className="text-sm text-slate-600 mb-6">
            {error || 'El convenio de pago ha expirado o no es válido.'}
          </p>
          {onBackToDashboard ? (
            <button
              onClick={onBackToDashboard}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline"
            >
              Volver al panel operativo
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const { debtor, creditor, financials, status, expiresAt } = data;
  const isFulfilled = status === 'fulfilled';
  const isReported = status === 'payment_reported';
  const isExpired = status === 'expired';

  // Formato visual de CLABE en 4 bloques: 6461 8012 3456 7890 12
  const formattedClabe = creditor.clabe.replace(/(\d{4})(\d{4})(\d{4})(\d{4})(\d{2})/, '$1 $2 $3 $4 $5');

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 pb-16">
      {/* Barra superior de confianza y seguridad bancaria */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-emerald-700 text-white rounded-lg flex items-center justify-center font-bold text-sm tracking-wider">
              A
            </div>
            <div>
              <div className="text-xs font-bold text-slate-900 tracking-tight">
                {creditor.razonSocial}
              </div>
              <div className="text-[10px] text-slate-700 flex items-center gap-1 font-mono">
                <ShieldCheck className="w-3 h-3 text-emerald-600" />
                <span>Registro Oficial: {creditor.condusefRegistro}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
              <Lock className="w-3 h-3 text-slate-500" /> Cifrado Bancario 256-bit
            </span>
            {onBackToDashboard ? (
              <button
                onClick={onBackToDashboard}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 border border-slate-200 rounded-md px-2 py-1"
                title="Volver a la consola de cobranza"
              >
                Panel
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {/* Contenido principal */}
      <main className="max-w-2xl mx-auto px-4 pt-6">
        {/* Banner de Aviso de Pago Confirmado */}
        {confirmSuccessNotice ? (
          <div className="mb-6 rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-xs text-emerald-800">
              <div className="font-semibold mb-0.5">Reporte Registrado</div>
              {confirmSuccessNotice}
            </div>
          </div>
        ) : null}

        {/* Estado Superior */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold mb-2 shadow-xs border">
            {isFulfilled ? (
              <span className="bg-emerald-500/10 text-emerald-800 border-emerald-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Cuenta Totalmente Liquidada
              </span>
            ) : isReported ? (
              <span className="bg-amber-500/10 text-amber-800 border-amber-300 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-600" /> Transferencia en Proceso de Conciliación
              </span>
            ) : isExpired ? (
              <span className="bg-rose-500/10 text-rose-800 border-rose-300 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-rose-600" /> Convenio Vencido
              </span>
            ) : (
              <span className="bg-emerald-50 text-emerald-800 border-emerald-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-emerald-600" /> Descuento Autorizado · Pago 1-Click
              </span>
            )}
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
            Portal de Autoservicio de Liquidación
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Titular acreditado:{' '}
            <span className="font-semibold text-slate-700">{debtor.maskedName}</span>
          </p>
        </div>

        {/* Tarjeta de Liquidación Finiquitada (si ya pagó) */}
        {isFulfilled ? (
          <div className="bg-white rounded-2xl border border-emerald-200 shadow-sm p-6 mb-6 text-center">
            <div className="w-14 h-14 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-slate-900 mb-1">
              ¡Felicidades! Su cuenta está en ceros ($0.00 MXN)
            </h2>
            <p className="text-xs text-slate-600 max-w-md mx-auto mb-6">
              El pago ha sido conciliado satisfactoriamente vía SPEI. Conforme a la regulación
              mexicana, su constancia de no adeudo ya se encuentra formalizada.
            </p>

            <button
              onClick={abrirDocumentoLegal}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-xs px-5 py-3 transition-colors shadow-sm"
            >
              <FileCheck className="w-4 h-4" />
              Descargar Carta Finiquito de No Adeudo
            </button>
          </div>
        ) : (
          <>
            {/* Desglose Económico del Convenio */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-6">
              <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-5 sm:p-6">
                <div className="flex items-center justify-between text-xs text-slate-300 mb-2">
                  <span>Monto de Liquidación con Descuento</span>
                  <span className="bg-emerald-500/20 text-emerald-300 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                    Ahorro del {financials.discountPct}%
                  </span>
                </div>
                <div className="flex items-baseline gap-3 mb-2">
                  <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white font-mono">
                    {financials.payableAmountFormatted}
                  </div>
                  <div className="text-sm sm:text-base text-slate-400 line-through">
                    {financials.originalAmountFormatted}
                  </div>
                </div>
                <div className="text-xs text-emerald-400 flex items-center gap-1 font-medium">
                  <Check className="w-3.5 h-3.5" />
                  Usted ahorra {financials.discountAmountFormatted} pagando antes del vencimiento.
                </div>
              </div>

              <div className="p-4 sm:p-5 bg-slate-50/50 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <div className="text-slate-500">Saldo Original</div>
                  <div className="font-semibold text-slate-700">
                    {financials.originalAmountFormatted}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Quita Condonada</div>
                  <div className="font-semibold text-emerald-600">
                    -{financials.discountAmountFormatted}
                  </div>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <div className="text-slate-500">Vigencia Límite</div>
                  <div className="font-semibold text-slate-700">
                    {new Date(expiresAt).toLocaleDateString('es-MX', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Tarjeta de Pago 1-Click SPEI */}
            <div className="bg-white rounded-2xl border-2 border-emerald-600/30 shadow-md p-5 sm:p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center font-bold">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Transferencia Interbancaria (SPEI)
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Liquidación inmediata sin comisiones desde cualquier app bancaria
                    </p>
                  </div>
                </div>
                <span className="hidden sm:inline-block text-[11px] font-semibold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded">
                  1-Click Copy
                </span>
              </div>

              {/* Caja de CLABE */}
              <div className="bg-slate-900 text-white rounded-xl p-4 mb-4">
                <div className="text-[11px] text-slate-400 mb-1 flex items-center justify-between">
                  <span>CLABE Interbancaria Única (18 dígitos)</span>
                  <span className="text-[10px] text-slate-400">Banco: {creditor.bankName}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-base sm:text-lg font-bold tracking-wider text-emerald-400 select-all overflow-x-auto">
                    {formattedClabe}
                  </div>
                  <button
                    onClick={() => void copiarClabe(creditor.clabe)}
                    className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-3.5 py-2 transition-all flex items-center gap-1.5 shadow-sm active:scale-95"
                    title="Copiar CLABE al portapapeles"
                  >
                    {copiedClabe ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-white" />
                        <span>¡Copiada!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copiar CLABE</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Detalles para transferir */}
              <div className="space-y-2.5 text-xs bg-slate-50 rounded-xl p-3.5 border border-slate-200 mb-5">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Banco Receptor:</span>
                  <span className="font-semibold text-slate-800">{creditor.bankName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Beneficiario:</span>
                  <span className="font-semibold text-slate-800 text-right truncate max-w-[240px]">
                    {creditor.razonSocial}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Concepto / Referencia:</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-slate-900">
                      {financials.paymentReference}
                    </span>
                    <button
                      onClick={() => void copiarReferencia(financials.paymentReference)}
                      className="text-slate-400 hover:text-slate-700"
                      title="Copiar referencia"
                    >
                      {copiedRef ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Botones de Acción */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => setShowConfirmModal(true)}
                  className="rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs py-3 px-4 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Ya realicé mi transferencia SPEI
                </button>
                <button
                  onClick={abrirDocumentoLegal}
                  className="rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold text-xs py-3 px-4 transition-colors flex items-center justify-center gap-2"
                >
                  <FileText className="w-4 h-4 text-slate-500" />
                  Descargar Carta Convenio (PDF)
                </button>
              </div>
            </div>
          </>
        )}

        {/* Pasos rápidos para pagar en App Bancaria */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6">
          <h4 className="text-xs font-bold text-slate-900 mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <HelpCircle className="w-4 h-4 text-emerald-600" /> ¿Cómo pagar desde tu aplicación móvil?
          </h4>
          <ol className="space-y-2.5 text-xs text-slate-600 list-decimal list-inside">
            <li>
              Abre tu aplicación bancaria (BBVA, Santander, Nu, Azteca, Banorte, Hey Banco, etc.).
            </li>
            <li>
              Selecciona <strong>Transferir</strong> o <strong>Nuevo Destinatario</strong>.
            </li>
            <li>
              Pega la <strong>CLABE de 18 dígitos</strong> copiada arriba y verifica que el banco sea{' '}
              <strong>{creditor.bankName}</strong>.
            </li>
            <li>
              Ingresa el monto exacto:{' '}
              <strong className="text-slate-900 font-mono">
                {financials.payableAmountFormatted}
              </strong>
              .
            </li>
            <li>
              Escribe en el concepto:{' '}
              <strong className="text-slate-900 font-mono">{financials.paymentReference}</strong>.
            </li>
            <li>
              Confirma la transferencia y pulsa el botón{' '}
              <strong>"Ya realicé mi transferencia"</strong>.
            </li>
          </ol>
        </div>

        {/* Blindaje Legal y Garantías CONDUSEF */}
        <div className="rounded-xl bg-slate-100 p-4 border border-slate-200 text-slate-600 text-[11px] space-y-2 leading-relaxed">
          <div className="flex items-center gap-1.5 font-bold text-slate-800">
            <Scale className="w-3.5 h-3.5 text-slate-700" /> Marco Legal y Protección al Consumidor
          </div>
          <p>{data.legalNotice}</p>
          <div className="pt-2 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-700">
            <span>Acreedor: {creditor.razonSocial}</span>
            <span>Registro CONDUSEF REDECO: {creditor.condusefRegistro}</span>
            <span>Actualización SIC (Buró/Círculo): Máx. 5 días hábiles</span>
          </div>
        </div>
      </main>

      {/* Modal: Confirmar Transferencia SPEI Realizada */}
      {showConfirmModal ? (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 relative animate-in fade-in zoom-in-95 duration-150">
            <button
              onClick={() => setShowConfirmModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1 rounded-md"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-slate-900 mb-1">
              Confirmar Reporte de Transferencia SPEI
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Nuestro motor bancario verificará los fondos recibidos en la cuenta CLABE. Puede
              proporcionar los datos de su comprobante para acelerar la emisión de su Carta
              Finiquito.
            </p>

            <form onSubmit={enviarReportePago} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Clave de Rastreo SPEI o Folio Bancario (opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ej: 20261025000012345678"
                  value={trackingKey}
                  onChange={(e) => setTrackingKey(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Banco Emisor (desde donde transfirió)
                </label>
                <input
                  type="text"
                  placeholder="Ej: BBVA, Banorte, Nu, Santander..."
                  value={bankOrigin}
                  onChange={(e) => setBankOrigin(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">
                  Correo electrónico para recibir Carta Finiquito
                </label>
                <input
                  type="email"
                  placeholder="su-correo@ejemplo.com"
                  value={payerEmail}
                  onChange={(e) => setPayerEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowConfirmModal(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submittingPayment}
                  className="rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold px-4 py-2 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {submittingPayment ? 'Enviando…' : 'Enviar Confirmación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Modal: Carta Convenio / Carta Finiquito Oficial Imprimible */}
      {showDocModal ? (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl border border-slate-200 relative my-8 text-slate-900">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 mb-6">
              <div className="flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-emerald-700" />
                <span className="font-bold text-sm text-slate-900">
                  Documento Legal Oficial · CONDUSEF
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-1.5 flex items-center gap-1"
                >
                  <Printer className="w-3.5 h-3.5" /> Imprimir
                </button>
                <button
                  onClick={() => setShowDocModal(false)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {loadingDoc || !legalDoc ? (
              <div className="py-12 text-center text-xs text-slate-500">
                Generando documento oficial autenticado…
              </div>
            ) : (
              <div className="space-y-4 text-xs font-serif leading-relaxed text-slate-800">
                <div className="text-center pb-4 border-b border-slate-200">
                  <div className="font-bold text-sm tracking-wide text-slate-900 uppercase">
                    {legalDoc.razonSocial}
                  </div>
                  <div className="text-[11px] text-slate-600 font-sans">
                    Entidad Financiera Regulada · Registro CONDUSEF: {legalDoc.condusefRegistro}
                  </div>
                  <div className="text-base font-sans font-extrabold text-slate-900 mt-3 uppercase tracking-tight">
                    {legalDoc.tipoDocumento === 'carta_finiquito'
                      ? 'CARTA FINIQUITO Y CONSTANCIA DE NO ADEUDO'
                      : 'CONVENIO DE LIQUIDACIÓN Y EXTINCIÓN DE OBLIGACIÓN'}
                  </div>
                  <div className="text-[11px] font-sans text-slate-500 mt-1">
                    Folio Oficial: <span className="font-mono font-bold">{legalDoc.folio}</span> ·{' '}
                    {legalDoc.fechaEmision}
                  </div>
                </div>

                <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200 font-sans text-[11px] grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-slate-500">Acreditado / Titular:</span>{' '}
                    <span className="font-semibold text-slate-900">{legalDoc.deudorNombre}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Monto Original:</span>{' '}
                    <span className="font-semibold text-slate-900">{legalDoc.montoOriginal}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Descuento Autorizado:</span>{' '}
                    <span className="font-semibold text-emerald-700">{legalDoc.descuento}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Monto Único a Liquidar:</span>{' '}
                    <span className="font-semibold text-slate-900 font-mono">
                      {legalDoc.montoLiquidar}
                    </span>
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  {legalDoc.clausulas.map((clausula, idx) => (
                    <p key={idx} className="text-justify text-slate-700">
                      {clausula}
                    </p>
                  ))}
                </div>

                <div className="pt-6 border-t border-slate-200 font-sans text-[10px] text-slate-500 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-700">Sello Digital de Autenticidad:</div>
                    <div className="font-mono text-slate-500">{legalDoc.selloDigital}</div>
                  </div>
                  <div className="text-right text-emerald-700 font-semibold flex items-center gap-1">
                    <ShieldCheck className="w-4 h-4" /> Emitido conforme a la NOM-184 y REDECO
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
