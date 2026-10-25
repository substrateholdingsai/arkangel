import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  Bot,
  Briefcase,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Loader2,
  LogOut,
  PhoneCall,
  Scale,
  Search,
  Settings,
  Sparkles,
  X,
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
import {
  api,
  ApiError,
  type CaseRow,
  type DailyMetrics,
  type LegalEstado,
  type LegalRegla,
  type SystemStatus,
} from './api';
import { AccountingReportModal } from './AccountingReportModal';
import { AuthGate } from './auth/AuthGate';
import { useAuth } from './auth/AuthContext';
import { CopilotWidget } from './CopilotWidget';
import { OperatorDrawer } from './OperatorDrawer';
import { TenantSettingsModal } from './TenantSettingsModal';
import { DebtorPortal } from './DebtorPortal';
import { Nom151Modal } from './Nom151Modal';

function getPortalIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname;
  const match = path.match(/^\/(?:pay|portal)\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  const params = new URLSearchParams(window.location.search);
  return params.get('pay') || params.get('portal') || null;
}

function getNom151FolioFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname;
  const match = path.match(/^\/verify\/nom151\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  const params = new URLSearchParams(window.location.search);
  return params.get('nom151') || null;
}

const WATERMARK = '/assets/arkangel-watermark.png';
const WATERMARK_DARK = '/assets/arkangel-watermark-dark.png';

