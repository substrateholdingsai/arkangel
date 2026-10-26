import React from 'react';
import {
  Cpu,
  Radio,
  Server,
  Shield,
  Layers,
  Database,
  PhoneCall,
  MessageSquare,
  Bot,
  Activity,
} from 'lucide-react';

export const TechArchitecture: React.FC = () => {
  return (
    <section id="infraestructura" className="py-20 bg-slate-950 text-white relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-950/80 border border-blue-500/30 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-4">
            <Server className="w-3.5 h-3.5" />
            <span>Infraestructura de Grado Financiero</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Potenciado por Gigantes Globales: Cloudflare + Telnyx + ATEB PSC
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400">
            Trasladamos la robustez, seguridad bancaria y capacidad de escala de los líderes
            mundiales en telecomunicaciones y edge computing directamente al valor de tu operación.
          </p>
        </div>

        {/* 2 Main Pillar Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
          {/* Cloudflare Pillar */}
          <div className="bg-gradient-to-b from-slate-900 to-slate-900/60 border border-slate-800 rounded-2xl p-6 sm:p-8 relative overflow-hidden group hover:border-blue-500/50 transition-all duration-300">
            <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
              <Cpu className="w-32 h-32 text-blue-400" />
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                <Cpu className="w-6 h-6" />
              </div>
              <div>
                <span className="text-xs font-mono font-bold text-blue-400 uppercase tracking-wider">
                  Cómputo en el Borde & Almacenamiento
                </span>
                <h3 className="text-2xl font-bold text-white">Cloudflare Edge Architecture</h3>
              </div>
            </div>

            <p className="text-slate-300 text-sm leading-relaxed mb-6">
              Sin servidores tradicionales que parchar o que puedan caerse. Toda la lógica de
              Arkangel se ejecuta en centros de datos locales con respuesta en menos de 30
              milisegundos y cero arranque en frío.
            </p>

            <div className="space-y-3.5">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <Database className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">Bóveda Inmutable R2 (WORM)</div>
                  <div className="text-xs text-slate-400">
                    Almacenamiento tipo <em>Write Once, Read Many</em> para audios de llamadas y
                    constancias NOM-151 con retención garantizada de 10 años conforme al Art. 49 del
                    Código de Comercio.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <Bot className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    Workers AI (Llama 3.3 70B Instruct)
                  </div>
                  <div className="text-xs text-slate-400">
                    Modelos de Inteligencia Artificial de 70 mil millones de parámetros corriendo en
                    GPUs aceleradas para redactar respuestas empáticas, analizar intención de pago y
                    resumir negociaciones.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <Layers className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    Cloudflare Queues & D1 Distribuido
                  </div>
                  <div className="text-xs text-slate-400">
                    Procesamiento asíncrono desacoplado para despachar carteras de más de 10,000
                    deudores por minuto sin saturación ni duplicados (idempotencia transaccional).
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>SLA DE DISPONIBILIDAD: 99.99%</span>
              <span className="text-blue-400">LATENCIA CDMX &lt; 25MS</span>
            </div>
          </div>

          {/* Telnyx Pillar */}
          <div className="bg-gradient-to-b from-slate-900 to-slate-900/60 border border-slate-800 rounded-2xl p-6 sm:p-8 relative overflow-hidden group hover:border-emerald-500/50 transition-all duration-300">
            <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
              <Radio className="w-32 h-32 text-emerald-400" />
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                <Radio className="w-6 h-6" />
              </div>
              <div>
                <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider">
                  Telecomunicaciones Carrier Tier-1
                </span>
                <h3 className="text-2xl font-bold text-white">
                  Telnyx Global Telephony & WhatsApp
                </h3>
              </div>
            </div>

            <p className="text-slate-300 text-sm leading-relaxed mb-6">
              Conexión directa a la red telefónica pública conmutada (PSTN) y enlace directo con
              Meta. Sin revendedores ni rutas de baja calidad que provoquen cortes o retrasos de
              audio.
            </p>

            <div className="space-y-3.5">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <PhoneCall className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    Telnyx Call Control v2 + AMD
                  </div>
                  <div className="text-xs text-slate-400">
                    Detección precisa de contestadoras (Answering Machine Detection) en menos de 800
                    ms. Si responde un buzón, corta de inmediato para ahorrar costo; si responde el
                    deudor, enlaza al agente de voz AI.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <MessageSquare className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    WhatsApp Business API Oficial (Meta Verified)
                  </div>
                  <div className="text-xs text-slate-400">
                    Envío de plantillas interactivas autorizadas con botones de pago rápido SPEI y
                    validación criptográfica de entrega y lectura sin riesgo de baneo de línea.
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <Activity className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    Audio Digital Opus y WebRTC en el Navegador
                  </div>
                  <div className="text-xs text-slate-400">
                    Los operadores y supervisores cuentan con softphone integrado directamente en la
                    pantalla de gestión, con grabación estéreo cifrada y transferencia de llamadas
                    en vivo.
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>TELCO TIER-1 MULTI-CARRIER</span>
              <span className="text-emerald-400">AMD ACCURACY 96.8%</span>
            </div>
          </div>
        </div>

        {/* Integration Summary Bar */}
        <div className="p-6 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-bold text-white">
                Conector Oficial ATEB Servicios PSC (Dual-Engine)
              </div>
              <div className="text-xs text-slate-400">
                Timbrado instantáneo ante la Secretaría de Economía con protocolo automático de
                failover preventivo en caso de interrupción del proveedor.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono bg-emerald-950 text-emerald-300 border border-emerald-800 px-3 py-1 rounded-full">
              RFC 3161 TSA · CENAM
            </span>
            <span className="text-xs font-mono bg-blue-950 text-blue-300 border border-blue-800 px-3 py-1 rounded-full">
              TLS 1.3 · HSTS
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
