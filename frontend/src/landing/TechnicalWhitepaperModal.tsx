import React, { useState } from 'react';
import { X, FileText, Cpu, Scale, Lock } from 'lucide-react';

interface TechnicalWhitepaperModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TechnicalWhitepaperModal: React.FC<TechnicalWhitepaperModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'architecture' | 'legal' | 'commercial'>(
    'architecture'
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="relative w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                Anexo Técnico, Auditoría de Calidad y Dictamen Legal
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                Arkangel LegalTech Platform · Versión 1.0.1 (Auditoría ATEB PSC / CISO)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Nav */}
        <div className="flex border-b border-slate-800 bg-slate-900/50 px-6 gap-2 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('architecture')}
            className={`pb-3 px-3 text-xs sm:text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'architecture'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-4 h-4" />
            <span>Arquitectura Cloudflare & Telnyx</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('legal')}
            className={`pb-3 px-3 text-xs sm:text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'legal'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Scale className="w-4 h-4" />
            <span>Matriz de Cumplimiento (NOMs / SAT)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('commercial')}
            className={`pb-3 px-3 text-xs sm:text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'commercial'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Lock className="w-4 h-4" />
            <span>Esquemas y Alianza ATEB PSC</span>
          </button>
        </div>

        {/* Modal Body Content */}
        <div className="p-6 overflow-y-auto text-slate-300 text-sm space-y-6 leading-relaxed">
          {activeTab === 'architecture' && (
            <div className="space-y-4">
              <h4 className="text-base font-bold text-white">
                Especificación de Infraestructura Edge
              </h4>
              <p>
                Arkangel se ejecuta como un servicio serverless de borde sobre{' '}
                <strong>Cloudflare Workers (V8 Isolates)</strong>. Esto garantiza arranque en frío
                de 0 ms y latencia de red menor a 30 ms en todo el territorio mexicano.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono text-xs">
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-emerald-400 font-bold mb-1">Criptografía SHA-256</div>
                  <div>
                    FIPS PUB 180-4 nativo en Web Crypto API con encadenamiento continuo (blockchain
                    interno).
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-blue-400 font-bold mb-1">Bóveda WORM Cloudflare R2</div>
                  <div>
                    Retención inmutable por 10 años conforme al Art. 49 del Código de Comercio sin
                    costos de descarga.
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-emerald-400 font-bold mb-1">Telnyx Call Control v2</div>
                  <div>
                    Conexión carrier directa con PSTN, códec Opus / G.711u y detección de máquina
                    (AMD) en &lt;800ms.
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-purple-400 font-bold mb-1">Workers AI Llama 3.3 70B</div>
                  <div>
                    Inferencia de IA acelerada en GPU sin fuga de datos hacia terceros (SOC2 / ISO
                    27001).
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800">
                <div className="font-bold text-white mb-2">
                  Protocolo de Resiliencia ante Caídas del PSC (Failover Dual-Engine):
                </div>
                <ul className="list-disc pl-5 space-y-1 text-xs text-slate-300">
                  <li>
                    <strong>Modo A (Pleno Oficial):</strong> Timbrado instantáneo en línea vía
                    WebService ATEB Servicios PSC (acreditado por la Secretaría de Economía).
                  </li>
                  <li>
                    <strong>Modo B (Failover Preventivo):</strong> Si el WebService de ATEB presenta
                    una desconexión temporal, Arkangel sella la gestión en su motor interno con hash
                    SHA-256, resguarda la evidencia en WORM y la timbra de forma automática ante
                    ATEB en cuanto se restablezca la conexión.{' '}
                    <em>La operación de cobro nunca se detiene.</em>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'legal' && (
            <div className="space-y-4">
              <h4 className="text-base font-bold text-white">
                Cumplimiento Legal y Validez Mercantil
              </h4>
              <p>
                A diferencia de los despachos convencionales cuyos métodos son desestimados en
                tribunales por violaciones a derechos del consumidor, Arkangel construye una cadena
                de custodia pericial:
              </p>

              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="font-bold text-emerald-400">
                    Código de Comercio Art. 1298-A (Prueba Plena Judicial):
                  </span>
                  <div className="text-xs text-slate-300 mt-1">
                    El juez de oralidad mercantil debe reconocer pleno valor a los mensajes de datos
                    respaldados con constancia emitida por un PSC acreditado ante la Secretaría de
                    Economía.
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="font-bold text-emerald-400">
                    Disposiciones CONDUSEF / REDECO:
                  </span>
                  <div className="text-xs text-slate-300 mt-1">
                    Garantía absoluta de contacto únicamente entre las 08:00 y las 22:00 horas CDMX.
                    Supresión total de lenguaje amenazante o cobranza a referencias personales.
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="font-bold text-emerald-400">
                    CFF Arts. 29-A, 69-B y LISR Art. 27 Fracc. XV:
                  </span>
                  <div className="text-xs text-slate-300 mt-1">
                    Generación de la carpeta de materialidad y fecha cierta para desvirtuar
                    presunción de operaciones inexistentes y deducir créditos incobrables por
                    imposibilidad práctica de cobro.
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'commercial' && (
            <div className="space-y-4">
              <h4 className="text-base font-bold text-white">Modelos de Contratación y Alianzas</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-4 rounded-xl bg-slate-950 border border-emerald-500/30">
                  <div className="font-bold text-white text-sm mb-1">Alianza ATEB PSC</div>
                  <div className="text-slate-400 mb-2">Canal Oficial</div>
                  <p className="text-slate-300">
                    Consumo directo de timbres oficiales NOM-151 y RFC 3161 TSA facturados por ATEB
                    con suscripción SaaS de Arkangel.
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="font-bold text-white text-sm mb-1">Despacho / Banco SaaS</div>
                  <div className="text-slate-400 mb-2">Por Volumen de Cuentas</div>
                  <p className="text-slate-300">
                    Acceso para operadores ilimitados, softphone Telnyx, IA contextual, portal del
                    deudor y paquetes de timbres por escala.
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="font-bold text-white text-sm mb-1">Marca Blanca Enterprise</div>
                  <div className="text-slate-400 mb-2">Infraestructura Dedicada</div>
                  <p className="text-slate-300">
                    Despliegue bajo dominio corporativo propio, logos personalizados e integración
                    con el Core Bancario o ERP institucional.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between p-4 border-t border-slate-800 bg-slate-950">
          <div className="text-xs text-slate-500 font-mono">
            HASH AUDITORÍA: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-colors"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};
