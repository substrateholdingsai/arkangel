# ARKANGEL-MERIDIAN.md

> **Design System v1.0** · Instancia: `Meridian Core` · Cliente: **Arkangel (Plataforma de Cobranza IA)**
> Tipo de Huésped: `service` (B2B SaaS Dashboard · Operadores de 8+ horas/día)

## 1 · Manifiesto

Arkangel es una torre de control, no una revista de diseño. La interfaz debe desaparecer para que los datos hablen.
**Principio rector:** "La legibilidad es la única decoración permitida".
Usamos grids estrictos, bordes definidos y contraste quirúrgico. El operador debe poder escanear 50 filas de una tabla y encontrar la anomalía sin esfuerzo.

## 2 · Tokens de Color (Alto Contraste WCAG AAA)

### 2.1 · Superficie (Lienzo de trabajo de 8 horas)

| Token        | Hex       | Rol                                                             |
| ------------ | --------- | --------------------------------------------------------------- |
| `bg-canvas`  | `#F8FAFC` | Fondo principal (Slate 50, reduce fatiga visual vs blanco puro) |
| `bg-surface` | `#FFFFFF` | Tarjetas, tablas de datos, modales                              |
| `bg-primary` | `#0F172A` | Sidebar, headers, texto principal (Slate 900)                   |

### 2.2 · Acento y Acción (Quirúrgico)

| Token         | Hex       | Rol                                                               |
| ------------- | --------- | ----------------------------------------------------------------- |
| `accent-500`  | `#059669` | **Éxito / Cobranza** · Botón primario · "Despachar" (Emerald 600) |
| `accent-400`  | `#10B981` | Hover de acción primaria                                          |
| `accent-text` | `#FFFFFF` | Texto sobre botón de acento (SIEMPRE blanco, nunca negro)         |

### 2.3 · Semántica de Estado (Legal y Financiero)

| Token         | Hex       | Rol                                                     |
| ------------- | --------- | ------------------------------------------------------- |
| `danger-500`  | `#DC2626` | **Riesgo Legal** · Vencido · Fail-closed · Promesa rota |
| `warning-500` | `#D97706` | **Atención** · Por vencer · Pendiente de validación     |
| `info-500`    | `#2563EB` | **Informativo** · En proceso · Webhook recibido         |

### 2.4 · Bordes y Estructura

| Token           | Hex       | Rol                                                 |
| --------------- | --------- | --------------------------------------------------- |
| `border-line`   | `#E2E8F0` | Bordes de tabla, separadores de tarjeta (Slate 200) |
| `border-strong` | `#CBD5E1` | Hover de fila, foco de input                        |

## 3 · Tríada Tipográfica

| Rol                | Familia          | Pesos           | Uso                                                           |
| ------------------ | ---------------- | --------------- | ------------------------------------------------------------- |
| **UI / Cuerpo**    | `Inter`          | 400 / 500 / 600 | Navegación, labels, botones, texto de apoyo                   |
| **Datos / Cifras** | `JetBrains Mono` | 400 / 500       | **OBLIGATORIO** para: Montos, CLABE, RFC, Folios, IDs, Fechas |

### 3.1 · Ley de las Cifras (No negociable)

```css
.data-value {
  font-family: 'JetBrains Mono', monospace;
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings:
    'tnum' 1,
    'lnum' 1;
  text-align: right; /* Alineación decimal estricta */
}
```

## 4 · Kit de Assets (`MeridianForge`)

Generado de forma determinista con `python scripts/forge_meridian_assets.py` en `frontend/public/assets/`:

- `favicon.svg` — Escudo pragmático + Check (`#0F172A` + `#059669` + `#10B981`)
- `logo-lockup.svg` — Lockup horizontal tipográfico `ARKANGEL`
- `grid-pattern.svg` — Patrón de puntos sobre `#F8FAFC`
- `icons-sprite.svg` — Sprite SVG con 8 íconos base (`dashboard`, `cases`, `legal`, `accounting`, `alert`, `check`, `clock`, `user`)
- `manifest.json` — Inventario de assets y peso en KB
