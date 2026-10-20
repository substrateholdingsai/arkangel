#!/usr/bin/env python3
"""
forge_arkangel_watermark.py
===========================

Genera los assets de marca de agua institucional del ecosistema Arkangel.

Salidas (por defecto en ``frontend/public/assets/``):

  * ``arkangel-watermark.png``      — patrón isométrico + escudo ARKANGEL (fondo claro)
  * ``arkangel-watermark-dark.png`` — variante para el panel industrial oscuro
  * ``arkangel-watermark.svg``      — vector equivalente (sin dependencias)

Uso
---
    python scripts/forge_arkangel_watermark.py              # genera si falta o está viejo
    python scripts/forge_arkangel_watermark.py --force      # regenera siempre
    python scripts/forge_arkangel_watermark.py --output-dir public/assets --width 1600

El script es idempotente: si el asset existe y es más nuevo que este archivo,
no lo regenera (se puede enganchar en ``prebuild`` sin costo).

Dependencias: Pillow para los PNG. Si no está disponible, el SVG se genera
igualmente y el script termina con código 0 (los PNG son decorativos).
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from typing import List, Sequence, Tuple

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - entorno sin Pillow
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]
    ImageFont = None  # type: ignore[assignment]

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
DEFAULT_OUTPUT = os.path.join(PROJECT_ROOT, "frontend", "public", "assets")

# ── Paleta institucional ────────────────────────────────────────────────
LIGHT = {
    "bg": "#F8FAFC",  # slate-50
    "line": "#E2E8F0",  # slate-200
    "ring": "#CBD5E1",  # slate-300
    "accent": "#059669",  # emerald-600
    "muted": "#94A3B8",  # slate-400
}
DARK = {
    "bg": "#0F172A",  # slate-900
    "line": "#1E293B",  # slate-800
    "ring": "#334155",  # slate-700
    "accent": "#34D399",  # emerald-400
    "muted": "#64748B",  # slate-500
}

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/segoeuib.ttf", True),
    ("C:/Windows/Fonts/arialbd.ttf", True),
    ("C:/Windows/Fonts/segoeui.ttf", False),
    ("C:/Windows/Fonts/arial.ttf", False),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", True),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", False),
]


def load_font(size: int, bold: bool = False):
    """Carga la mejor fuente disponible; cae a la de Pillow si no hay ninguna."""
    if ImageFont is None:
        return None
    for path, is_bold in FONT_CANDIDATES:
        if is_bold != bold or not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, size)
        except Exception:  # pragma: no cover - fuente corrupta
            continue
    try:
        return ImageFont.load_default()
    except Exception:  # pragma: no cover
        return None


def shield_points(cx: int, cy: int, w: int, h: int) -> List[Tuple[int, int]]:
    """Geometría del escudo institucional (centrado en cx,cy)."""
    half = w // 2
    top = cy - h // 2
    bottom = cy + h // 2
    shoulder = int(h * 0.25)
    return [
        (cx, top),
        (cx + half, top + shoulder),
        (cx + half, bottom - shoulder),
        (cx, bottom),
        (cx - half, bottom - shoulder),
        (cx - half, top + shoulder),
    ]


def draw_watermark(draw, width: int, height: int, palette, *, mono: bool = False) -> None:
    """Dibuja el patrón isométrico, el escudo y los sellos de texto."""
    line = palette["line"]
    ring = palette["ring"]
    accent = palette["accent"]
    muted = palette["muted"]

    # 1) Retícula isométrica (geometría sagrada financiera)
    spacing = 40
    for i in range(-height, width + height, spacing):
        draw.line([(i, 0), (i + height, height)], fill=line, width=1)
        draw.line([(i, height), (i + height, 0)], fill=line, width=1)

    # 2) Círculos concéntricos
    cx, cy = width // 2, height // 2
    radius = min(width, height) // 3
    draw.ellipse(
        [(cx - radius, cy - radius), (cx + radius, cy + radius)], outline=ring, width=2
    )
    inner = radius - 10
    draw.ellipse(
        [(cx - inner, cy - inner), (cx + inner, cy + inner)], outline=ring, width=1
    )

    # 3) Escudo + check
    points = shield_points(cx, cy - 10, 100, 120)
    draw.polygon(points, outline=accent, width=3)
    draw.line(
        [(cx - 20, cy - 10), (cx - 5, cy + 5), (cx + 25, cy - 30)], fill=accent, width=4
    )

    # 4) Sellos de texto
    title_font = load_font(20, bold=True)
    sub_font = load_font(14, bold=False)
    draw.text((cx - 78, cy + radius - 6), "ARKANGEL SYSTEM", fill=muted, font=title_font)
    draw.text((cx - 52, cy + radius + 18), "AUDIT TRAIL", fill=ring, font=sub_font)


def generate_arkangel_watermark(
    width: int = 1200, height: int = 800, output_path: str = "arkangel_watermark.png"
) -> str:
    """Genera el PNG de la marca de agua en modo claro."""
    if Image is None:
        raise RuntimeError("Pillow no está instalado: no se puede generar el PNG")

    palette = LIGHT
    img = Image.new("RGB", (width, height), palette["bg"])
    draw = ImageDraw.Draw(img)
    draw_watermark(draw, width, height, palette)
    img.save(output_path, "PNG", optimize=True, compress_level=9)
    return output_path


def generate_arkangel_watermark_dark(
    width: int = 900, height: int = 600, output_path: str = "arkangel-watermark-dark.png"
) -> str:
    """Genera el PNG de la marca de agua en variante oscura (panel industrial)."""
    if Image is None:
        raise RuntimeError("Pillow no está instalado: no se puede generar el PNG")

    palette = DARK
    img = Image.new("RGB", (width, height), palette["bg"])
    draw = ImageDraw.Draw(img)
    draw_watermark(draw, width, height, palette)
    img.save(output_path, "PNG", optimize=True, compress_level=9)
    return output_path


def generate_arkangel_watermark_svg(
    width: int = 1200, height: int = 800, output_path: str = "arkangel-watermark.svg"
) -> str:
    """
    Genera el SVG equivalente sin depender de Pillow.

    El SVG es el asset de referencia para web (nítido en cualquier DPI); los PNG
    sirven para reportes PDF/impresión.
    """
    cx, cy = width // 2, height // 2
    radius = min(width, height) // 3
    inner = radius - 10
    spacing = 40

    diagonals: List[str] = []
    for i in range(-height, width + height, spacing):
        diagonals.append(f'<line x1="{i}" y1="0" x2="{i + height}" y2="{height}"/>')
        diagonals.append(f'<line x1="{i}" y1="{height}" x2="{i + height}" y2="0"/>')

    shield = " ".join(f"{x},{y}" for x, y in shield_points(cx, cy - 10, 100, 120))

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Marca de agua Arkangel">
  <defs>
    <pattern id="ark-grid" width="{spacing}" height="{spacing}" patternUnits="userSpaceOnUse">
      <path d="M {spacing} 0 L 0 0 0 {spacing}" fill="none" stroke="#E2E8F0" stroke-width="1"/>
    </pattern>
    <g id="ark-diagonals" stroke="#E2E8F0" stroke-width="1" fill="none">
      {''.join(diagonals)}
    </g>
  </defs>
  <rect width="{width}" height="{height}" fill="#F8FAFC"/>
  <rect width="{width}" height="{height}" fill="url(#ark-grid)" opacity="0.55"/>
  <circle cx="{cx}" cy="{cy}" r="{radius}" fill="none" stroke="#CBD5E1" stroke-width="2"/>
  <circle cx="{cx}" cy="{cy}" r="{inner}" fill="none" stroke="#CBD5E1" stroke-width="1"/>
  <polygon points="{shield}" fill="none" stroke="#059669" stroke-width="3"/>
  <polyline points="{cx - 20},{cy - 10} {cx - 5},{cy + 5} {cx + 25},{cy - 30}" fill="none" stroke="#059669" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="{cx}" y="{cy + radius + 12}" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700" fill="#94A3B8" text-anchor="middle">ARKANGEL SYSTEM</text>
  <text x="{cx}" y="{cy + radius + 36}" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500" fill="#CBD5E1" text-anchor="middle">AUDIT TRAIL</text>
</svg>
"""
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(svg)
    return output_path


