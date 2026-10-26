import React, { useState, useEffect, useCallback } from 'react';
import { api, JudicialDocketData, HermesJob } from './api';
import {
  Scale,
  FileText,
  Printer,
  Copy,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Building,
  User,
  DollarSign,
  Clock,
  X,
  Lock,
  Cpu,
  Sparkles,
} from 'lucide-react';

interface JudicialDocketModalProps {
  caseId: string;
  onClose: () => void;
}

export const JudicialDocketModal: React.FC<JudicialDocketModalProps> = ({ caseId, onClose }) => {
  const [docket, setDocket] = useState<JudicialDocketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  // Estados de Hermes Forensics (Plano 2 · MicroVMs en Sandboxes)
  const [hermesJobs, setHermesJobs] = useState<HermesJob[]>([]);
  const [hermesLoading, setHermesLoading] = useState(false);
  const [hermesActionMsg, setHermesActionMsg] = useState<string | null>(null);

  const loadHermesJobs = useCallback(() => {
    api
      .listHermesJobsForCase(caseId)
      .then((res) => {
        if (res.ok && res.jobs) {
          setHermesJobs(res.jobs);
        }
      })
      .catch(() => {});
  }, [caseId]);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    api
      .getCaseJudicialDocket(caseId)
      .then((res) => {
        if (isMounted) {
          if (res.success && res.docket) {
            setDocket(res.docket);
          } else {
            setError('No se pudo generar el expediente judicial del caso.');
          }
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Error cargando expediente judicial.');
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    loadHermesJobs();

    return () => {
      isMounted = false;
    };
  }, [caseId, loadHermesJobs]);

  const handleCopyHash = (hash?: string) => {
    const textToCopy = hash || docket?.custodiaWorm.hashExpedienteSha256;
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2500);
  };

  const handleOpenPrintable = () => {
    const url = `/api/v1/nom151/cases/${encodeURIComponent(caseId)}/docket/printable`;
    window.open(url, '_blank');
  };

  const handleTriggerHermes = async (
    taskType: 'sat_materiality' | 'skip_trace' | 'judicial_synthesis'
  ) => {
    setHermesLoading(true);
    setHermesActionMsg(null);
    try {
      let res;
      if (taskType === 'skip_trace' && docket?.demandado.clientId) {
        res = await api.requestHermesSkipTrace(docket.demandado.clientId, caseId);
      } else if (taskType === 'sat_materiality') {
        res = await api.requestHermesForensics(caseId);
      } else {
        res = await api.requestHermesDocketSynthesis(caseId);
      }

      if (res.ok) {
        setHermesActionMsg(`✓ Peritaje ${taskType} completado con custodia WORM.`);
        loadHermesJobs();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setHermesActionMsg(`Error ejecutando peritaje: ${msg}`);
    } finally {
      setHermesLoading(false);
    }
  };

  const latestHermesJob = hermesJobs[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-5xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in duration-200">
        {/* Cabecera Principal */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Scale className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-100">
                  Cuaderno de Pruebas Judiciales & Materialidad SAT
                </h3>
                {docket && (
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-blue-950/60 text-blue-400 border border-blue-800/40">
                    {docket.folioExpediente}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                Prueba Plena Mercantil (CCom Art. 1298-A) · Custodia WORM 10 años (Art. 49) · CFF
                Arts. 29-A y 69-B
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Botón Destacado: Solicitar Peritaje Hermes SAT / Skip-Tracing */}
            <button
              onClick={() => handleTriggerHermes('sat_materiality')}
              disabled={hermesLoading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-md transition-colors"
              title="Ejecutar análisis forense autónomo en Cloudflare Sandbox (Firecracker microVM)"
            >
              <Cpu className="w-3.5 h-3.5 text-indigo-200" />
              {hermesLoading
                ? 'Hermes Ejecutando...'
                : 'Solicitar Peritaje Hermes SAT / Skip-Tracing'}
            </button>

            {docket && (
              <button
                onClick={handleOpenPrintable}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition-colors"
                title="Abrir vista oficial lista para imprimir o guardar como PDF"
              >
                <Printer className="w-3.5 h-3.5" />
                Imprimir / PDF Oficial
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Mensaje de acción de Hermes */}
        {hermesActionMsg && (
          <div className="px-6 py-2 bg-indigo-950/50 border-b border-indigo-800/40 text-xs text-indigo-300 flex items-center justify-between">
            <span>{hermesActionMsg}</span>
            <button
              onClick={() => setHermesActionMsg(null)}
              className="text-indigo-400 hover:text-indigo-200"
            >
              ×
            </button>
          </div>
        )}

        {/* Cuerpo del Modal */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-slate-300">
          {loading && (
            <div className="py-20 text-center space-y-3">
              <div className="inline-block w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-sm text-slate-400">
                Compilando cuaderno judicial, verificando cadena WORM y calculando liquidación...
              </p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/50 flex items-start gap-3 text-red-300">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-400 mt-0.5" />
              <div>
                <h4 className="font-semibold text-sm">Error al generar expediente</h4>
                <p className="text-xs text-red-200/80 mt-1">{error}</p>
              </div>
            </div>
          )}

          {docket && (
            <>
              {/* Sección Hermes-flare: Alta Inteligencia Forense en MicroVM Firecracker */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-indigo-950/40 to-purple-950/30 border border-indigo-800/50 space-y-3">
                <div className="flex items-center justify-between border-b border-indigo-800/40 pb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-bold text-indigo-200 uppercase tracking-wider">
                      Plano 2: Agente Autónomo Hermes (Cloudflare Sandboxes · microVM Firecracker)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTriggerHermes('skip_trace')}
                      disabled={hermesLoading}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded bg-indigo-900/60 hover:bg-indigo-800 border border-indigo-700/50 text-indigo-200"
                    >
                      Skip-Trace RPPC
                    </button>
                    <button
                      onClick={() => handleTriggerHermes('sat_materiality')}
                      disabled={hermesLoading}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded bg-purple-900/60 hover:bg-purple-800 border border-purple-700/50 text-purple-200"
                    >
                      Auditoría SAT 69-B
                    </button>
                    <button
                      onClick={() => handleTriggerHermes('judicial_synthesis')}
                      disabled={hermesLoading}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded bg-blue-900/60 hover:bg-blue-800 border border-blue-700/50 text-blue-200"
                    >
                      Síntesis Art. 1298-A
                    </button>
                  </div>
                </div>

                {latestHermesJob ? (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="font-semibold text-indigo-300">
                        Último Dictamen Forense [{latestHermesJob.taskType.toUpperCase()}]:
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {new Date(latestHermesJob.createdAt).toLocaleString('es-MX')}
                      </span>
                    </div>
                    <p className="text-slate-200 bg-slate-950/60 p-2.5 rounded-lg border border-indigo-950">
                      {latestHermesJob.resultSummary}
                    </p>
                    {latestHermesJob.wormEntryHash && (
                      <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                        <Lock className="w-3 h-3 text-indigo-400" />
                        <span>Hash WORM:</span>
                        <span className="text-indigo-300 truncate max-w-sm">
                          {latestHermesJob.wormEntryHash}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-indigo-200/70">
                    Aún no se ha ejecutado un peritaje forense autónomo sobre este expediente. Haz
                    clic en "Solicitar Peritaje Hermes SAT / Skip-Tracing" para desplegar la microVM
                    en Cloudflare Sandboxes.
                  </p>
                )}
              </div>

              {/* Barra de Estado Criptográfico y Nivel de Cumplimiento */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                      Acreditación NOM-151
                    </div>
                    <div className="text-xs font-bold text-emerald-400">
                      {docket.pruebasNom151.some((p) => p.proveedor.includes('ATEB'))
                        ? 'ATEB PSC Oficial (Secretaría de Economía)'
                        : 'Motor Arkangel (Listo para Timbrado ATEB)'}
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                      Custodia WORM (Art. 49 CCom)
                    </div>
                    <div className="text-xs font-bold text-blue-400">
                      {docket.custodiaWorm.cadenaValida
                        ? '✓ Cadena 100% Íntegra'
                        : '⚠️ Inconsistencia'}{' '}
                      ({docket.custodiaWorm.totalEventosAuditados} eventos)
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                      Materialidad SAT CFF 29-A
                    </div>
                    <div className="text-xs font-bold text-amber-400">
                      Fecha Cierta & Traza Operativa
                    </div>
                  </div>
                </div>
              </div>

              {/* Partes y Liquidación */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider border-b border-slate-800 pb-2">
                    <Building className="w-4 h-4 text-sky-400" />
                    Parte Actora (Acreedor)
                  </div>
                  <div className="text-sm font-semibold text-slate-100">
                    {docket.actor.razonSocial}
                  </div>
                  <div className="text-xs text-slate-400">
                    Registro CONDUSEF / REDECO:{' '}
                    <span className="font-mono text-slate-300">
                      {docket.actor.condusefRegistro}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Tenant ID:{' '}
                    <span className="font-mono text-slate-300">{docket.actor.tenantId}</span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider border-b border-slate-800 pb-2">
                    <User className="w-4 h-4 text-amber-400" />
                    Parte Demandada (Deudor)
                  </div>
                  <div className="text-sm font-semibold text-slate-100">
                    {docket.demandado.nombre}
                  </div>
                  <div className="text-xs text-slate-400">
                    CURP / RFC:{' '}
                    <span className="font-mono text-slate-300">
                      {docket.demandado.curp || 'No registrada'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Teléfono:{' '}
                    <span className="font-mono text-slate-300">
                      {docket.demandado.telefono || 'N/A'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Liquidación de Intereses */}
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider border-b border-slate-800 pb-2">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  Liquidación Procesal (Art. 362 Código de Comercio)
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">
                      Capital Insoluto
                    </div>
                    <div className="text-sm font-bold text-slate-100 mt-1">
                      {docket.liquidacion.capitalInsolutoFormatted}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">
                      Días de Mora
                    </div>
                    <div className="text-sm font-bold text-amber-400 mt-1">
                      {docket.liquidacion.diasMora} días
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">
                      Interés Moratorio Legal (6%)
                    </div>
                    <div className="text-sm font-bold text-sky-400 mt-1">
                      {docket.liquidacion.interesMoratorioEstimadoFormatted}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/50">
                    <div className="text-[10px] text-emerald-300 uppercase font-semibold">
                      Total Reclamado
                    </div>
                    <div className="text-sm font-bold text-emerald-400 mt-1">
                      {docket.liquidacion.totalReclamadoFormatted}
                    </div>
                  </div>
                </div>
              </div>

              {/* Pruebas NOM-151 */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider">
                  <FileText className="w-4 h-4 text-sky-400" />
                  Capítulo de Pruebas Informáticas NOM-151 (CCom Art. 1298-A)
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                      <tr>
                        <th className="py-2 px-3">Folio NOM-151</th>
                        <th className="py-2 px-3">Tipo</th>
                        <th className="py-2 px-3">Canal</th>
                        <th className="py-2 px-3">Proveedor PSC</th>
                        <th className="py-2 px-3">Nivel Probatorio</th>
                        <th className="py-2 px-3">Constancia SE</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                      {docket.pruebasNom151.map((p) => (
                        <tr key={p.folio} className="hover:bg-slate-800/30">
                          <td className="py-2 px-3 font-mono font-semibold text-slate-200">
                            {p.folio}
                          </td>
                          <td className="py-2 px-3 text-slate-300 capitalize">
                            {p.tipo.replace('_', ' ')}
                          </td>
                          <td className="py-2 px-3 text-slate-300 uppercase">{p.canal}</td>
                          <td className="py-2 px-3 text-slate-300">{p.proveedor}</td>
                          <td className="py-2 px-3">
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800/50">
                              {p.cumplimiento || 'Plena Presunción'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-mono text-[10px] text-slate-400">
                            {p.constanciaOficialId || 'Interno Arkangel'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sello Hash Maestro y Custodia WORM */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                    <Clock className="w-4 h-4 text-blue-400" />
                    Sello Hash Maestro del Cuaderno de Pruebas (SHA-256)
                  </div>
                  <button
                    onClick={() => handleCopyHash()}
                    className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 transition-colors"
                  >
                    {copiedHash ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">¡Copiado!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copiar Hash
                      </>
                    )}
                  </button>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900 font-mono text-xs text-slate-300 break-all border border-slate-800">
                  {docket.custodiaWorm.hashExpedienteSha256}
                </div>
                <p className="text-[11px] text-slate-500">
                  Fundamento: Artículos 49, 89, 90 y 1298-A del Código de Comercio · Cadena
                  inmutable protegida contra cualquier repudio o alteración procesal.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Arkangel LegalTech Engine · Hermes-flare · MicroVMs en Cloudflare Sandboxes
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            Cerrar Expediente
          </button>
        </div>
      </div>
    </div>
  );
};
