import React, { useState } from 'react';
import { Scale, FileCheck2, CheckCircle, XCircle, ChevronRight, Landmark } from 'lucide-react';

interface ComplianceItem {
  id: string;
  tag: string;
  law: string;
  name: string;
  summary: string;
  traditionalRisk: string;
  arkangelGuarantee: string;
  articles: string[];
  entity: string;
}

const COMPLIANCE_DATA: ComplianceItem[] = [
  {
    id: 'nom-151',
    tag: 'Validez Procesal Mercantil',
    law: 'NOM-151-SCFI-2016',
    name: 'Constancias de Conservación de Mensajes de Datos y TSA',
    summary:
      'Emisión automatizada de constancias digitales en formato oficial ASN.1 DER / PKCS#7 a través de ATEB Servicios PSC (acreditado por la Secretaría de Economía) y sellos de tiempo RFC 3161 sincronizados con el Centro Nacional de Metrología (CENAM).',
    traditionalRisk:
      'Capturas de pantalla de WhatsApp o correos sin firma son desechadas de inmediato por jueces mercantiles por vulnerabilidad a edición digital o falta de cadena de custodia.',
    arkangelGuarantee:
      'Prueba Plena Judicial indiscutible. El juez mercantil tiene la obligación legal de otorgar pleno valor probatorio a cada requerimiento, convenio y notificación timbrada.',
    articles: [
      'Código de Comercio Art. 1298-A',
      'Código de Comercio Arts. 89 a 114',
      'NOM-151-SCFI-2016',
    ],
    entity: 'Secretaría de Economía · Poder Judicial de la Federación',
  },
  {
    id: 'condusef-redeco',
    tag: 'Protección al Deudor & Reputación',
    law: 'REDECO / CONDUSEF',
    name: 'Escudo Normativo de Cobranza Extrajudicial Fail-Closed',
    summary:
      'Filtro algorítmico y de IA en tiempo real que inspecciona cada mensaje saliente, llamada telefónica y horario antes de ser transmitido, aplicando un bloqueo absoluto si detecta riesgo regulatorio.',
    traditionalRisk:
      'Operadores estresados que insultan, amenazan con embargo falso, llaman a familiares/patrones o contactan en domingo de madrugada, detonando multas de hasta $1,600,000 MXN en CONDUSEF.',
    arkangelGuarantee:
      'Ventana estricta de contacto (08:00 a 22:00 hrs CDMX). IA con guiones supervisados y empáticos que nunca amenazan ni violan las disposiciones de las entidades financieras.',
    articles: [
      'Ley para la Transparencia y Ordenamiento de Servicios Financieros',
      'Disposiciones REDECO 2026',
    ],
    entity: 'CONDUSEF · PROFECO',
  },
  {
    id: 'nom-184',
    tag: 'Límite de Frecuencia',
    law: 'NOM-184-SCFI-2018',
    name: 'Semáforo de Hostigamiento y Contacto Responsable',
    summary:
      'Regulación estricta que prohíbe el bombardeo comunicacional a usuarios. Arkangel implementa contadores atómicos distribuidos en Cloudflare KV para limitar las gestiones.',
    traditionalRisk:
      'Sistemas de marcación automática que insisten 20 veces al día, causando bloqueos de número telefónico por SPAM en WhatsApp y quejas por hostigamiento comercial.',
    arkangelGuarantee:
      'Máximo 3 intentos de contacto por cada 24 horas por deudor en todos los canales combinados (Voz, WhatsApp, SMS).',
    articles: ['NOM-184-SCFI-2018 Numeral 4.2', 'Ley Federal de Telecomunicaciones'],
    entity: 'IFT · PROFECO',
  },
  {
    id: 'sat-materialidad',
    tag: 'Blindaje Fiscal y Deducción',
    law: 'CFF Art. 69-B & LISR Art. 27',
    name: 'Materialidad, Fecha Cierta y Cuentas Incobrables',
    summary:
      'Generación de bitácoras de gestión con sellos criptográficos SHA-256 para acreditar ante el Servicio de Administración Tributaria (SAT) la materialidad de la deuda y la imposibilidad práctica de cobro.',
    traditionalRisk:
      'El SAT rechaza la deducción de cartera incobrable por falta de comprobación fehaciente de las gestiones de cobro, generando créditos fiscales con recargos y multas de actualización.',
    arkangelGuarantee:
      'Expediente completo de incobrabilidad en 1 clic: registros de llamadas, mensajes certificados, constancia NOM-151 y trazabilidad cronológica con fecha cierta incontestable.',
    articles: ['Código Fiscal de la Federación Arts. 29-A y 69-B', 'Ley del ISR Art. 27 Fracc. XV'],
    entity: 'Servicio de Administración Tributaria (SAT)',
  },
  {
    id: 'custodia-worm',
    tag: 'Conservación Obligatoria',
    law: 'Código de Comercio Art. 49',
    name: 'Custodia Criptográfica Inmutable por 10 Años',
    summary:
      'Almacenamiento tipo WORM (Write Once, Read Many) en Cloudflare R2 con encadenamiento criptográfico continuo de bloques (prev_hash -> entry_hash) para garantizar que los expedientes jamás puedan ser alterados.',
    traditionalRisk:
      'Pérdida de expedientes por migración de servidores, discos dañados o manipulación indebida de operadores, dejando sin defensa al acreedor en juicio mercantil.',
    arkangelGuarantee:
      'Archivo inviolable durante los 10 años que marca la ley mexicana, disponible para cotejo pericial y verificación pública instantánea.',
    articles: ['Código de Comercio Artículo 49', 'LFPDPPP (Seguridad de Datos Financieros)'],
    entity: 'Secretaría de Economía · Tribunales Colegiados',
  },
];

