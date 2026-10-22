#!/usr/bin/env python3
"""
ARKANGEL · MERIDIAN CORE — Asset Forge (SVG puro, cero dependencias)
Genera el kit visual pragmático para el dashboard de cobranza y auditoría.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# UTF-8 Windows nativo
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# --------------------------------------------------------------------------
# PALETA MERIDIAN CORE
# --------------------------------------------------------------------------
BG_CANVAS = "#F8FAFC"
BG_SURFACE = "#FFFFFF"
BG_PRIMARY = "#0F172A"
ACCENT_500 = "#059669"
ACCENT_400 = "#10B981"
DANGER_500 = "#DC2626"
WARNING_500 = "#D97706"
BORDER_LINE = "#E2E8F0"


# ==========================================================================
#  FORGE
# ==========================================================================
class MeridianForge:

    # 1. FAVICON (Escudo pragmático + Check)
    def favicon(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            f'<rect width="64" height="64" rx="14" fill="{BG_PRIMARY}"/>'
            f'<path d="M32 16 L46 24 V40 L32 48 L18 40 V24 Z" fill="none" stroke="{ACCENT_500}" stroke-width="3"/>'
            f'<path d="M24 32 L30 38 L40 26" fill="none" stroke="{ACCENT_400}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
            f"</svg>"
        )

    # 2. LOGO LOCKUP (Horizontal, limpio, tipográfico)
    def lockup(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48" viewBox="0 0 240 48">'
            f'<path d="M16 8 L28 15 V29 L16 36 L4 29 V15 Z" fill="none" stroke="{ACCENT_500}" stroke-width="2.5"/>'
            f'<path d="M10 22 L14 26 L22 16" fill="none" stroke="{ACCENT_400}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<text x="40" y="32" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="{BG_PRIMARY}" letter-spacing="-0.5">ARKANGEL</text>'
            f"</svg>"
        )

    # 3. GRID PATTERN (Fondo pragmático para el canvas, ayuda a la alineación visual)
    def grid_pattern(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">'
            f'<rect width="40" height="40" fill="{BG_CANVAS}"/>'
            f'<circle cx="20" cy="20" r="1" fill="{BORDER_LINE}"/>'
            f"</svg>"
        )

    # 4. ICON SPRITE (Dashboard pragmático, 8 íconos esenciales)
    def icon_sprite(self) -> str:
        S = f'fill="none" stroke="{BG_PRIMARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
        icons = {
            "dashboard": '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
            "cases": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
            "legal": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',  # Simplified shield/check
            "accounting": '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
            "alert": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
            "check": '<path d="M20 6 9 17l-5-5"/>',
            "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
            "user": '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        }
        syms = "".join(
            f'<symbol id="ark-{k}" viewBox="0 0 24 24"><g {S}>{v}</g></symbol>'
            for k, v in icons.items()
        )
        return f'<svg xmlns="http://www.w3.org/2000/svg" style="display:none">{syms}</svg>'

    # ---------------- BUILD ----------------
    def build(self, out: Path) -> list[dict]:
        out.mkdir(parents=True, exist_ok=True)
        files = {
            "favicon.svg": self.favicon(),
            "logo-lockup.svg": self.lockup(),
            "grid-pattern.svg": self.grid_pattern(),
            "icons-sprite.svg": self.icon_sprite(),
        }
        manifest = []
        for name, content in files.items():
            p = out / name
            p.write_text(content, encoding="utf-8")
            kb = round(p.stat().st_size / 1024, 2)
            manifest.append({"file": name, "kb": kb})
            print(f"  ✓ {name:<22} {kb:>7.2f} KB")

        manifest_path = out / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {"system": "Meridian Core", "client": "Arkangel", "assets": manifest},
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        kb_manifest = round(manifest_path.stat().st_size / 1024, 2)
        manifest.append({"file": "manifest.json", "kb": kb_manifest})
        print(f"  ✓ {'manifest.json':<22} {kb_manifest:>7.2f} KB")
        return manifest


def main():
    ap = argparse.ArgumentParser(description="Arkangel · Meridian Core · Asset Forge")
    ap.add_argument(
        "--out",
        default="frontend/public/assets",
        help="carpeta de salida (default: frontend/public/assets)",
    )
    a = ap.parse_args()

    print("\n🛡️  ARKANGEL · MERIDIAN CORE — Asset Forge")
    print("    Generando kit visual pragmático (SVG puro, cero dependencias)\n")
    MeridianForge().build(Path(a.out))
    print(f"\n  ✔ Assets listos para React + Vite en: {a.out}/\n")


if __name__ == "__main__":
    main()
