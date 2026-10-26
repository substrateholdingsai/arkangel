import React, { useState } from 'react';
import { FileSpreadsheet, CheckCircle2, Play, Gavel, Bot, Zap } from 'lucide-react';

interface TourStep {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  highlights: string[];
  interfacePreview: React.ReactNode;
}

export const ProductTour: React.FC = () => {
  const [activeStep, setActiveStep] = useState<number>(0);

  const steps: TourStep[] = [
    {
      id: 'intake',
      badge: 'Paso 1 · Operación Mínima',
      title: 'Modo Neandertal: 1 Botón • 0 Tablas',
      subtitle: 'La automatización más simple y a prueba de errores para tu equipo.',
      description:
        'Elimina la complejidad operativa. Tu equipo solo arrastra el archivo CSV con la cartera del día y presiona el botón verde de disparo. Arkangel valida RFCs, números telefónicos E.164, filtra deudores con promesas activas y programa los envíos en la ventana legal permitida.',
      highlights: [
        'Deduplicación automática cada 24 horas por canal',
        'Validación de números móviles y formato nacional',
        'Cálculo de score de recuperación R1/R2 en milisegundos',
      ],
      interfacePreview: (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-5 font-mono text-xs shadow-inner">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 text-slate-400">
            <span className="flex items-center gap-2 text-emerald-400 font-bold">
              <Zap className="w-3.5 h-3.5" />
              <span>DISPATCH CONSOLE</span>
            </span>
            <span>CSV_CARTERA_20261026.CSV</span>
          </div>
          <div className="py-6 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 animate-pulse">
              <FileSpreadsheet className="w-8 h-8" />
            </div>
            <div className="text-white font-sans font-bold text-sm">
              Cartera Procesada: 1,240 casos
            </div>
            <div className="text-slate-400 text-[11px] font-sans mt-1">
              Saldo total: $4,820,000 MXN
            </div>
            <div className="mt-4 px-6 py-2 rounded-lg bg-emerald-600 text-white font-sans font-bold shadow-lg shadow-emerald-600/30">
              DISPARAR GESTIÓN LEGAL (6:00 AM CDMX)
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'voice-chat',
      badge: 'Paso 2 · Omnicanalidad Asistida por IA',
      title: 'Voz AI Telnyx + WhatsApp Business HSM',
      subtitle: 'Conversaciones humanas y empáticas dentro del estricto marco CONDUSEF.',
      description:
        'El motor de Workers AI (Llama 3.3 70B) interactúa de forma contextual por WhatsApp y telefonía de alta fidelidad. Detecta objeciones, valida identidad, ofrece convenios con descuento pre-aprobado y genera referencias de pago SPEI en tiempo real.',
      highlights: [
        'Detección de buzón de voz (AMD) en menos de 800 ms',
        'Plantillas de WhatsApp autorizadas con botones de acción directa',
        'Supervisión y transiciones fluidas hacia agentes humanos cuando se requiere',
      ],
      interfacePreview: (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 font-sans text-xs shadow-inner space-y-3">
          <div className="flex items-center justify-between text-slate-400 pb-2 border-b border-slate-800 font-mono text-[11px]">
            <span className="text-emerald-400 flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5" />
              <span>TELNYX WHATSAPP AI · CASO #8429</span>
            </span>
            <span className="bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-800">
              VERIFICADO META
            </span>
          </div>

          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700 text-slate-200">
            <span className="text-emerald-400 font-bold block text-[11px] mb-1">
              Arkangel Voice/Chat:
            </span>
            Hola Juan, te contactamos de Servicios Financieros respecto a tu cuenta #8429 con saldo
            vencido de $12,400 MXN. Para apoyarte hoy, contamos con un plan de liquidación con
            descuento del 25% ($9,300 MXN). ¿Te gustaría recibir la CLABE para liquidar vía SPEI?
          </div>

          <div className="bg-emerald-950/40 p-2.5 rounded-lg border border-emerald-500/30 text-emerald-100 flex items-center justify-between">
            <div>
              <span className="font-bold text-white block">Intención Detectada:</span>
              <span className="text-[11px] text-emerald-300">
                Promesa de pago para hoy antes de las 18:00 hrs
              </span>
            </div>
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          </div>
        </div>
      ),
    },
    {
      id: 'self-service',
      badge: 'Paso 3 · Experiencia del Deudor',
      title: 'Portal de Autoservicio del Deudor 24/7',
      subtitle: 'Cobranza sin fricción, sin vergüenza y con confirmación inmediata.',
      description:
        'Cada mensaje incluye un enlace tokenizado único al Portal del Deudor. El acreditado puede revisar el desglose exacto de su adeudo, descargar el convenio formal, pagar con un toque vía SPEI o tarjeta, y recibir su carta finiquito sellada al instante.',
      highlights: [
        'Acceso seguro sin contraseñas difíciles (token SHA-256 de un solo uso)',
        'Generación de CLABE interbancaria personalizada para transferencia inmediata',
        'Aumenta la recuperación hasta un 38% al eliminar la confrontación verbal',
      ],
      interfacePreview: (
        <div className="bg-white text-slate-900 rounded-xl p-4 text-xs shadow-xl border border-slate-200">
          <div className="flex items-center justify-between border-b pb-2 mb-3">
            <div className="font-bold text-slate-800">Portal de Autoservicio · Arkangel</div>
            <span className="text-[10px] font-mono bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-semibold">
              SPEI CONCILIADO
            </span>
          </div>
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mb-3">
            <div className="text-[11px] text-slate-500">Saldo con Descuento Aplicado:</div>
            <div className="text-xl font-extrabold text-slate-900">$9,300.00 MXN</div>
            <div className="text-[10px] text-emerald-700 font-mono mt-1">
              CLABE: 646180112345678901 (STP)
            </div>
          </div>
          <div className="w-full py-2 bg-emerald-600 text-white rounded font-bold text-center">
            DESCARGAR CARTA FINIQUITO TIMBRADA NOM-151
          </div>
        </div>
      ),
    },
    {
      id: 'judicial-docket',
      badge: 'Paso 4 · Vía Judicial Mercantil',
      title: 'Cuaderno Procesal Judicial & Carpeta SAT',
      subtitle: 'Todo listo para el abogado litigante en caso de insolvencia o negativa.',
      description:
        'Cuando un caso agota la vía extrajudicial, Arkangel compila automáticamente el Cuaderno Procesal Mercantil conforme al Código de Comercio Art. 1298-A: demanda pre-llenada, bitácora cronológica inmutable, audios en Cloudflare R2 y constancias oficiales ASN.1 DER timbradas ante ATEB PSC.',
      highlights: [
        'Prueba plena admisible directamente por el Juez de Oralidad Mercantil',
        'Expediente de incobrabilidad para deducción fiscal ante el SAT (LISR Art. 27 Fracc. XV)',
        'Descarga completa en formato ZIP con hash determinista para cotejo pericial',
      ],
      interfacePreview: (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 font-mono text-xs shadow-inner">
          <div className="flex items-center justify-between text-slate-400 pb-2 border-b border-slate-800 text-[11px]">
            <span className="text-amber-400 flex items-center gap-1.5 font-bold">
              <Gavel className="w-3.5 h-3.5" />
              <span>EXPEDIENTE JUDICIAL MERCANTIL</span>
            </span>
            <span className="text-slate-400">FOLIO NOM151-2026-981</span>
          </div>

          <div className="space-y-2 mt-3 text-[11px]">
            <div className="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700">
              <span className="text-slate-200">1. Demanda_Oral_Mercantil.pdf</span>
              <span className="text-emerald-400 font-bold">LISTO</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700">
              <span className="text-slate-200">2. Constancia_NOM151_ATEB.asn1</span>
              <span className="text-emerald-400 font-bold">TIMBRADA PSC</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700">
              <span className="text-slate-200">3. Bitacora_Custodia_WORM.json</span>
              <span className="text-emerald-400 font-bold">SHA-256 OK</span>
            </div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <section id="producto" className="py-20 bg-slate-950 text-white relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-300 text-xs font-semibold uppercase tracking-wider mb-4">
            <Play className="w-3.5 h-3.5 text-emerald-400" />
            <span>Flujo Operativo de Extremo a Extremo</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Cómo Funciona Arkangel en tu Operación Diaria
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400">
            De la carga de cartera a la cobranza en cuenta bancaria o a la demanda judicial
            mercantil con prueba plena.
          </p>
        </div>

        {/* Step Selector Tabs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
          {steps.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveStep(idx)}
              className={`p-3.5 rounded-xl border text-left transition-all ${
                activeStep === idx
                  ? 'bg-slate-900 border-emerald-500 shadow-lg shadow-emerald-950/50'
                  : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:bg-slate-900/80 hover:text-slate-200'
              }`}
            >
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">
                {s.badge.split('·')[0]}
              </div>
              <div className="text-xs sm:text-sm font-bold text-white mt-1 leading-snug line-clamp-1">
                {s.title.split(':')[0]}
              </div>
            </button>
          ))}
        </div>

        {/* Active Step Showcase */}
        {(() => {
          const step = (steps[activeStep] ?? steps[0]) as TourStep;
          return (
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 sm:p-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              <div className="lg:col-span-6 space-y-4">
                <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider bg-emerald-950 px-2.5 py-1 rounded border border-emerald-800">
                  {step.badge}
                </span>
                <h3 className="text-2xl sm:text-3xl font-bold text-white">{step.title}</h3>
                <div className="text-sm font-semibold text-slate-300">{step.subtitle}</div>
                <p className="text-slate-400 text-sm sm:text-base leading-relaxed">
                  {step.description}
                </p>

                <div className="space-y-2 pt-2">
                  {step.highlights.map((h, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-xs sm:text-sm text-slate-200"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{h}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-6">{step.interfacePreview}</div>
            </div>
          );
        })()}
      </div>
    </section>
  );
};
