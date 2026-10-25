import React, { useState, useEffect } from 'react';
import {
  api,
  JudicialDocketData,
} from './api';
import {
  Scale,
  FileText,
  Printer,
  Copy,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Building,
  User,
  DollarSign,
  PhoneCall,
  Clock,
  X,
  Lock,
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

    return () => {
      isMounted = false;
    };
  }, [caseId]);

  const handleCopyHash = () => {
    if (!docket?.custodiaWorm.hashExpedienteSha256) return;
    navigator.clipboard.writeText(docket.custodiaWorm.hashExpedienteSha256);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2500);
  };

  const handleOpenPrintable = () => {
    const url = `/api/v1/nom151/cases/${encodeURIComponent(caseId)}/docket/printable`;
    window.open(url, '_blank');
  };

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
                Prueba Plena Mercantil (CCom Art. 1298-A) · Custodia WORM 10 años (Art. 49) · CFF Arts. 29-A y 69-B
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
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
                      {docket.custodiaWorm.cadenaValida ? '✓ Cadena 100% Íntegra' : '⚠️ Inconsistencia'} (
                      {docket.custodiaWorm.totalEventosAuditados} eventos)
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
                  <div className="text-xs">
                    <span className="text-slate-400">Razón Social:</span>{' '}
                    <strong className="text-slate-200">{docket.actor.razonSocial}</strong>
                  </div>
                  <div className="text-xs">
                    <span className="text-slate-400">Registro CONDUSEF:</span>{' '}
                    <strong className="text-slate-200">{docket.actor.condusefRegistro}</strong>
                  </div>
                  <div className="text-xs">
                    <span className="text-slate-400">Vía Procesal:</span>{' '}
                    <span className="text-slate-300 font-mono text-[11px]">{docket.viaProcesal}</span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider border-b border-slate-800 pb-2">
                    <User className="w-4 h-4 text-emerald-400" />
                    Parte Demandada (Deudor)
                  </div>
                  <div className="text-xs">
                    <span className="text-slate-400">Nombre:</span>{' '}
                    <strong className="text-slate-200">{docket.demandado.nombre}</strong>
                  </div>
                  <div className="text-xs">
                    <span className="text-slate-400">CURP:</span>{' '}
                    <strong className="text-slate-200">{docket.demandado.curp || 'No especificado'}</strong>
                  </div>
                  <div className="text-xs">
                    <span className="text-slate-400">Contacto:</span>{' '}
                    <span className="text-slate-300">
                      {docket.demandado.telefono || 'Sin tel'} · {docket.demandado.email || 'Sin email'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Liquidación de Saldo Reclamado */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border border-slate-800">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider mb-3">
                  <DollarSign className="w-4 h-4 text-amber-400" />
                  Liquidación de Saldo e Intereses Moratorios (Art. 362 CCom)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">Capital Insoluto</div>
                    <div className="text-sm font-bold text-slate-100">
                      {docket.liquidacion.capitalInsolutoFormatted}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">Días de Mora</div>
                    <div className="text-sm font-bold text-red-400">
                      {docket.liquidacion.diasMora} Días
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">Interés Moratorio (6%)</div>
                    <div className="text-sm font-bold text-amber-400">
                      {docket.liquidacion.interesMoratorioEstimadoFormatted}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-blue-950/50 border border-blue-800/60">
                    <div className="text-[10px] text-blue-300 uppercase font-semibold">Total Reclamado</div>
                    <div className="text-base font-extrabold text-blue-400">
                      {docket.liquidacion.totalReclamadoFormatted}
                    </div>
                  </div>
                </div>
              </div>

              {/* Pruebas Criptográficas NOM-151 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider">
                    <FileText className="w-4 h-4 text-blue-400" />
                    Pruebas Informáticas NOM-151 (Art. 1298-A Código de Comercio)
                  </div>
                  <span className="text-xs text-slate-400">
                    {docket.pruebasNom151.length} constancia(s) incorporada(s)
                  </span>
                </div>

                {docket.pruebasNom151.length === 0 ? (
                  <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 text-center text-xs text-slate-400">
                    Aún no se han emitido constancias NOM-151 para este caso. Puedes emitirlas desde el drawer de mensajes.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">Folio NOM-151</th>
                          <th className="py-2.5 px-3">Tipo</th>
                          <th className="py-2.5 px-3">Canal</th>
                          <th className="py-2.5 px-3">Fecha (CDMX)</th>
                          <th className="py-2.5 px-3">Cumplimiento</th>
                          <th className="py-2.5 px-3">Digest SHA-256</th>
                          <th className="py-2.5 px-3 text-right">Cotejo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                        {docket.pruebasNom151.map((p) => (
                          <tr key={p.folio} className="hover:bg-slate-800/30">
                            <td className="py-2.5 px-3 font-mono font-bold text-slate-200">{p.folio}</td>
                            <td className="py-2.5 px-3 text-slate-300 uppercase text-[11px]">
                              {p.tipo.replace('_', ' ')}
                            </td>
                            <td className="py-2.5 px-3 uppercase text-[11px] font-semibold text-slate-400">
                              {p.canal}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400 text-[11px]">{p.fecha}</td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  p.cumplimiento.includes('Oficial')
                                    ? 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/50'
                                    : 'bg-amber-950/70 text-amber-400 border border-amber-800/50'
                                }`}
                              >
                                {p.cumplimiento}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[10px] text-slate-400">
                              {p.digest.slice(0, 16)}...
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <a
                                href={p.verificacionUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 hover:underline"
                              >
                                Ver <ExternalLink className="w-3 h-3" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Bitácora Telefónica Telnyx / Mensajería */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider">
                  <PhoneCall className="w-4 h-4 text-emerald-400" />
                  Trazabilidad de Telefonía Telnyx y Mensajería Saliente
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] font-semibold border-b border-slate-800">
                      <tr>
                        <th className="py-2 px-3">Medio</th>
                        <th className="py-2 px-3">Fecha</th>
                        <th className="py-2 px-3">Detalle de la Gestión</th>
                        <th className="py-2 px-3">Provider Call SID / Msg ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                      {docket.gestionesOperativas.map((g, idx) => (
                        <tr key={idx} className="hover:bg-slate-800/30">
                          <td className="py-2 px-3 font-semibold text-slate-300">{g.tipo}</td>
                          <td className="py-2 px-3 text-slate-400">{g.fecha}</td>
                          <td className="py-2 px-3 text-slate-300 max-w-md truncate">{g.detalle}</td>
                          <td className="py-2 px-3 font-mono text-[10px] text-slate-400">
                            {g.identificadorProveedor || 'N/A'}
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
                    onClick={handleCopyHash}
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
                  Fundamento: Artículos 49, 89, 90 y 1298-A del Código de Comercio · Cadena inmutable protegida contra
                  cualquier repudio o alteración procesal.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Arkangel LegalTech Engine · NOM-151-SCFI-2016 · Secretaría de Economía
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