export const ComplianceMatrix: React.FC = () => {
  const defaultItem = COMPLIANCE_DATA[0] as ComplianceItem;
  const [selectedId, setSelectedId] = useState<string>(defaultItem.id);

  const activeItem = COMPLIANCE_DATA.find((c) => c.id === selectedId) || defaultItem;

  return (
    <section
      id="blindaje-legal"
      className="py-20 bg-slate-900 border-y border-slate-800 text-white relative overflow-hidden"
    >
      {/* Decorative gradient glow */}
      <div className="absolute top-0 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-4">
            <Scale className="w-3.5 h-3.5" />
            <span>Arquitectura Diseñada para la Legislación Mexicana</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            El Escudo Normativo de Arkangel: Cero Contingencias Legales
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-300">
            A diferencia de herramientas extranjeras o bots improvisados, cada línea de código de
            Arkangel está parametrizada para cumplir rigurosamente con las NOMs, el Código de
            Comercio y los requerimientos del SAT y CONDUSEF.
          </p>
        </div>

        {/* Desktop & Mobile Interactive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Navigation Sidebar / Cards */}
          <div className="lg:col-span-5 space-y-3">
            {COMPLIANCE_DATA.map((item) => {
              const isSelected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all flex items-start justify-between group ${
                    isSelected
                      ? 'bg-slate-800/95 border-emerald-500 shadow-lg shadow-emerald-950/40 translate-x-1'
                      : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/80 hover:border-slate-600'
                  }`}
                >
                  <div className="pr-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-950/90 px-2 py-0.5 rounded border border-emerald-800/50">
                        {item.law}
                      </span>
                      <span className="text-xs text-slate-400">{item.tag}</span>
                    </div>
                    <div className="text-sm font-semibold text-white mt-1.5 group-hover:text-emerald-300 transition-colors">
                      {item.name}
                    </div>
                  </div>
                  <ChevronRight
                    className={`w-5 h-5 shrink-0 mt-1 transition-transform ${
                      isSelected
                        ? 'text-emerald-400 translate-x-1'
                        : 'text-slate-500 group-hover:text-slate-300'
                    }`}
                  />
                </button>
              );
            })}
          </div>

          {/* Active Detail Showcase Panel */}
          <div className="lg:col-span-7 bg-slate-950/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl relative">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-6 border-b border-slate-800">
              <div>
                <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider">
                  Marco Regulatorio
                </span>
                <h3 className="text-2xl font-bold text-white mt-1">{activeItem.law}</h3>
                <div className="text-sm text-slate-400">{activeItem.name}</div>
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-slate-900 border border-slate-800 text-xs font-medium text-slate-300">
                <Landmark className="w-3.5 h-3.5 text-blue-400" />
                <span>{activeItem.entity}</span>
              </div>
            </div>

            <p className="mt-6 text-slate-300 text-sm sm:text-base leading-relaxed">
              {activeItem.summary}
            </p>

            {/* Contrast: Traditional Risk vs Arkangel Guarantee */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-red-950/20 border border-red-500/30">
                <div className="flex items-center gap-2 text-red-400 font-semibold text-xs uppercase tracking-wider mb-2">
                  <XCircle className="w-4 h-4 text-red-400" />
                  <span>Riesgo en Cobranza Tradicional</span>
                </div>
                <p className="text-xs sm:text-sm text-red-200/90 leading-relaxed">
                  {activeItem.traditionalRisk}
                </p>
              </div>

              <div className="p-4 rounded-xl bg-emerald-950/25 border border-emerald-500/40">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs uppercase tracking-wider mb-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  <span>Garantía Legal Arkangel</span>
                </div>
                <p className="text-xs sm:text-sm text-emerald-100/95 leading-relaxed">
                  {activeItem.arkangelGuarantee}
                </p>
              </div>
            </div>

            {/* Applicable articles */}
            <div className="mt-6 pt-5 border-t border-slate-800 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-400 mr-2">Fundamento Legal:</span>
              {activeItem.articles.map((art, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300"
                >
                  <FileCheck2 className="w-3 h-3 text-emerald-400" />
                  <span>{art}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