function esSesionInvalida(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
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
  const { session, loading, tenants, activeTenant, switchTenant, logout } = useAuth();
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [legal, setLegal] = useState<LegalEstado | null>(null);
  const [reglas, setReglas] = useState<LegalRegla[]>([]);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null);
  const [disparando, setDisparando] = useState(false);
  const [bandeja, setBandeja] = useState<'all' | 'human' | 'resolved'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'nombre' | 'monto' | 'estado' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountingOpen, setAccountingOpen] = useState(false);
  const [portalId, setPortalId] = useState<string | null>(() => getPortalIdFromUrl());
  const [nom151Folio, setNom151Folio] = useState<string | null>(() => getNom151FolioFromUrl());

  useEffect(() => {
    const handlePopState = () => {
      setPortalId(getPortalIdFromUrl());
      setNom151Folio(getNom151FolioFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const conectado = session !== null;
  const tenantId = activeTenant?.tenantId ?? null;
  const role = activeTenant?.role ?? 'member';
  const isManager = role === 'owner' || session?.platformRole === 'super_admin';
  const isOperator = isManager || role === 'admin';
  const canViewAccounting = isManager || role === 'member';
  const roleLabel = isManager
    ? 'Manager'
    : role === 'admin'
      ? 'Agente Operativo'
      : 'Auditor (Lectura)';

  const cargar = useCallback(async () => {
    try {
      const [casos, metricas, status] = await Promise.all([
        api.todayCases(),
        api.todayMetrics(),
        api.systemStatus().catch(() => null),
      ]);
      setCases(casos.cases);
      setMetrics(metricas.metrics);
      if (status) setSys(status);
      setError(null);
    } catch (e) {
      if (esSesionInvalida(e)) {
        void logout();
        return;
      }
      setError(e instanceof Error ? e.message : 'No se pudo leer el estado');
    }
  }, [logout]);

  const recargarLegal = useCallback(async () => {
    try {
      const [estado, catalogo] = await Promise.all([api.legalEstado(), api.legalCatalogo()]);
      setLegal(estado);
      setReglas(catalogo.reglas);
    } catch (e) {
      if (esSesionInvalida(e)) void logout();
      /* el panel de cumplimiento no debe bloquear la operación */
    }
  }, [logout]);

  useEffect(() => {
    if (conectado) void cargar();
  }, [conectado, cargar, tenantId]);

  useEffect(() => {
    if (!conectado) return;
    void recargarLegal();
  }, [conectado, recargarLegal, tenantId]);

  // Refresco continuo de telemetría en vivo cada 15s
  useEffect(() => {
    if (!conectado) return;
    const timer = window.setInterval(async () => {
      try {
        const status = await api.systemStatus();
        setSys(status);
      } catch (e) {
        if (esSesionInvalida(e)) void logout();
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [conectado, logout, tenantId]);

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
        if (esSesionInvalida(e)) void logout();
        /* el poll reintenta */
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [disparando, metrics, cargar, logout]);

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
    const listToExport = casosOrdenados.length > 0 ? casosOrdenados : cases;
    const header = [
      'Cliente',
      'Telefono',
      'Deuda',
      'Estado',
      'Intension',
      'Ultimo canal',
      'Proxima accion',
    ];
    const rows = listToExport.map((c) => [
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

  const descargarCsvPrueba = () => {
    const sampleRows = [
      ['nombre', 'telefono', 'email', 'monto', 'vencimiento', 'folio'],
      [
        'Valeria Montoya Ríos',
        '+525541239801',
        'valeria.montoya@ejemplo.mx',
        '$4,850.00',
        '2026-09-25',
        'EXP-2026-101',
      ],
      [
        'Alejandro Cárdenas Vega',
        '+525582341902',
        'acardenas@ejemplo.mx',
        '$12,400.00',
        '2026-08-14',
        'EXP-2026-102',
      ],
      [
        'Mariana Solís Echeverría',
        '+523319874503',
        'mariana.solis@ejemplo.mx',
        '$2,150.00',
        '2026-10-05',
        'EXP-2026-103',
      ],
      [
        'Héctor Villalobos Méndez',
        '+528187654304',
        'hvillalobos@ejemplo.mx',
        '$19,800.00',
        '2026-07-20',
        'EXP-2026-104',
      ],
      [
        'Sofía Castellanos Luna',
        '+525571112205',
        'sofia.luna@ejemplo.mx',
        '$6,300.00',
        '2026-09-10',
        'EXP-2026-105',
      ],
    ];
    const csv = sampleRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'arkangel-demo-deudores.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const descargarCsvPagosPrueba = () => {
    const samplePayments = [
      ['clabe', 'monto', 'clave_rastreo', 'referencia', 'telefono'],
      ['646180157000000505', '$12,400.00', '20261022COBRE88101', 'Folio 8390', '+525560987654'],
      ['646180157000000303', '$3,900.00', '20261022BBVA88102', 'Folio 9104', '+528183456789'],
    ];
    const csv = samplePayments
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'arkangel-demo-pagos-tesoreria.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const subirCsvPagos = async (file: File) => {
    setReconciling(true);
    setError(null);
    setReconcileNotice(null);
    try {
      const res = await api.reconcilePaymentsCsv(file);
      setReconcileNotice(
        `Conciliación completada: ${res.reconciled} pago(s) aplicado(s) (${formatMonto(res.totalReconciledCents)}), ${res.duplicate} duplicado(s), ${res.unmatched} sin match.`
      );
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falló la conciliación de pagos');
    } finally {
      setReconciling(false);
    }
  };

  const toggleSort = (field: 'nombre' | 'monto' | 'estado') => {
    if (sortBy === field) {
      if (sortDir === 'asc') {
        setSortDir('desc');
      } else {
        setSortBy(null);
      }
    } else {
      setSortBy(field);
      setSortDir(field === 'monto' ? 'desc' : 'asc');
    }
    setCurrentPage(1);
  };

  const columnas: Columna<CaseRow>[] = [
    {
      key: 'cliente',
      header: (
        <button
          type="button"
          onClick={() => toggleSort('nombre')}
          className="inline-flex items-center gap-1.5 font-semibold text-slate-700 hover:text-slate-900 transition-colors"
          title="Ordenar por nombre de cliente"
        >
          <span>Cliente / CURP</span>
          {sortBy === 'nombre' ? (
            sortDir === 'asc' ? (
              <ArrowUp className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <ArrowDown className="w-3.5 h-3.5 text-emerald-600" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-slate-400 hover:text-slate-600" />
          )}
        </button>
      ),
      render: (row) => (
        <div>
          <div className="font-medium text-slate-900">{row.nombre}</div>
          <div className="text-xs text-slate-500 font-mono">{row.telefono ?? 'sin teléfono'}</div>
        </div>
      ),
    },
    {
      key: 'deuda',
      header: (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => toggleSort('monto')}
            className="inline-flex items-center gap-1.5 font-semibold text-slate-700 hover:text-slate-900 transition-colors"
            title="Ordenar por monto de deuda"
          >
            <span>Deuda</span>
            {sortBy === 'monto' ? (
              sortDir === 'asc' ? (
                <ArrowUp className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <ArrowDown className="w-3.5 h-3.5 text-emerald-600" />
              )
            ) : (
              <ArrowUpDown className="w-3 h-3 text-slate-400 hover:text-slate-600" />
            )}
          </button>
        </div>
      ),
      className: 'text-right',
      render: (row) => <span className="data-value font-medium text-slate-900">{row.monto}</span>,
    },
    {
      key: 'canal',
      header: 'Último Canal',
      render: (row) => <ChannelBadge channel={row.ultimo_canal} />,
    },
    {
      key: 'estado',
      header: (
        <button
          type="button"
          onClick={() => toggleSort('estado')}
          className="inline-flex items-center gap-1.5 font-semibold text-slate-700 hover:text-slate-900 transition-colors"
          title="Ordenar por estado"
        >
          <span>Estado / Intención</span>
          {sortBy === 'estado' ? (
            sortDir === 'asc' ? (
              <ArrowUp className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <ArrowDown className="w-3.5 h-3.5 text-emerald-600" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-slate-400 hover:text-slate-600" />
          )}
        </button>
      ),
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
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-xs ${row.estado === 'human' ? 'text-red-600 font-medium' : 'text-slate-500'}`}
          >
            {row.proxima_accion}
          </span>
          <Button
            variant={row.estado === 'human' ? 'danger' : 'secondary'}
            size="sm"
            onClick={() => setSelectedCaseId(row.id)}
          >
            {row.estado === 'human' ? 'Atender' : 'Abrir'}
          </Button>
        </div>
      ),
    },
  ];

  const casosDeBandeja = cases.filter((c) => {
    if (bandeja === 'human') return c.estado === 'human';
    if (bandeja === 'resolved') return c.estado === 'promised' || c.estado === 'paid';
    return true;
  });
  const countHuman = cases.filter((c) => c.estado === 'human').length;
  const countResolved = cases.filter((c) => c.estado === 'promised' || c.estado === 'paid').length;

  const queryNormalizada = searchQuery.trim().toLowerCase();
  const casosFiltrados = casosDeBandeja.filter((c) => {
    if (!queryNormalizada) return true;
    const nombre = (c.nombre ?? '').toLowerCase();
    const tel = (c.telefono ?? '').toLowerCase();
    const email = (c.email ?? '').toLowerCase();
    const id = (c.id ?? '').toLowerCase();
    const clientId = (c.client_id ?? '').toLowerCase();
    const estado = (c.estado_label ?? '').toLowerCase();
    const intencion = (
      c.intencion ? (INTENCION_LABEL[c.intencion] ?? c.intencion) : ''
    ).toLowerCase();
    return (
      nombre.includes(queryNormalizada) ||
      tel.includes(queryNormalizada) ||
      email.includes(queryNormalizada) ||
      id.includes(queryNormalizada) ||
      clientId.includes(queryNormalizada) ||
      estado.includes(queryNormalizada) ||
      intencion.includes(queryNormalizada)
    );
  });

  const casosOrdenados = [...casosFiltrados].sort((a, b) => {
    if (!sortBy) return 0;
    const factor = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'monto') {
      return (a.monto_cents - b.monto_cents) * factor;
    }
    if (sortBy === 'nombre') {
      return a.nombre.localeCompare(b.nombre, 'es-MX') * factor;
    }
    if (sortBy === 'estado') {
      return a.estado_label.localeCompare(b.estado_label, 'es-MX') * factor;
    }
    return 0;
  });

  const totalCasosFiltrados = casosOrdenados.length;
  const totalPages = Math.max(1, Math.ceil(totalCasosFiltrados / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalCasosFiltrados);
  const casosPaginados = casosOrdenados.slice(startIndex, endIndex);

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
        conectado ? (
          <>
            {tenants.length > 0 ? (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                <span className="hidden sm:inline">Despacho</span>
                <select
                  value={activeTenant?.tenantId ?? ''}
                  onChange={(evento) => switchTenant(evento.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
                  title="Despacho activo"
                >
                  {tenants.map((tenant) => (
                    <option key={tenant.tenantId} value={tenant.tenantId}>
                      {tenant.tenantName} · {tenant.role}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span
              className={`hidden sm:inline-flex items-center rounded-md px-2 py-1 text-[11px] font-mono font-semibold border ${
                isManager
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : role === 'admin'
                    ? 'bg-slate-900 text-white border-slate-800'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
              title={`Nivel de acceso activo: ${roleLabel}`}
            >
              {roleLabel}
            </span>
            {canViewAccounting ? (
              <Button
                variant="secondary"
                size="sm"
                icon={BookOpen}
                onClick={() => setAccountingOpen(true)}
              >
                Contabilidad
              </Button>
            ) : null}
            {isManager ? (
              <Button
                variant="secondary"
                size="sm"
                icon={Settings}
                onClick={() => setSettingsOpen(true)}
              >
                Configurar
              </Button>
            ) : null}
            <span className="hidden md:inline text-xs text-slate-500">
              {session?.user.fullName || session?.user.email}
            </span>
            <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void logout()}>
              <span className="sr-only">Salir</span>
            </Button>
          </>
        ) : null
      }
    />
  );

  if (portalId) {
    return (
      <DebtorPortal
        portalId={portalId}
        onBackToDashboard={() => {
          setPortalId(null);
          window.history.pushState({}, '', '/');
        }}
      />
    );
  }

  if (nom151Folio) {
    return (
      <Nom151Modal
        folio={nom151Folio}
        onClose={() => {
          setNom151Folio(null);
          window.history.pushState({}, '', '/');
        }}
      />
    );
  }

  return (
    <PageShell nav={nav}>
      {loading ? (
        <div className="flex items-center justify-center mt-10 text-slate-500">Cargando…</div>
      ) : null}

      {!loading && !conectado ? <AuthGate /> : null}

      {conectado ? (
        <>
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
                <strong>no enviará</strong> ningún mensaje hasta que{' '}
                {isManager ? (
                  <>
                    configures tu identidad legal en{' '}
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(true)}
                      className="font-semibold underline underline-offset-2 text-amber-900 hover:text-amber-700"
                    >
                      Configuración del Despacho
                    </button>
                  </>
                ) : (
                  <strong>el Manager del despacho configure la identidad legal</strong>
                )}
                . El dashboard sigue operativizable y la auditoría queda intacta.
              </Alert>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
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

          {/* KPIs Telefonía & Voice AI (Telnyx) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <KpiCard
              label="Minutos Hablados Hoy"
              value={`${(metrics?.minutos_voz_hoy ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min`}
              icon={PhoneCall}
              tone="info"
              hint="Telefonía PSTN celular / Telnyx Voice"
            />
            <KpiCard
              label="Llamadas Completadas (Voice AI)"
              value={(metrics?.llamadas_voz_hoy ?? 0).toLocaleString('es-MX')}
              icon={Bot}
              tone="ok"
              hint="Conversaciones gestionadas por Voice AI"
            />
            <KpiCard
              label="Promesas Detectadas en Audio"
              value={(metrics?.promesas_voz_hoy ?? 0).toLocaleString('es-MX')}
              icon={Sparkles}
              tone="ok"
              hint="Compromisos extraídos del diálogo de voz"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-1 space-y-6">
              {isManager ? (
                <div className="space-y-2">
                  <Dropzone
                    onFile={subirCsv}
                    busy={busy}
                    columns="Columnas: nombre, telefono, monto, vencimiento"
                    hint="o haz clic para seleccionar. Máx 10MB."
                  />
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] text-slate-500">
                      ¿Sin archivo a la mano? Prueba la ingesta con datos sintéticos:
                    </span>
                    <button
                      type="button"
                      onClick={descargarCsvPrueba}
                      className="text-[11px] font-medium text-emerald-700 hover:text-emerald-600 underline underline-offset-2"
                    >
                      Descargar CSV de prueba
                    </button>
                  </div>
                </div>
              ) : (
                <Card className="p-5 border-l-4 border-l-emerald-600">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                        Vista Operativa · {roleLabel}
                      </p>
                      <p className="text-sm font-semibold text-slate-900 mt-0.5">
                        {isOperator
                          ? 'Enfoque 100% en recuperación y atención de casos'
                          : 'Modo consulta de expedientes y cumplimiento'}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                    {isOperator
                      ? `Tienes ${countHuman} caso(s) delegados a humano esperando gestión directa y ${countResolved} promesa(s)/pago(s) cerrados hoy.`
                      : 'Acceso de auditoría en tiempo real sobre cartera, reglas CONDUSEF y corte contable.'}
                  </p>
                  {isOperator && countHuman > 0 ? (
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-full mt-3"
                      onClick={() => {
                        setBandeja('human');
                        const firstHuman = cases.find((c) => c.estado === 'human');
                        if (firstHuman) setSelectedCaseId(firstHuman.id);
                      }}
                    >
                      Atender siguiente caso urgente ({countHuman})
                    </Button>
                  ) : null}
                </Card>
              )}

              {isOperator ? (
                <>
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
                      {String(ventana.inicio).padStart(2, '0')}:00–
                      {String(ventana.fin).padStart(2, '0')}
                      :00 CDMX
                    </p>
                  </Card>

                  <Card className="p-5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                          Conciliación de Pagos
                        </p>
                        <p className="text-sm font-semibold text-slate-900 mt-0.5">
                          Cobre · Conekta · CSV Legacy
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-emerald-700 border border-emerald-200">
                          /webhooks/cobre
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-700 border border-slate-200">
                          /webhooks/conekta
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                      Retira al instante de la cola a quienes ya pagaron vía SPEI (Cobre Enterprise
                      o Conekta PyME) o subiendo el CSV bancario (BBVA / Banorte / STP).
                    </p>
                    {reconcileNotice ? (
                      <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-900">
                        {reconcileNotice}
                      </div>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2">
                      <label className="flex-1 cursor-pointer inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors">
                        <span>{reconciling ? 'Conciliando…' : 'Subir CSV de Pagos'}</span>
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          disabled={reconciling}
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void subirCsvPagos(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={descargarCsvPagosPrueba}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
                        title="Descargar CSV de pagos bancarios de ejemplo"
                      >
                        CSV ejemplo
                      </button>
                    </div>
                  </Card>
                </>
              ) : null}

              <DarkPanel title="Estado del Sistema" icon={Activity} watermark={WATERMARK_DARK}>
                <div className="space-y-3 text-xs font-mono">
                  <DarkRow
                    label="D1 Database"
                    value={
                      sys
                        ? sys.d1.ok
                          ? `OK · ${sys.d1.latency_ms}ms (${sys.d1.clients_total} cte)`
                          : 'Error D1'
                        : 'Conectando…'
                    }
                    tone={!sys ? 'muted' : sys.d1.ok ? 'ok' : 'err'}
                  />
                  <DarkRow
                    label={`Workers AI (${sys?.workers_ai.model ?? 'llama-3.3-70b'})`}
                    value={
                      sys
                        ? sys.workers_ai.ok
                          ? sys.workers_ai.dry_run
                            ? 'Dry-Run'
                            : 'Operativo'
                          : 'Sin binding'
                        : 'Verificando…'
                    }
                    tone={!sys ? 'muted' : sys.workers_ai.ok ? 'ok' : 'err'}
                  />
                  <DarkRow
                    label="arkangel-cobranza-queue"
                    value={
                      sys
                        ? sys.queue.sending > 0
                          ? `${sys.queue.ready} listos · ${sys.queue.sending} env.`
                          : `${sys.queue.ready} pendientes`
                        : `${enCola} pendientes`
                    }
                    tone={(sys?.queue.ready ?? enCola) > 0 ? 'warn' : 'ok'}
                  />
                  <DarkRow
                    label={`Motor legal (${sys?.legal_engine.reglas_activas ?? 12} reglas · ${sys?.legal_engine.conductas_auditadas ?? 48} cond.)`}
                    value={
                      (sys?.legal_engine.ok ?? legal?.identidad_configurada)
                        ? `OK${sys?.legal_engine.condusef ? ` · ${sys.legal_engine.condusef}` : ''}`
                        : 'Bloqueado (Fail-closed)'
                    }
                    tone={(sys?.legal_engine.ok ?? legal?.identidad_configurada) ? 'ok' : 'err'}
                  />
                  <DarkRow
                    label="Ventana legal (NOM-184)"
                    value={`${String(ventana.inicio).padStart(2, '0')}:00-${String(ventana.fin).padStart(2, '0')}:00 · ${
                      sys ? (sys.ventana.abierta_ahora ? 'Abierta' : 'Cerrada') : 'CDMX'
                    }`}
                    tone={!sys ? 'muted' : sys.ventana.abierta_ahora ? 'ok' : 'warn'}
                  />
                  <div className="pt-3 mt-3 border-t border-slate-800 space-y-3">
                    <RateBar
                      label="Rate Limit (WhatsApp RPM)"
                      value={sys?.rate_limit.whatsapp_rpm ?? 0}
                      max={sys?.rate_limit.max_rpm ?? 42}
                    />
                    <DarkRow
                      label="Mensajes enviados hoy"
                      value={(sys?.rate_limit.enviados_hoy ?? envios).toLocaleString('es-MX')}
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
                      {isOperator ? (
                        <Button
                          variant="primary"
                          onClick={disparar}
                          disabled={enCola === 0 || disparando}
                          icon={Loader2}
                        >
                          Disparar
                        </Button>
                      ) : null}
                    </>
                  }
                />
                <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setBandeja('all');
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${
                        bandeja === 'all'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      Todos ({cases.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBandeja('human');
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors flex items-center gap-1.5 ${
                        bandeja === 'human'
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-white text-red-700 border-red-200 hover:bg-red-50'
                      }`}
                    >
                      <span>Delegados a Humano</span>
                      <span className="data-mono px-1.5 py-0.2 rounded bg-red-100 text-red-800 text-[11px]">
                        {countHuman}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBandeja('resolved');
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${
                        bandeja === 'resolved'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      Promesas / Pagados ({countResolved})
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative flex-1 sm:w-64">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setCurrentPage(1);
                        }}
                        placeholder="Buscar deudor, teléfono o ID…"
                        className="w-full rounded-md border border-slate-300 bg-white pl-8 pr-7 py-1 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
                      />
                      {searchQuery ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setCurrentPage(1);
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                          title="Limpiar búsqueda"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      ) : null}
                    </div>

                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setCurrentPage(1);
                      }}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
                      title="Casos por página"
                    >
                      <option value={10}>10 / pág</option>
                      <option value={15}>15 / pág</option>
                      <option value={25}>25 / pág</option>
                      <option value={50}>50 / pág</option>
                    </select>
                  </div>
                </div>
                <DataTable
                  columns={columnas}
                  rows={casosPaginados}
                  empty={
                    searchQuery ? (
                      <div className="py-4 text-center">
                        <p className="text-slate-600 font-medium">
                          No se encontraron casos que coincidan con &ldquo;{searchQuery}&rdquo;.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setCurrentPage(1);
                          }}
                          className="mt-2 text-xs font-semibold text-emerald-700 hover:underline"
                        >
                          Limpiar filtro de búsqueda
                        </button>
                      </div>
                    ) : bandeja === 'human' ? (
                      'Sin casos delegados al humano en este momento.'
                    ) : bandeja === 'resolved' ? (
                      'Sin promesas o casos pagados registrados hoy.'
                    ) : (
                      'Sin casos: sube el CSV de las 6:00 AM o espera la ingesta del CRM.'
                    )
                  }
                  rowClassName={(row) => (row.estado === 'human' ? 'bg-red-50/40' : '')}
                />
                <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row justify-between items-center gap-2 text-xs text-slate-500">
                  <span>
                    {totalCasosFiltrados === 0
                      ? '0 casos'
                      : `Mostrando ${startIndex + 1}–${endIndex} de ${totalCasosFiltrados} caso(s)${
                          totalCasosFiltrados !== cases.length
                            ? ` (filtrados de ${cases.length})`
                            : ''
                        }`}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-600 mr-1">
                      Pág. {safePage} de {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white text-xs font-medium text-slate-700 transition-colors"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Anterior
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white text-xs font-medium text-slate-700 transition-colors"
                    >
                      Siguiente
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </Card>

              <Card className="mt-6 overflow-hidden" watermark={WATERMARK}>
                <CardHeader
                  title="Motor de cumplimiento — la ley como código"
                  subtitle="Catálogo legal ejecutable, aplicado antes de cada contacto"
                  actions={
                    <div className="flex items-center gap-2">
                      <StatusPill tone={legal?.identidad_configurada ? 'ok' : 'err'} icon={Scale}>
                        {legal?.identidad_configurada ? 'IDENTIDAD OK' : 'FALTA RAZÓN SOCIAL'}
                      </StatusPill>
                      {isManager ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={Settings}
                          onClick={() => setSettingsOpen(true)}
                        >
                          Editar
                        </Button>
                      ) : null}
                    </div>
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

          <OperatorDrawer
            caseId={selectedCaseId}
            canOperate={isOperator}
            onClose={() => setSelectedCaseId(null)}
            onUpdated={() => void cargar()}
          />

          {isManager ? (
            <TenantSettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => {
                void cargar();
                void recargarLegal();
              }}
            />
          ) : null}

          {canViewAccounting ? (
            <AccountingReportModal
              open={accountingOpen}
              canEdit={isManager}
              onClose={() => setAccountingOpen(false)}
            />
          ) : null}

          <CopilotWidget
            activeCaseId={selectedCaseId}
            activeCaseName={cases.find((c) => c.id === selectedCaseId)?.nombre ?? null}
            humanCount={countHuman}
          />
        </>
      ) : null}
    </PageShell>
  );
}
