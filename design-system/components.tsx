import { useRef, useState, type ComponentType, type ReactNode } from 'react';

/**
 * ARKANGEL DESIGN SYSTEM · componentes
 *
 * Todos los componentes son presentacionales: no conocen la API ni el dominio.
 * La app compone los datos reales sobre estas piezas.
 *
 * Reglas de estilo que fija el sistema:
 *  - superficie blanca, borde slate-200, sombra mínima (shadow-sm)
 *  - tipografía Inter; monoespaciada sólo para datos duros (montos, IDs, logs)
 *  - acento emerald-600 para acción y éxito; slate-900 para acción primaria
 *  - radios: card 12px, control 8px, pill 9999px
 *  - iconos lucide: 20px en KPI, 16px en pills, 14px en texto
 */

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export type IconComponent = ComponentType<{ className?: string }>;

const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  err: 'bg-rose-50 text-rose-700 border-rose-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600',
  warn: 'text-amber-600',
  err: 'text-rose-600',
  info: 'text-blue-600',
  neutral: 'text-slate-600',
};

const TONE_TILE: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-600',
  warn: 'bg-amber-50 text-amber-600',
  err: 'bg-rose-50 text-rose-600',
  info: 'bg-blue-50 text-blue-600',
  neutral: 'bg-slate-100 text-slate-500',
};

/* ── Superficies ─────────────────────────────────────────────────────── */

export function Card({
  children,
  className = '',
  watermark,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** URL del asset de marca de agua (capa sutil detrás del contenido). */
  watermark?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 shadow-sm relative overflow-hidden ${className}`}
      {...rest}
    >
      {watermark ? (
        <img
          src={watermark}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 mx-auto h-full opacity-[0.05] object-contain"
        />
      ) : null}
      <div className="relative">{children}</div>
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
      <div>
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

/* ── KPI ─────────────────────────────────────────────────────────────── */

export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = 'info',
  hint,
  delta,
  className = '',
}: {
  label: string;
  value: ReactNode;
  icon?: IconComponent;
  tone?: Tone;
  hint?: ReactNode;
  delta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white p-5 rounded-xl border border-slate-200 shadow-sm ${className}`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <h3 className={`text-2xl font-bold mt-1 ${TONE_TEXT[tone]}`}>{value}</h3>
        </div>
        {Icon ? (
          <div className={`p-2 rounded-lg ${TONE_TILE[tone]}`}>
            <Icon className="w-5 h-5" />
          </div>
        ) : null}
      </div>
      {(hint || delta) && (
        <div className="mt-3 text-xs text-slate-500 flex items-center gap-1">
          {delta ? <span className="text-emerald-500 font-medium">{delta}</span> : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      )}
    </div>
  );
}

/* ── Pills y badges ──────────────────────────────────────────────────── */

export function StatusPill({
  tone = 'neutral',
  icon: Icon,
  pulse = false,
  children,
}: {
  tone?: Tone;
  icon?: IconComponent;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold ${TONE_PILL[tone]}`}
    >
      {pulse ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-40" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-current" />
        </span>
      ) : null}
      {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
      {children}
    </span>
  );
}

const CANAL_STYLE: Record<string, string> = {
  whatsapp: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  email: 'bg-blue-50 text-blue-700 border-blue-200',
  sms: 'bg-slate-100 text-slate-600 border-slate-200',
};

export function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  if (!channel) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50 text-slate-400 text-xs font-medium border border-slate-200">
        sin contacto
      </span>
    );
  }
  const label = channel === 'whatsapp' ? 'WhatsApp' : channel === 'email' ? 'Email' : 'SMS';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${CANAL_STYLE[channel] ?? CANAL_STYLE.sms}`}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  const mapa: Record<string, Tone> = {
    paid: 'ok',
    prometido: 'ok',
    cobrado: 'ok',
    enviado: 'info',
    listo: 'info',
    respondio: 'info',
    Human: 'err',
    escalado: 'err',
    human: 'err',
    fallido: 'err',
    failed: 'err',
  };
  const resolved: Tone = tone ?? mapa[status.toLowerCase()] ?? 'neutral';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold border ${TONE_PILL[resolved]}`}
    >
      {status}
    </span>
  );
}

/* ── Botones ─────────────────────────────────────────────────────────── */

const BUTTON_VARIANT: Record<string, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  accent: 'bg-emerald-600 text-white hover:bg-emerald-700',
  secondary: 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-50',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
};

const BUTTON_SIZE: Record<string, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-6 py-3.5 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon: Icon,
  children,
  className = '',
  ...rest
}: {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
  icon?: IconComponent;
  children?: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className}`}
      {...rest}
    >
      {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
      {children}
    </button>
  );
}

/* ── Panel industrial (estado del sistema) ───────────────────────────── */