def needs_regeneration(path: str, script_path: str, force: bool) -> bool:
    if force:
        return True
    if not os.path.exists(path):
        return True
    try:
        return os.path.getmtime(path) < os.path.getmtime(script_path)
    except OSError:  # pragma: no cover
        return True


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Genera los assets de marca de agua Arkangel")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT, help="carpeta de salida")
    parser.add_argument("--width", type=int, default=1200)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--force", action="store_true", help="regenera aunque exista")
    parser.add_argument("--quiet", action="store_true", help="silencia el resumen")
    args = parser.parse_args(argv)

    os.makedirs(args.output_dir, exist_ok=True)
    script_path = os.path.abspath(__file__)

    targets = [
        ("arkangel-watermark.png", "png"),
        ("arkangel-watermark-dark.png", "png-dark"),
        ("arkangel-watermark.svg", "svg"),
    ]

    generated: List[str] = []
    skipped: List[str] = []

    for filename, kind in targets:
        path = os.path.join(args.output_dir, filename)
        if not needs_regeneration(path, script_path, args.force):
            skipped.append(filename)
            continue
        try:
            if kind == "svg":
                generate_arkangel_watermark_svg(args.width, args.height, path)
            elif kind == "png":
                generate_arkangel_watermark(args.width, args.height, path)
            else:
                generate_arkangel_watermark_dark(900, 600, path)
            generated.append(filename)
        except Exception as error:  # pragma: no cover - degradación elegante
            print(f"[assets] no se pudo generar {filename}: {error}", file=sys.stderr)

    if not args.quiet:
        for name in generated:
            print(f"[assets] generado  {name}")
        for name in skipped:
            print(f"[assets] vigente   {name}")
        if not generated and not skipped:
            print("[assets] nada que hacer")

    # 0 = todo bien (aunque Pillow falte, el SVG queda disponible)
    return 0


if __name__ == "__main__":
    sys.exit(main())
