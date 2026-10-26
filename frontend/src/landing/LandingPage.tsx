import React, { useState } from 'react';
import {
  Shield,
  FileText,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  HelpCircle,
  LogIn,
  Lock,
} from 'lucide-react';
import { SplineShieldHero } from './SplineShieldHero';
import { ComplianceMatrix } from './ComplianceMatrix';
import { TechArchitecture } from './TechArchitecture';
import { RoiCalculator } from './RoiCalculator';
import { ProductTour } from './ProductTour';
import { TechnicalWhitepaperModal } from './TechnicalWhitepaperModal';

interface LandingPageProps {
  onGoToApp: () => void;
  onGoToPortal?: () => void;
  onGoToVerify?: (folio?: string) => void;
  isAuthenticated?: boolean;
  userEmail?: string;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  onGoToApp,
  onGoToVerify,
  isAuthenticated,
}) => {
  const [whitepaperOpen, setWhitepaperOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const faqs = [
    {
      q: '¿Cómo garantiza Arkangel que las gestiones tengan validez ante un Juez Mercantil?',
      a: 'A diferencia de simples capturas de pantalla que carecen de valor probatorio, cada notificación por WhatsApp, SMS y llamada telefónica es procesada con un resumen criptográfico SHA-256 e integrada al WebService de ATEB Servicios PSC (acreditado por la Secretaría de Economía). Se emite una constancia NOM-151-SCFI-2016 en formato ASN.1 DER y una estampa de tiempo RFC 3161 sincronizada con el CENAM, lo que otorga Prueba Plena Judicial indiscutible conforme al Art. 1298-A del Código de Comercio.',
    },
    {
      q: '¿Qué pasa si el servicio del PSC o la red presentan una interrupción momentánea?',
      a: 'Arkangel cuenta con arquitectura dual-engine con protocolo de resiliencia "failover": si ATEB presenta una interrupción o agotas saldo de timbres, Arkangel activa de inmediato el Modo B (Presuntivo). Sella la evidencia en la bitácora inmutable WORM de Cloudflare R2 y la encola para timbrado posterior automático ante ATEB en cuanto se normalice la conexión. La cobranza nunca se detiene.',
    },
    {
      q: '¿Por qué Telnyx directo en vez de revendedores de telefonía o WhatsApp?',
      a: 'Los revendedores VoIP tradicionales introducen latencias superiores a 600 ms, sufren desconexiones y corren riesgo de baneos de línea por spam. Telnyx es un operador carrier Tier-1 directo a la red telefónica conmutada (PSTN) y cuenta con acceso directo a Meta para WhatsApp Business API verificado, además de detección de contestadoras automáticas (AMD) en menos de 800 ms.',
    },
    {
      q: '¿Cómo apoya Arkangel a deducir cuentas incobrables ante el SAT?',
      a: 'Conforme a la Ley del Impuesto sobre la Renta (LISR Art. 27 Fracc. XV) y el CFF Arts. 29-A y 69-B, para hacer deducible un crédito incobrable es indispensable demostrar la imposibilidad práctica de cobro con fecha cierta. Arkangel compila automáticamente el expediente probatorio con la bitácora certificada de llamadas y requerimientos no contestados para respaldar la deducción fiscal en 1 clic.',
    },
    {
      q: '¿Puede integrarse Arkangel con nuestro Core Bancario, CRM o ERP?',
      a: 'Sí. Arkangel opera como una API de borde nativa sobre Cloudflare Workers con arquitectura headless y conectores webhook. Puede recibir carteras mediante entregas automatizadas de CSV a las 6:00 AM o mediante endpoints REST seguros con tokens de autenticación.',
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-emerald-500 selection:text-white">
      {/* Sticky Header */}
      <header className="sticky top-0 z-40 bg-slate-950/85 backdrop-blur-md border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-emerald-400 p-0.5 shadow-md shadow-emerald-500/20 flex items-center justify-center">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <Shield className="w-5 h-5 text-emerald-400" />
              </div>
            </div>
            <div>
              <span className="font-extrabold text-lg tracking-wider text-white">ARKANGEL</span>
              <span className="text-[10px] font-mono text-emerald-400 ml-2 px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800/80">
                LEGALTECH
              </span>
            </div>
          </div>

          {/* Desktop Nav Links */}
          <nav className="hidden md:flex items-center gap-6 text-xs font-semibold text-slate-300">
            <a href="#blindaje-legal" className="hover:text-emerald-400 transition-colors">
              Blindaje Legal & NOMs
            </a>
            <a href="#infraestructura" className="hover:text-emerald-400 transition-colors">
              Infraestructura
            </a>
            <a href="#producto" className="hover:text-emerald-400 transition-colors">
              Cómo Funciona
            </a>
            <a href="#calculadora-roi" className="hover:text-emerald-400 transition-colors">
              Calculadora ROI
            </a>
            <button
              type="button"
              onClick={() => setWhitepaperOpen(true)}
              className="hover:text-emerald-400 transition-colors flex items-center gap-1"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Anexo Técnico</span>
            </button>
          </nav>

          {/* Action CTAs */}
          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <button
                type="button"
                onClick={onGoToApp}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-600/30"
              >
                <span>Ir a mi Consola</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onGoToApp}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold transition-all hover:border-emerald-500/50"
              >
                <LogIn className="w-3.5 h-3.5 text-emerald-400" />
                <span>Acceso a Despachos</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-12 pb-20 sm:pt-20 sm:pb-28 overflow-hidden">
        {/* Background ambient lighting */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-emerald-500/10 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute top-10 right-10 w-[300px] h-[300px] bg-blue-500/10 blur-[100px] rounded-full pointer-events-none" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            {/* Left Column: Value Proposition & Copy */}
            <div className="lg:col-span-7 space-y-6 text-left">
              {/* Eyebrow Badge */}
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-emerald-500/30 text-emerald-400 text-xs font-semibold tracking-wide shadow-md">
                <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  NOM-151 ACREDITADA · CONDUSEF COMPLIANT · CLOUDFLARE EDGE · TELNYX TIER-1
                </span>
              </div>

              {/* Main Headline */}
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white tracking-tight leading-[1.12]">
                Cobranza Inteligente que{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-emerald-300 to-teal-200">
                  Cumple la Ley al 100%
                </span>
                .
              </h1>

              {/* Subtitle */}
              <p className="text-lg sm:text-xl text-slate-300 font-normal leading-relaxed max-w-2xl">
                La primera plataforma en México construida sobre el borde de{' '}
                <strong>Cloudflare</strong> y la red carrier de <strong>Telnyx</strong> para
                transformar la cobranza extrajudicial en <strong>prueba plena mercantil</strong>,
                deducibilidad fiscal inmediata y acuerdos automatizados por WhatsApp y Voz IA.
              </p>

              {/* Bullet Proof Points */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-xs sm:text-sm text-slate-300">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Constancias NOM-151 y TSA vía ATEB PSC</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Escudo Fail-Closed para REDECO y CONDUSEF</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Voz IA Telnyx con detección de contestadora</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Carpeta SAT CFF 69-B y LISR 27 en 1 clic</span>
                </div>
              </div>

              {/* Hero Action CTAs */}
              <div className="pt-4 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={onGoToApp}
                  className="px-6 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm transition-all shadow-xl shadow-emerald-600/30 flex items-center gap-2 group"
                >
                  <span>Probar Consola Operativa</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>

                <button
                  type="button"
                  onClick={() => setWhitepaperOpen(true)}
                  className="px-6 py-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-semibold text-sm transition-all flex items-center gap-2 hover:border-slate-600"
                >
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span>Ver Dictamen & Ficha Técnica</span>
                </button>
              </div>
            </div>

            {/* Right Column: Interactive 3D Spline / Canvas Shield */}
            <div className="lg:col-span-5 flex items-center justify-center">
              <SplineShieldHero />
            </div>
          </div>
        </div>
      </section>

      {/* Trust Badges & Partner Integration Bar */}
      <section className="py-10 bg-slate-900/70 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center text-xs font-mono font-semibold text-slate-400 uppercase tracking-widest mb-6">
            Infraestructura y Cumplimiento Normativo Respaldado por Líderes de la Industria
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 items-center justify-items-center opacity-85">
            <div className="flex flex-col items-center gap-1 text-center">
              <div className="text-sm font-bold text-white font-mono">ATEB SERVICIOS PSC</div>
              <div className="text-[11px] text-emerald-400">NOM-151 Acreditado por SE</div>
            </div>

            <div className="flex flex-col items-center gap-1 text-center">
              <div className="text-sm font-bold text-white font-mono">CLOUDFLARE EDGE</div>
              <div className="text-[11px] text-blue-400">Workers + R2 Bóveda WORM</div>
            </div>

            <div className="flex flex-col items-center gap-1 text-center">
              <div className="text-sm font-bold text-white font-mono">TELNYX TIER-1</div>
              <div className="text-[11px] text-emerald-400">PSTN & WhatsApp Business API</div>
            </div>

            <div className="flex flex-col items-center gap-1 text-center">
              <div className="text-sm font-bold text-white font-mono">REDECO / CONDUSEF</div>
              <div className="text-[11px] text-amber-400">Escudo Legal Fail-Closed</div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 1: The Legal Shield & NOMs */}
      <ComplianceMatrix />

      {/* Section 2: Technology Architecture & Infrastructure */}
      <TechArchitecture />

      {/* Section 3: Product Tour (How it works in practice) */}
      <ProductTour />

      {/* Section 4: ROI and Compliance Risk Calculator */}
      <RoiCalculator />

      {/* Section 5: FAQs */}
      <section className="py-20 bg-slate-950 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-400 text-xs font-semibold uppercase tracking-wider mb-3">
              <HelpCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>Preguntas Frecuentes de Directores Jurídicos y CFOs</span>
            </div>
            <h2 className="text-3xl font-extrabold text-white">Certeza Operativa y Regulatoria</h2>
          </div>

          <div className="space-y-3">
            {faqs.map((faq, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div
                  key={idx}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                    className="w-full p-5 text-left flex items-center justify-between gap-4 hover:bg-slate-900/90 transition-colors"
                  >
                    <span className="font-semibold text-white text-sm sm:text-base">{faq.q}</span>
                    {isOpen ? (
                      <ChevronUp className="w-5 h-5 text-emerald-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-slate-500 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 text-sm text-slate-300 border-t border-slate-800/80 pt-3 leading-relaxed">
                      {faq.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Final Call To Action */}
      <section className="py-20 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 border-t border-slate-800 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-emerald-500/5 pointer-events-none" />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider bg-emerald-950/80 px-3 py-1 rounded-full border border-emerald-800">
            DESPLIEGUE INMEDIATO EN LA NUBE
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white mt-4 tracking-tight">
            Comienza a Cobrar con Blindaje Legal y Cero Riesgo Regulatorio
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-300 max-w-2xl mx-auto">
            Únete a los despachos, bancos y fintechs en México que ya protegen su reputación,
            reducen sus costos de telefonía y recuperan cartera con prueba plena.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <button
              type="button"
              onClick={onGoToApp}
              className="px-8 py-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm transition-all shadow-xl shadow-emerald-600/30 flex items-center gap-2"
            >
              <span>Acceder a la Consola de Operación</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setWhitepaperOpen(true)}
              className="px-8 py-4 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-bold text-sm transition-all"
            >
              Consultar Especificaciones Técnicas
            </button>
          </div>
        </div>
      </section>

      {/* Enterprise Footer */}
      <footer className="py-12 bg-slate-950 border-t border-slate-800 text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-emerald-400" />
              <span className="font-extrabold text-sm text-white">ARKANGEL</span>
            </div>
            <p className="text-slate-400 leading-relaxed text-xs">
              Plataforma de software empresarial para cobranza judicial y extrajudicial automatizada
              con estricto apego a las leyes y normas mexicanas.
            </p>
            <div className="font-mono text-[11px] text-emerald-400">
              SISTEMAS OPERATIVOS · SLA 99.99%
            </div>
          </div>

          <div>
            <div className="font-bold text-white mb-3 uppercase tracking-wider text-[11px]">
              Marco Normativo
            </div>
            <ul className="space-y-1.5 text-slate-400">
              <li>NOM-151-SCFI-2016 (Prueba Plena)</li>
              <li>NOM-184-SCFI-2018 (Frecuencia)</li>
              <li>Código de Comercio (Art. 1298-A)</li>
              <li>Código Fiscal de la Fed. (Art. 69-B)</li>
              <li>LISR (Art. 27 Fracc. XV Cuentas Incobrables)</li>
              <li>REDECO / CONDUSEF (Cobranza Ética)</li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-white mb-3 uppercase tracking-wider text-[11px]">
              Infraestructura & Alianzas
            </div>
            <ul className="space-y-1.5 text-slate-400">
              <li>Cloudflare Workers (V8 Isolates)</li>
              <li>Cloudflare R2 (Bóveda WORM 10 Años)</li>
              <li>Telnyx Call Control v2 (PSTN Carrier)</li>
              <li>Telnyx WhatsApp Business API</li>
              <li>ATEB Servicios PSC (Proveedor Oficial)</li>
              <li>Workers AI (Llama 3.3 70B Instruct)</li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-white mb-3 uppercase tracking-wider text-[11px]">
              Portales y Verificación
            </div>
            <ul className="space-y-2">
              <li>
                <button
                  type="button"
                  onClick={onGoToApp}
                  className="text-slate-300 hover:text-emerald-400 transition-colors flex items-center gap-1.5"
                >
                  <LogIn className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Consola de Operadores y Despacho</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => {
                    const sampleFolio = prompt('Ingresa el Folio NOM-151 a verificar:');
                    if (sampleFolio && onGoToVerify) onGoToVerify(sampleFolio);
                  }}
                  className="text-slate-300 hover:text-emerald-400 transition-colors flex items-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Verificador Público NOM-151</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => setWhitepaperOpen(true)}
                  className="text-slate-300 hover:text-emerald-400 transition-colors flex items-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Descargar Anexo Técnico y Comercial</span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-400">
          <div>
            © {new Date().getFullYear()} Arkangel LegalTech Platform. Todos los derechos reservados.
          </div>
          <div className="flex gap-4">
            <span className="hover:text-slate-300 cursor-pointer">
              Aviso de Privacidad (LFPDPPP)
            </span>
            <span className="hover:text-slate-300 cursor-pointer">Términos de Servicio</span>
            <span className="hover:text-slate-300 cursor-pointer">Seguridad de la Información</span>
          </div>
        </div>
      </footer>

      {/* Technical Annex / Whitepaper Modal */}
      <TechnicalWhitepaperModal isOpen={whitepaperOpen} onClose={() => setWhitepaperOpen(false)} />
    </div>
  );
};
