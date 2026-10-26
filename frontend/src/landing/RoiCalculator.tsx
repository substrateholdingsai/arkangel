import React, { useState } from 'react';
import { Calculator, TrendingUp, ShieldAlert, Clock, Sparkles } from 'lucide-react';

export const RoiCalculator: React.FC = () => {
  const [portfolioAmount, setPortfolioAmount] = useState<number>(3500000); // 3.5M MXN
  const [debtorsCount, setDebtorsCount] = useState<number>(600);
  const [currentRecoveryRate, setCurrentRecoveryRate] = useState<number>(10); // 10%

  // Arkangel estimated rate (typically 24% to 34% with omni-channel + self-service portal)
  const arkangelRate = Math.min(38, Math.max(22, currentRecoveryRate * 2.4));

  // Dollar values
  const currentRecoveryMXN = (portfolioAmount * currentRecoveryRate) / 100;
  const arkangelRecoveryMXN = (portfolioAmount * arkangelRate) / 100;
  const incrementalRecoveryMXN = arkangelRecoveryMXN - currentRecoveryMXN;

  // Operational hours saved (avg 18 mins per traditional debtor touch vs 1.5 mins automated)
  const hoursSavedPerMonth = Math.round((debtorsCount * 16.5) / 60);

  // Legal protection value (avoidance of at least 1 severe CONDUSEF/REDECO complaint or fine, min fine $65,000 MXN)
  const legalProtectionScore = Math.min(1600000, Math.max(120000, debtorsCount * 450));

  // Fiscal deduction shield (30% ISR corporate rate on uncollected accounts with proof of exhaustion)
  const uncollectedBalance = portfolioAmount - arkangelRecoveryMXN;
  const fiscalShieldMXN = uncollectedBalance * 0.3;

  const formatMXN = (val: number) => {
    return val.toLocaleString('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 0,
    });
  };

  return (
    <section
      id="calculadora-roi"
      className="py-20 bg-slate-900 border-t border-slate-800 text-white relative"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-4">
            <Calculator className="w-3.5 h-3.5" />
            <span>Simulador Financiero y de Cumplimiento</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Calcula el Retorno de Inversión y Blindaje Patrimonial
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-300">
            Compara el rendimiento de tu cobranza tradicional contra el modelo automatizado y
            certificado de Arkangel.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Controls Panel */}
          <div className="lg:col-span-5 bg-slate-950/80 border border-slate-800 rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
            <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
              <span>Parámetros de tu Cartera</span>
            </h3>

            <div className="space-y-6">
              {/* Slider 1: Monto de Cartera */}
              <div>
                <div className="flex justify-between items-center text-sm mb-2">
                  <span className="text-slate-300 font-medium">Monto Total de Cartera Vencida</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {formatMXN(portfolioAmount)}
                  </span>
                </div>
                <input
                  type="range"
                  min={300000}
                  max={25000000}
                  step={200000}
                  value={portfolioAmount}
                  onChange={(e) => setPortfolioAmount(Number(e.target.value))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                />
                <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                  <span>$300K MXN</span>
                  <span>$10M MXN</span>
                  <span>$25M MXN</span>
                </div>
              </div>

              {/* Slider 2: Número de Deudores */}
              <div>
                <div className="flex justify-between items-center text-sm mb-2">
                  <span className="text-slate-300 font-medium">Número de Casos / Deudores</span>
                  <span className="font-mono font-bold text-blue-400">
                    {debtorsCount.toLocaleString('es-MX')} cuentas
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={50}
                  value={debtorsCount}
                  onChange={(e) => setDebtorsCount(Number(e.target.value))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                  <span>50</span>
                  <span>2,500</span>
                  <span>5,000</span>
                </div>
              </div>

              {/* Slider 3: Tasa de Recuperación Actual */}
              <div>
                <div className="flex justify-between items-center text-sm mb-2">
                  <span className="text-slate-300 font-medium">
                    Tasa de Recuperación Actual (Call Center / Manual)
                  </span>
                  <span className="font-mono font-bold text-slate-300">{currentRecoveryRate}%</span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={20}
                  step={1}
                  value={currentRecoveryRate}
                  onChange={(e) => setCurrentRecoveryRate(Number(e.target.value))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-slate-400"
                />
                <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                  <span>3% (Crítica)</span>
                  <span>10% (Promedio)</span>
                  <span>20% (Alta manual)</span>
                </div>
              </div>
            </div>

            <div className="mt-8 p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-400">
              <span className="text-emerald-400 font-semibold">Nota técnica:</span> La tasa estimada
              de Arkangel ({arkangelRate.toFixed(1)}%) se basa en la combinación de autoservicio
              SPEI 24/7 sin confrontación y llamadas contextuales Telnyx en horas óptimas legales.
            </div>
          </div>

          {/* Impact Results Cards */}
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Card 1: Recuperación Adicional */}
            <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-950/60 to-slate-950 border border-emerald-500/40 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider">
                    Flujo de Efectivo
                  </span>
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="text-xs text-slate-300 mb-1">Recuperación Adicional Estimada</div>
                <div className="text-3xl font-extrabold text-white font-mono tracking-tight">
                  +{formatMXN(incrementalRecoveryMXN)}
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-emerald-900/50 text-xs text-emerald-200/80">
                Pasa de {formatMXN(currentRecoveryMXN)} a{' '}
                <strong className="text-white">{formatMXN(arkangelRecoveryMXN)}</strong> mensuales.
              </div>
            </div>

            {/* Card 2: Ahorro en Horas Gestor */}
            <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold text-blue-400 uppercase tracking-wider">
                    Eficiencia Operativa
                  </span>
                  <Clock className="w-5 h-5 text-blue-400" />
                </div>
                <div className="text-xs text-slate-300 mb-1">Tiempo de Marcación Ahorrado</div>
                <div className="text-3xl font-extrabold text-white font-mono tracking-tight">
                  {hoursSavedPerMonth.toLocaleString('es-MX')} hrs / mes
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-400">
                Equivalente al trabajo de{' '}
                <strong className="text-slate-200">
                  {Math.max(1, Math.round(hoursSavedPerMonth / 160))} gestores de tiempo completo
                </strong>{' '}
                reenfocados a cuentas VIP.
              </div>
            </div>

            {/* Card 3: Mitigación de Multas CONDUSEF */}
            <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold text-amber-400 uppercase tracking-wider">
                    Riesgo Legal Evitado
                  </span>
                  <ShieldAlert className="w-5 h-5 text-amber-400" />
                </div>
                <div className="text-xs text-slate-300 mb-1">Riesgo en Multas REDECO Mitigado</div>
                <div className="text-3xl font-extrabold text-white font-mono tracking-tight">
                  {formatMXN(legalProtectionScore)}
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-400">
                Evita sanciones que oscilan entre{' '}
                <strong className="text-slate-200">$40,000 y $1,600,000 MXN</strong> por prácticas
                intimidatorias no auditadas.
              </div>
            </div>

            {/* Card 4: Escudo Fiscal SAT */}
            <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold text-purple-400 uppercase tracking-wider">
                    Beneficio Fiscal
                  </span>
                  <Sparkles className="w-5 h-5 text-purple-400" />
                </div>
                <div className="text-xs text-slate-300 mb-1">
                  Escudo de Deducibilidad ISR (LISR 27)
                </div>
                <div className="text-3xl font-extrabold text-white font-mono tracking-tight">
                  {formatMXN(fiscalShieldMXN)}
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-400">
                Ahorro fiscal potencial al castigar cartera con expediente de imposibilidad práctica
                certificado en 1 clic.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