export function DarkPanel({
  title,
  icon: Icon,
  children,
  watermark,
  className = '',
}: {
  title: ReactNode;
  icon?: IconComponent;
  children: ReactNode;
  watermark?: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-slate-900 text-slate-300 p-5 rounded-xl border border-slate-800 shadow-sm ark-grid-dark relative overflow-hidden ${className}`}
    >
      {watermark ? (
        <img
          src={watermark}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 mx-auto h-full opacity-[0.12] object-contain"
        />
      ) : null}
      <div className="relative z-10">
        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
          {Icon ? <Icon className="w-3 h-3" /> : null}
          {title}
        </h4>
        {children}
      </div>
    </div>
  );
}

export function DarkRow({
  label,
  value,
  tone = 'ok',
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'ok' | 'err' | 'warn' | 'muted';
}) {
  const color =
    tone === 'ok'
      ? 'text-emerald-400'
      : tone === 'err'
        ? 'text-rose-400'
        : tone === 'warn'
          ? 'text-amber-400'
          : 'text-slate-400';
  const dot =
    tone === 'ok'
      ? 'bg-emerald-400'
      : tone === 'err'
        ? 'bg-rose-400'
        : tone === 'warn'
          ? 'bg-amber-400'
          : 'bg-slate-400';

  return (
    <div className="flex justify-between items-center gap-3">
      <span className="truncate">{label}</span>
      <span className={`${color} flex items-center gap-1 shrink-0`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        {value}
      </span>
    </div>
  );
}

export function RateBar({ label, value, max }: { label: ReactNode; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-slate-500 mb-1">
        <span>{label}</span>
        <span>
          {value}/{max} RPM
        </span>
      </div>
      <div className="w-full bg-slate-800 rounded-full h-1.5">
        <div className="bg-amber-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ── Tabla ───────────────────────────────────────────────────────────── */

export interface Columna<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  empty = 'Sin registros',
  rowClassName,
}: {
  columns: Columna<T>[];
  rows: T[];
  empty?: ReactNode;
  rowClassName?: (row: T) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
          <tr>
            {columns.map((columna) => (
              <th key={columna.key} className={`px-6 py-3 ${columna.className ?? ''}`}>
                {columna.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-6 py-8 text-center text-slate-400">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={index}
                className={`hover:bg-slate-50 transition-colors ${rowClassName?.(row) ?? ''}`}
              >
                {columns.map((columna) => (
                  <td key={columna.key} className={`px-6 py-4 ${columna.className ?? ''}`}>
                    {columna.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── Dropzone ────────────────────────────────────────────────────────── */

export function Dropzone({
  onFile,
  title = 'Arrastra tu CSV de ingesta',
  hint = 'o haz clic para seleccionar. Máx 10MB.',
  columns = 'Columnas: curp, phone, debt_amount, case_date',
  accept = '.csv,.txt',
  busy = false,
  className = '',
}: {
  onFile: (file: File) => void;
  title?: string;
  hint?: string;
  columns?: string;
  accept?: string;
  busy?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onClick={() => input.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={`bg-white p-6 rounded-xl border-2 border-dashed shadow-sm cursor-pointer group transition-colors ${
        over ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-500'
      } ${className}`}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center group-hover:bg-blue-50 transition-colors">
          <svg
            className="w-6 h-6 text-slate-500 group-hover:text-blue-600"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z"
            />
          </svg>
        </div>
        <h3 className="mt-3 text-sm font-semibold text-slate-900">
          {busy ? 'Procesando…' : title}
        </h3>
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
        <p className="mt-2 text-[10px] text-slate-400 font-mono">{columns}</p>
      </div>
    </div>
  );
}

/* ── Varios ──────────────────────────────────────────────────────────── */

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const styles: Record<Tone, string> = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-800',
    err: 'bg-rose-50 border-rose-200 text-rose-700',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    neutral: 'bg-slate-50 border-slate-200 text-slate-700',
  };
  return (
    <div className={`border rounded-xl px-5 py-4 text-sm ${styles[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className="mt-1 text-xs leading-relaxed">{children}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
}: {
  value: number;
  tone?: 'accent' | 'warn';
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="w-full bg-slate-100 rounded-full h-1.5">
      <div
        className={`h-1.5 rounded-full transition-all duration-300 ${tone === 'accent' ? 'bg-emerald-600' : 'bg-amber-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function TopNav({
  brand,
  subtitle,
  badges,
  actions,
}: {
  brand: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="bg-slate-900 text-white p-2 rounded-lg shrink-0">
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
                />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 truncate">{brand}</h1>
              {subtitle ? (
                <p className="text-xs text-slate-500 font-medium truncate">{subtitle}</p>
              ) : null}
            </div>
          </div>
          {badges ? <div className="flex items-center gap-4 shrink-0">{badges}</div> : null}
          {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
        </div>
      </div>
    </nav>
  );
}

export function PageShell({
  nav,
  children,
  className = '',
}: {
  nav: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      {nav}
      <main className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 ${className}`}>{children}</main>
    </div>
  );
}
