# ARKANGEL · Design System

Sistema de diseño institucional del ecosistema Arkangel (cobranza, conciliación, fiscal).
Es **código**, no una maqueta: tokens + preset de Tailwind + componentes React.

```
design-system/
├── tokens.css           # variables CSS (color, tipografía, radio, sombra, patrones)
├── tailwind.preset.js   # preset Tailwind v3 (colores ark.*, fontFamily, sombras, keyframes)
├── components.tsx       # componentes presentacionales (sin conocimiento del dominio)
└── index.ts             # re-exports
```

## Principios

| Principio | Regla |
|---|---|
| Estructura | Escala Slate: fondo `#f8fafc`, superficie blanca, borde `#e2e8f0` |
| Acción | Emerald 600 (`#059669`) para acción/éxito; Slate 900 para acción primaria |
| Tipografía | Inter 300–700; monoespaciada sólo para montos, IDs y logs |
| Forma | card 12px · control 8px · pill 9999px · sombra mínima `shadow-sm` |
| Densidad | Grid de KPI 4 columnas, tablas con `px-6 py-4`, pills de 12px |
| Modo industrial | Un panel oscuro por vista (`ark-grid-dark`) para estado de sistema |
| Iconografía | lucide 20px en KPI · 16px en pills · 14px en texto |

## Uso en este proyecto

```ts
// tailwind.config.js
import arkangel from './design-system/tailwind.preset.js';

export default {
  presets: [arkangel],
  content: ['./frontend/index.html', './frontend/src/**/*.{ts,tsx}', './design-system/**/*.{ts,tsx}'],
};
```

```tsx
// frontend/src/styles.css
@import '../design-system/tokens.css';
@import 'inter-font/400.css';
```

```tsx
import { Card, KpiCard, StatusPill, DataTable } from '@ds';
```

## Uso en proyectos futuros

Opción A — submódulo (recomendado, un solo origen):

```bash
git submodule add https://github.com/substrateholdingsai/arkangel.git vendor/arkangel-design-system
```

Opción B — copia del folder:

```bash
cp -r arkangel/design-system ../mi-proyecto/design-system
```

En ambos casos, registrar el contenido en `tailwind.config.js` y el alias `@ds`:

```ts
// vite.config.ts
resolve: { alias: { '@ds': path.resolve(__dirname, './design-system') } }
```

```json
// tsconfig.json
"paths": { "@ds/*": ["design-system/*"] }
```

## Componentes disponibles

`PageShell` · `TopNav` · `Card` · `CardHeader` · `KpiCard` · `StatusPill` · `ChannelBadge` ·
`StatusBadge` · `Button` · `DarkPanel` · `DarkRow` · `RateBar` · `DataTable` · `Dropzone` ·
`Alert` · `ProgressBar`

## Reglas para extenderlo

1. **Un token nuevo entra a `tokens.css` primero** y después se expone en el preset.
2. Ningún componente del design system debe hacer `fetch` ni conocer entidades del dominio.
3. Todo componente nuevo debe aceptar `className` para permitir ajuste sin romper el sistema.
4. Si un proyecto necesita un color que no existe, primero se pregunta si es un estado
   (`ok`/`warn`/`err`/`info`/`neutral`) o un color de marca.
