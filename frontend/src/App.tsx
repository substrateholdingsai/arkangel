import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ChannelBadge,
  DarkPanel,
  DarkRow,
  DataTable,
  Dropzone,
  KpiCard,
  PageShell,
  RateBar,
  StatusBadge,
  StatusPill,
  TopNav,
  type Columna,
} from '@ds';
import { Show, SignIn, UserButton, useAuth } from '@clerk/react';
import {
  api,
  ApiError,
  setTokenProvider,
  type CaseRow,
  type DailyMetrics,
  type LegalEstado,
  type LegalRegla,
} from './api';

const WATERMARK = '/assets/arkangel-watermark.png';
const WATERMARK_DARK = '/assets/arkangel-watermark-dark.png';

function esSesionInvalida(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && error.code === 'unauthorized';
}

const INTENCION_LABEL: Record<string, string> = {
  paga: 'Pago confirmado',
  promete: 'Promesa de pago',
  rechaza: 'Rechaza pagar',
  pide_factura: 'Pide factura',
  pide_info: 'Pide información',
  molesto: 'Molesto',
  no_responde: 'Sin responder',
  otro: 'Otro',
};

function formatMonto(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  });
}

export default function App() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [legal, setLegal] = useState<LegalEstado | null>(null);
  const [reglas, setReglas] = useState<LegalRegla[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disparando, setDisparando] = useState(false);

  useEffect(() => {
    setTokenProvider(() => getToken());
  }, [getToken]);

  const cargar = useCallback(async () => {
    try {
      const [casos, metricas] = await Promise.all([api.todayCases(), api.todayMetrics()]);
      setCases(casos.cases);
      setMetrics(metricas.metrics);
      setError(null);
    } catch (e) {
      if (esSesionInvalida(e)) {
        void signOut();
        return;
      }
      setError(e instanceof Error ? e.message : 'No se pudo leer el estado');
    }
  }, [signOut]);

  useEffect(() => {
    if (isSignedIn) void cargar();
  }, [isSignedIn, cargar]);

  useEffect(() => {
    if (!isSignedIn) return;
    void (async () => {
      try {
        const [estado, catalogo] = await Promise.all([api.legalEstado(), api.legalCatalogo()]);
        setLegal(estado);
        setReglas(catalogo.reglas);
      } catch (e) {
        if (esSesionInvalida(e)) void signOut();
        /* el panel de cumplimiento no debe bloquear la operación */
      }
    })();
  }, [isSignedIn, signOut]);

  // Mientras dispara, se refrescan las métricas en vivo.
  useEffect(() => {
    if (!disparando) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await api.todayMetrics();
        setMetrics(response.metrics);
        if (metrics && response.metrics.enviadas >= metrics.enviadas) {
          setDisparando(false);
          void cargar();
        }
      } catch (e) {
        if (esSesionInvalida(e)) void signOut();
        /* el poll reintenta */
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [disparando, metrics, cargar, signOut]);

  const subirCsv = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        await api.ingestCsv(file);
        await cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Falló la ingesta del CSV');
      } finally {
        setBusy(false);
      }
    },
    [cargar]
  );

  const disparar = async () => {
    setError(null);
    try {
      await api.disparar();
      setDisparando(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo disparar');
    }
  };

  const exportar = () => {
    const header = [
      'Cliente',
      'Telefono',
      'Deuda',
      'Estado',
      'Intension',
      'Ultimo canal',
      'Proxima accion',
    ];
    const rows = cases.map((c) => [
      c.nombre,
      c.telefono ?? '',
      c.monto,
      c.estado_label,
      c.intencion ? (INTENCION_LABEL[c.intencion] ?? c.intencion) : '',
      c.ultimo_canal ?? '',
      c.proxima_accion,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `arkangel-casos-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const columnas: Columna<CaseRow>[] = [
    {
      key: 'cliente',
      header: 'Cliente / CURP',
      render: (row) => (
        <div>
          <div className="font-medium text-slate-900">{row.nombre}</div>
          <div className="text-xs text-slate-500 font-mono">{row.telefono ?? 'sin teléfono'}</div>
        </div>
      ),
    },
    {
      key: 'deuda',
      header: 'Deuda',
      render: (row) => <span className="font-semibold text-slate-900">{row.monto}</span>,
    },
    {
      key: 'canal',
      header: 'Último Canal',
      render: (row) => <ChannelBadge channel={row.ultimo_canal} />,
    },
    {
      key: 'estado',
      header: 'Estado / Intención',
      render: (row) => (
        <div>
          <StatusBadge status={row.estado_label} />
          {row.intencion ? (
            <div className="text-xs text-slate-500 mt-1">
              IA: {INTENCION_LABEL[row.intencion] ?? row.intencion}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'accion',
      header: 'Próxima Acción',
      render: (row) => (
        <span
          className={`text-xs ${row.estado === 'human' ? 'text-rose-600 font-medium' : 'text-slate-500'}`}
        >
          {row.proxima_accion}
        </span>
      ),
    },
  ];

  const porEstado = metrics?.por_estado ?? {};
  const enCola = porEstado.ready ?? 0;
  const escalados = porEstado.human ?? 0;
  const envios = metrics?.enviadas ?? 0;
  const ventana = legal?.ventana ?? { inicio: 8, fin: 22 };

  const nav = (
    <TopNav
      brand="ARKANGEL"
      subtitle="Sistema de Cobranza Autónoma v1.0"
      badges={
        <>
          <StatusPill tone={legal?.identidad_configurada ? 'ok' : 'err'} pulse>
            Workers AI: {legal?.identidad_configurada ? 'Operativo' : 'Identidad pendiente'}
          </StatusPill>
          <StatusPill tone="neutral" icon={Clock}>
            Ventana: {String(ventana.inicio).padStart(2, '0')}:00 -{' '}
            {String(ventana.fin).padStart(2, '0')}:00 CDMX
          </StatusPill>
        </>
      }
      actions={
        <Show when="signed-in">
          <UserButton />
        </Show>
      }
    />
  );

  return (
    <PageShell nav={nav}>
      {!isLoaded ? (
        <div className="flex items-center justify-center mt-10 text-slate-500">Cargando…</div>
      ) : null}

      <Show when="signed-out">
        <Card className="max-w-lg mx-auto mt-10" watermark={WATERMARK}>
          <div className="p-8 text-center space-y-4">
            <div className="flex items-center justify-center">
              <div className="bg-slate-900 text-white p-2 rounded-lg">
                <ShieldCheck className="w-6 h-6" />
              </div>
            </div>
            <h2 className="text-lg font-bold tracking-tight text-slate-900">Inicia sesión</h2>
            <p className="text-xs text-slate-500 font-medium">
              Acceso al panel de cobranza Arkangel
            </p>
            {/* Usamos SignIn embebido (no modal) para que el flujo quede dentro de la SPA */}
            <div className="mt-4 flex justify-center">
              <SignIn routing="hash" />
            </div>
          </div>
        </Card>
      </Show>

      <Show when="signed-in">
        {error ? (
          <div className="mb-6">
            <Alert tone="err" title="Error de operación">
              {error}
            </Alert>
          </div>
        ) : null}

        {legal && !legal.identidad_configurada ? (
          <div className="mb-6">
            <Alert tone="warn" title="Motor legal en fail-closed (regla 1.1 · LFPC Art. 112 Bis)">
              No hay razón social registrada ante CONDUSEF configurada. El agente{' '}
              <strong>no enviará</strong> ningún mensaje hasta que definas{' '}
              <code>LEGAL_RAZON_SOCIAL</code> en las variables del worker. El dashboard sigue
              operativizable y la auditoría queda intacta.
            </Alert>
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <KpiCard
            label="Casos Activos Hoy"
            value={(metrics?.total ?? 0).toLocaleString('es-MX')}
            icon={Briefcase}
            tone="info"
            hint="generados por el CSV de las 6:00 AM"
          />
          <KpiCard
            label="Promesas de Pago (IA)"
            value={(metrics?.promesas ?? 0).toLocaleString('es-MX')}
            icon={CheckCircle2}
            tone="ok"
            hint={`Monto comprometido: ${formatMonto(metrics?.monto_prometido_cents ?? 0)}`}
          />
          <KpiCard
            label="En Cola (Queue)"
            value={enCola.toLocaleString('es-MX')}
            icon={Loader2}
            tone="warn"
            hint={disparando ? 'procesando…' : 'listos para disparo'}
          />
          <KpiCard
            label="Escalados a Humano"
            value={escalados.toLocaleString('es-MX')}
            icon={AlertTriangle}
            tone="err"
            hint={`bloqueos legales hoy: ${legal?.resumen.bloqueos ?? 0}`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-6">
            <Dropzone
              onFile={subirCsv}
              busy={busy}
              columns="Columnas: nombre, telefono, monto, vencimiento"
              hint="o haz clic para seleccionar. Máx 10MB."
            />

            <Card className="p-5" watermark={WATERMARK}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-500">Disparo de cobranza</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">
                    {enCola.toLocaleString('es-MX')} casos
                  </p>
                </div>
                <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
              </div>
              <Button
                variant="accent"
                size="md"
                className="w-full mt-4"
                disabled={enCola === 0 || disparando}
                onClick={disparar}
                icon={Loader2}
              >
                {disparando ? 'Disparando…' : 'Disparar cobranza de hoy'}
              </Button>
              <p className="mt-3 text-xs text-slate-500">
                1 click · dispara {enCola.toLocaleString('es-MX')} casos · ventana legal{' '}
                {String(ventana.inicio).padStart(2, '0')}:00–{String(ventana.fin).padStart(2, '0')}
                :00 CDMX
              </p>
            </Card>

            <DarkPanel title="Estado del Sistema" icon={Activity} watermark={WATERMARK_DARK}>
              <div className="space-y-3 text-xs font-mono">
                <DarkRow label="D1 Database" value="OK" />
                <DarkRow label="Workers AI (redactMessage)" value="Operativo" />
                <DarkRow
                  label="arkangel-cobranza-queue"
                  value={`${enCola} pendientes`}
                  tone={enCola > 0 ? 'warn' : 'ok'}
                />
                <DarkRow
                  label="Motor legal (12 reglas)"
                  value={legal?.identidad_configurada ? 'OK' : 'Bloqueado'}
                  tone={legal?.identidad_configurada ? 'ok' : 'err'}
                />
                <DarkRow
                  label="Ventana legal (NOM-184)"
                  value={`${String(ventana.inicio).padStart(2, '0')}:00-${String(ventana.fin).padStart(2, '0')}:00`}
                  tone="muted"
                />
                <div className="pt-3 mt-3 border-t border-slate-800 space-y-3">
                  <RateBar label="Rate Limit (WhatsApp)" value={envios % 42} max={42} />
                  <DarkRow
                    label="Mensajes enviados hoy"
                    value={envios.toLocaleString('es-MX')}
                    tone="muted"
                  />
                </div>
              </div>
            </DarkPanel>
          </div>

          <div className="lg:col-span-2">
            <Card className="overflow-hidden">
              <CardHeader
                title="Casos del Día"
                subtitle={`${cases.length} registro(s) · ingestado a las 6:00 AM`}
                actions={
                  <>
                    <Button icon={Download} onClick={exportar} disabled={cases.length === 0}>
                      Exportar
                    </Button>
                    <Button
                      variant="primary"
                      onClick={disparar}
                      disabled={enCola === 0 || disparando}
                      icon={Loader2}
                    >
                      Disparar
                    </Button>
                  </>
                }
              />
              <DataTable
                columns={columnas}
                rows={cases}
                empty="Sin casos: sube el CSV de las 6:00 AM o espera la ingesta del CRM."
                rowClassName={(row) => (row.estado === 'human' ? 'bg-rose-50/30' : '')}
              />
              <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-between items-center text-xs text-slate-500">
                <span>
                  Mostrando {cases.length} de {cases.length} casos
                </span>
                <div className="flex gap-1">
                  <button
                    className="px-2 py-1 border border-slate-300 rounded bg-white disabled:opacity-50"
                    disabled
                  >
                    Anterior
                  </button>
                  <button className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50">
                    Siguiente
                  </button>
                </div>
              </div>
            </Card>

            <Card className="mt-6 overflow-hidden" watermark={WATERMARK}>
              <CardHeader
                title="Motor de cumplimiento — la ley como código"
                subtitle="Catálogo legal ejecutable, aplicado antes de cada contacto"
                actions={
                  <StatusPill tone={legal?.identidad_configurada ? 'ok' : 'err'} icon={Scale}>
                    {legal?.identidad_configurada ? 'IDENTIDAD OK' : 'FALTA RAZÓN SOCIAL'}
                  </StatusPill>
                }
              />
              <div className="p-6">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { k: 'Bloqueados', v: legal?.resumen.bloqueos ?? 0, c: 'text-rose-600' },
                    { k: 'Reparados', v: legal?.resumen.saneos ?? 0, c: 'text-amber-600' },
                    { k: 'Escalados', v: legal?.resumen.escalados ?? 0, c: 'text-emerald-600' },
                  ].map((item) => (
                    <div
                      key={item.k}
                      className="rounded-lg border border-slate-200 bg-slate-50 p-4"
                    >
                      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                        {item.k}
                      </p>
                      <p className={`mt-1 text-2xl font-bold ${item.c}`}>{item.v}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 divide-y divide-slate-100">
                  {reglas.map((regla) => (
                    <div
                      key={regla.id}
                      className="flex items-start justify-between gap-4 py-2.5 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800">
                          <span className="font-mono text-emerald-700">{regla.id}</span> ·{' '}
                          {regla.conducta}
                        </p>
                        <p className="font-mono text-slate-400 mt-0.5">
                          {regla.ley} {regla.articulo}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-400">
                        {regla.accion}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="mt-4 text-[11px] leading-relaxed text-slate-400 font-mono">
                  Máximo {legal?.max_contactos_24h ?? 3} impactos por deudor en 24 h · dominios de
                  pago permitidos:{' '}
                  {legal?.dominios_permitidos.length
                    ? legal.dominios_permitidos.join(', ')
                    : 'ninguno'}{' '}
                  · razón social {legal?.nombre_legal ?? 'NO CONFIGURADA'}
                  {legal?.condusef ? ` · CONDUSEF ${legal.condusef}` : ''}
                </p>
              </div>
            </Card>
          </div>
        </div>
      </Show>
    </PageShell>
  );
}
