import { useEffect, useState } from 'react';
import {
  Check,
  FileCheck2,
  Lock,
  Printer,
  Scale,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api, type Nom151PrintableDocument } from './api';

export function Nom151Modal({
  folio,
  onClose,
}: {
  folio: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<Nom151PrintableDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCadena, setCopiedCadena] = useState(false);
  const [copiedSello, setCopiedSello] = useState(false);

  useEffect(() => {
    let active = true;
    const fetchDoc = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getNom151Document(folio);
        if (active) setDoc(res.document);
      } catch (err: any) {
        if (active) setError(err?.message || 'No se pudo cargar la constancia NOM-151');
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchDoc();
    return () => {
      active = false;
    };
  }, [folio]);

  const copiarTexto = async (texto: string, tipo: 'cadena' | 'sello') => {
    try {
      await navigator.clipboard.writeText(texto);
      if (tipo === 'cadena') {
        setCopiedCadena(true);
        setTimeout(() => setCopiedCadena(false), 2000);
      } else {
        setCopiedSello(true);
        setTimeout(() => setCopiedSello(false), 2000);
      }
    } catch {
      // Ignorar error de portapapeles
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto print:p-0 print:bg-white print:static">
      <div className="bg-white rounded-2xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl border border-slate-200 relative my-8 print:border-none print:shadow-none print:my-0 text-slate-900">
        {/* Cabecera de controles (oculta al imprimir) */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 mb-6 print:hidden">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-800 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <div className="font-bold text-sm text-slate-900">
                Constancia Oficial de Conservación de Mensajes de Datos
              </div>
              <div className="text-[10px] text-slate-700 font-mono">
                NOM-151-SCFI-2016 · Código de Comercio Arts. 89-114
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-1.5 flex items-center gap-1.5 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" /> Imprimir / PDF
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-1.5 rounded-md"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-xs text-slate-500">
            <div className="w-8 h-8 border-3 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Verificando integridad criptográfica y sello digital…
          </div>
        ) : error || !doc ? (
          <div className="py-12 text-center text-xs text-rose-600">
            {error || 'No fue posible localizar la constancia.'}
          </div>
        ) : (
          <div className="space-y-5 text-xs">
            {/* Encabezado Formal Notarial */}
            <div className="text-center pb-4 border-b border-slate-200">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-3 py-0.5 text-[10px] font-bold tracking-wide uppercase mb-2">
                <Check className="w-3 h-3 text-emerald-600" /> Verificación Criptográfica Válida · Integridad Garantizada
              </div>
              {doc.nivelCumplimientoLabel ? (
                <div className="mb-2">
                  <span
                    className={`inline-block px-2.5 py-0.5 rounded text-[10px] font-bold ${
                      doc.nivelCumplimiento === 'modo_a_pleno'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-200'
                    }`}
                  >
                    {doc.nivelCumplimientoLabel}
                  </span>
                </div>
              ) : null}
              <h2 className="text-sm sm:text-base font-extrabold uppercase tracking-wide text-slate-900 font-serif">
                {doc.titulo}
              </h2>
              <div className="text-xs text-slate-600 font-medium mt-1">
                Acreedor Emisor: <span className="font-bold text-slate-900">{doc.emisorRazonSocial}</span>
              </div>
              <div className="text-[11px] text-slate-700 font-mono">
                Registro CONDUSEF / REDECO: {doc.emisorCondusef}
              </div>
            </div>

            {/* Ficha Técnica de Notificación */}
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">
              <div>
                <span className="text-slate-500 font-medium">Folio Oficial NOM-151:</span>
                <div className="font-mono font-bold text-slate-900 text-xs">{doc.folio}</div>
              </div>
              <div>
                <span className="text-slate-500 font-medium">Destinatario Acreditado:</span>
                <div className="font-bold text-slate-800">{doc.destinatarioEnmascarado}</div>
              </div>
              <div>
                <span className="text-slate-500 font-medium">Medio y Canal Notarial:</span>
                <div className="text-slate-800">{doc.canal}</div>
              </div>
              <div>
                <span className="text-slate-500 font-medium">Fecha y Hora Certificada:</span>
                <div className="font-mono text-slate-800">{doc.fechaLocalCDMX}</div>
              </div>
              {doc.folioConstanciaOficialSE ? (
                <div>
                  <span className="text-slate-500 font-medium">Folio Oficial PSC (Secretaría de Economía):</span>
                  <div className="font-mono font-bold text-emerald-800 text-[10px]">
                    {doc.folioConstanciaOficialSE}
                  </div>
                </div>
              ) : null}
              {doc.hashCustodiaWORM ? (
                <div>
                  <span className="text-slate-500 font-medium">Custodia WORM (Art. 49 CCom):</span>
                  <div className="font-mono text-slate-700 text-[10px] truncate">
                    {doc.hashCustodiaWORM.slice(0, 24)}...
                  </div>
                </div>
              ) : null}
              <div className="sm:col-span-2">
                <span className="text-slate-500 font-medium">ID de Transmisión del Proveedor:</span>
                <div className="font-mono text-slate-700 text-[10px] truncate">
                  {doc.identificadorTransmision}
                </div>
              </div>
            </div>

            {/* Contenido Notificado Exacto */}
            <div>
              <div className="text-[11px] font-bold text-slate-800 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <FileCheck2 className="w-4 h-4 text-emerald-600" /> Contenido Íntegro del Mensaje de Datos
              </div>
              <div className="bg-slate-900 text-slate-100 rounded-xl p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-all border border-slate-800">
                {doc.contenidoNotificado}
              </div>
            </div>

            {/* Huellas Criptográficas SHA-256 */}
            <div className="space-y-3 bg-slate-50 rounded-xl p-4 border border-slate-200 text-[10px] font-mono">
              <div>
                <div className="text-slate-600 font-sans font-bold flex items-center justify-between">
                  <span>Huella Digital del Mensaje (SHA-256 Digest):</span>
                  <span className="text-emerald-700 font-normal">Algoritmo FIPS PUB 180-4</span>
                </div>
                <div className="text-emerald-800 font-bold break-all bg-emerald-50/70 p-2 rounded border border-emerald-200 mt-1">
                  {doc.huellaCriptograficaSHA256}
                </div>
              </div>

              <div>
                <div className="text-slate-600 font-sans font-bold flex items-center justify-between">
                  <span>Cadena Original de la Constancia:</span>
                  <button
                    onClick={() => void copiarTexto(doc.cadenaOriginal, 'cadena')}
                    className="text-slate-500 hover:text-slate-900 font-normal underline"
                  >
                    {copiedCadena ? '¡Copiada!' : 'Copiar'}
                  </button>
                </div>
                <div className="text-slate-700 break-all bg-white p-2 rounded border border-slate-200 mt-1 max-h-20 overflow-y-auto">
                  {doc.cadenaOriginal}
                </div>
              </div>

              <div>
                <div className="text-slate-600 font-sans font-bold flex items-center justify-between">
                  <span>Sello Digital de la Constancia:</span>
                  <button
                    onClick={() => void copiarTexto(doc.selloDigital, 'sello')}
                    className="text-slate-500 hover:text-slate-900 font-normal underline"
                  >
                    {copiedSello ? '¡Copiado!' : 'Copiar'}
                  </button>
                </div>
                <div className="text-slate-800 break-all bg-white p-2 rounded border border-slate-200 mt-1">
                  {doc.selloDigital}
                </div>
              </div>
            </div>

            {/* Fundamento Legal para Juicios Mercantiles y CONDUSEF */}
            <div className="border-t border-slate-200 pt-4 text-[10px] text-slate-600 space-y-1.5 leading-relaxed font-sans">
              <div className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1">
                <Scale className="w-3.5 h-3.5 text-slate-600" /> Eficacia Probatoria Plena
              </div>
              {doc.fundamentoLegal.map((f, i) => (
                <p key={i} className="text-justify">
                  {f}
                </p>
              ))}
            </div>

            {/* Pie con URL de Cotejo */}
            <div className="border-t border-slate-200 pt-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[10px] text-slate-500 font-sans">
              <div>
                URL de Cotejo Judicial:{' '}
                <a
                  href={doc.urlVerificacionPublica}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-emerald-700 underline"
                >
                  {doc.urlVerificacionPublica}
                </a>
              </div>
              <div className="flex items-center gap-1 font-semibold text-emerald-800">
                <Lock className="w-3 h-3 text-emerald-600" /> Inalterabilidad Certificada
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
