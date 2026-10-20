/**
 * ARKANGEL DESIGN SYSTEM · preset de Tailwind v3
 *
 * Uso:
 *   import arkangel from './design-system/tailwind.preset.js';
 *   export default { presets: [arkangel], content: [...] };
 *
 * Los colores de marca (`ark.*`) replican las variables de `tokens.css` para
 * poder usarlos como `bg-ark-accent`, `text-ark-muted`, etc.
 */

export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        ark: {
          canvas: '#f8fafc',
          surface: '#ffffff',
          'surface-muted': '#f8fafc',
          ink: '#0f172a',
          'ink-soft': '#334155',
          muted: '#64748b',
          subtle: '#94a3b8',
          line: '#e2e8f0',
          'line-strong': '#cbd5e1',
          dark: '#0f172a',
          'dark-line': '#1e293b',
          'dark-ink': '#cbd5e1',
          'dark-muted': '#94a3b8',
          accent: '#059669',
          'accent-hover': '#047857',
          'accent-soft': '#ecfdf5',
          'accent-line': '#a7f3d0',
          'accent-ink': '#065f46',
          'accent-bright': '#34d399',
          info: '#2563eb',
          'info-soft': '#eff6ff',
          'info-line': '#bfdbfe',
          warn: '#d97706',
          'warn-soft': '#fffbeb',
          'warn-line': '#fde68a',
          danger: '#e11d48',
          'danger-soft': '#fff1f2',
          'danger-line': '#fecdd3',
          'danger-bright': '#fb7185',
          'channel-sms': '#475569',
          'channel-sms-soft': '#f1f5f9',
          'channel-sms-line': '#e2e8f0',
        },
      },
      borderRadius: {
        card: '0.75rem',
        control: '0.5rem',
        pill: '9999px',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.05)',
        lift: '0 1px 3px 0 rgb(15 23 42 / 0.1), 0 1px 2px -1px rgb(15 23 42 / 0.1)',
      },
      maxWidth: {
        shell: '80rem',
      },
      backgroundImage: {
        'ark-grid': 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)',
        'ark-grid-dark': 'radial-gradient(circle, #334155 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '24px 24px',
      },
      keyframes: {
        'ark-fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'ark-fade-up 0.35s ease-out both',
      },
    },
  },
};
