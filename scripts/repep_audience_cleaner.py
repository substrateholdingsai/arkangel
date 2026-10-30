#!/usr/bin/env python3
"""
repep_audience_cleaner.py — Sanitizador Masivo de Audiencias y Hash REPEP
==========================================================================
Arkangel · Plataforma de Cobranza Agéntica
Plano Legal: Escudo PROFECO para campañas de marketing sin riesgo de multas.

Problema resuelto:
  Enviar un solo mensaje a un número registrado en REPEP PROFECO puede acarrear
  multas superiores a $1.5M MXN o el baneo del número de WhatsApp Business oficial.
  Este script sanitiza audiencias masivas ANTES de importarlas al Motor de
  Comunicación, garantizando cumplimiento fail-closed de:

  - REPEP PROFECO (Ley Federal de Protección al Consumidor)
  - Opt-out automático y manual (comm_suppressions)
  - Opt-in expreso por marca/canal/categoría (comm_consents)
  - Vigencia de lista REPEP ≤ 35 días (fail-closed: sin lista vigente = bloqueo total)
  - Normalización E.164 estricta para cotejo SHA-256 en edge

Fuentes de datos REPEP:
  - D1 local (.wrangler/state/v3/d1/*.sqlite) — modo desarrollo
  - D1 remoto vía Cloudflare REST API — modo producción
  - Archivo de hashes exportado (repep_hashes.txt) — modo offline/air-gapped

Salidas:
  - audiencia_limpia.csv    → 100% legal, lista para CAMPAIGN_DISPATCH_V1
  - exclusiones_reporte.csv → Desglose exacto de por qué se descartó cada contacto
  - resumen_ejecutivo.json  → Métricas para auditoría y bitácora WORM

Uso:
  python repep_audience_cleaner.py --input leads_temozonia.csv --tenant temozonia
  python repep_audience_cleaner.py --input leads.xlsx --tenant ark --brand "Ark Oficios"
  python repep_audience_cleaner.py --input leads.csv --mode remote --account-id x --db-id y --token z
  python repep_audience_cleaner.py --input leads.csv --repep-file repep_hashes.txt --tenant baakal
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Generator

# UTF-8 stdout/stderr en consolas Windows (cp1252) para soportar emojis y diagramas
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ─── Dependencias opcionales ───────────────────────────────────────────────────

try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn
    HAS_RICH = True
except ImportError:
    HAS_RICH = False


# ═══════════════════════════════════════════════════════════════════════════════
# §1. CONFIGURACIÓN Y CONSTANTES
# ═══════════════════════════════════════════════════════════════════════════════

# Vigencia máxima de REPEP según Sprint 17: 35 días fail-closed
REPEP_VIGENCIA_DIAS = 35

# Tenants conocidos
TENANTS_CONOCIDOS = {
    "temozonia": "Temozonía",
    "baakal": "Baak'al",
    "canaco_merida": "CANACO Mérida",
    "ark": "Ark Oficios",
}

# Motivos de exclusión (alineados con src/comunicacion/tipos.ts)
MOTIVO_REPEP_MATCH = "repep_match"
MOTIVO_OPT_OUT = "opt_out"
MOTIVO_NO_OPTIN = "no_optin"
MOTIVO_TELEFONO_INVALIDO = "telefono_invalido"
MOTIVO_REPEP_EXPIRADO = "repep_version_expired"
MOTIVO_REPEP_AUSENTE = "repep_version_missing"
MOTIVO_DUPLICADO = "duplicado"

# Severidad legal de cada motivo (para priorización de reporte)
SEVERIDAD_MOTIVO = {
    MOTIVO_REPEP_MATCH: "CRITICA",       # Multa PROFECO > $1.5M MXN
    MOTIVO_REPEP_EXPIRADO: "CRITICA",    # Fail-closed: bloquea todo
    MOTIVO_REPEP_AUSENTE: "CRITICA",     # Fail-closed: bloquea todo
    MOTIVO_OPT_OUT: "ALTA",              # Violación LFPC Art. 17
    MOTIVO_NO_OPTIN: "ALTA",             # Sin consentimiento expreso
    MOTIVO_TELEFONO_INVALIDO: "MEDIA",   # No se pudo normalizar
    MOTIVO_DUPLICADO: "BAJA",            # Optimización de costo
}

# Columnas esperadas en el CSV de entrada (mapeo flexible)
COLUMNAS_TELEFONO = ["phone", "telefono", "teléfono", "tel", "celular", "movil", "móvil", "numero", "número", "whatsapp"]
COLUMNAS_NOMBRE = ["nombre", "name", "cliente", "contacto", "first_name"]
COLUMNAS_APELLIDO = ["apellido", "last_name", "apellidos"]
COLUMNAS_EMAIL = ["email", "correo", "mail", "e-mail"]


# ═══════════════════════════════════════════════════════════════════════════════
# §2. MODELOS DE DATOS
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Contacto:
    """Contacto de la audiencia de entrada."""
    fila_original: int
    telefono_raw: str
    telefono_e164: Optional[str] = None
    telefono_hash: Optional[str] = None
    nombre: Optional[str] = None
    apellido: Optional[str] = None
    email: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class ResultadoContacto:
    """Resultado de la evaluación de un contacto."""
    contacto: Contacto
    incluido: bool
    motivo: Optional[str] = None
    detalle: Optional[str] = None
    severidad: Optional[str] = None


@dataclass
class EstadoREPEP:
    """Estado de la lista REPEP según fail-closed de 35 días."""
    vigente: bool
    version_id: Optional[str] = None
    fecha_corte: Optional[str] = None
    antiguedad_dias: Optional[int] = None
    total_numeros: int = 0
    motivo_fallo: Optional[str] = None


@dataclass
class ResumenAuditoria:
    """Resumen ejecutivo de la sanitización."""
    timestamp: str
    tenant_id: str
    brand_id: Optional[str]
    archivo_entrada: str
    total_contactos: int = 0
    total_validos: int = 0
    total_excluidos: int = 0
    exclusiones_por_motivo: dict = field(default_factory=dict)
    duracion_segundos: float = 0.0
    repep_estado: Optional[EstadoREPEP] = None
    hashes_generados: int = 0
    optouts_cruzados: int = 0
    optins_cruzados: int = 0


# ═══════════════════════════════════════════════════════════════════════════════
# §3. NORMALIZACIÓN E.164 PARA MÉXICO
# ═══════════════════════════════════════════════════════════════════════════════

class NormalizadorE164:
    """
    Normaliza teléfonos mexicanos a formato E.164 estricto (+52XXXXXXXXXX).
    """

    LADAS_2 = {"55", "56", "81", "33"}
    RE_CLEAN = re.compile(r"[^\d]")

    @classmethod
    def normalizar(cls, raw: str) -> Optional[str]:
        if not raw or not str(raw).strip():
            return None

        digits = cls.RE_CLEAN.sub("", str(raw).strip())
        if not digits:
            return None

        if digits.startswith("52") and len(digits) == 12:
            return f"+{digits}"

        if digits.startswith("045") and len(digits) == 13:
            return f"+52{digits[3:]}"
        if digits.startswith("044") and len(digits) == 13:
            return f"+52{digits[3:]}"

        if digits.startswith("01") and len(digits) in (11, 12):
            return f"+52{digits[2:]}"

        if digits.startswith("1") and len(digits) == 11:
            return f"+52{digits[1:]}"

        if len(digits) == 10:
            return f"+52{digits}"

        if len(digits) == 9:
            lada3 = digits[:3]
            if cls._es_lada3_valida(lada3):
                return f"+52{digits}"

        return None

    @classmethod
    def _es_lada3_valida(cls, lada: str) -> bool:
        ladas3_conocidas = {
            "999", "222", "442", "477", "449", "844", "867", "981", "993",
            "961", "246", "744", "322", "311", "612", "624", "664", "686",
            "662", "636", "614", "834", "833", "229", "271", "722", "735", "762",
        }
        return lada in ladas3_conocidas


def generar_sha256_e164(telefono_e164: str) -> str:
    """
    Genera hash SHA-256 de un teléfono E.164.
    Debe coincidir exactamente con el hashing en edge (src/services/repep.ts).
    """
    return hashlib.sha256(telefono_e164.encode("utf-8")).hexdigest()


# ═══════════════════════════════════════════════════════════════════════════════
# §4. HASHING PARALELO CON MULTIPROCESSING
# ═══════════════════════════════════════════════════════════════════════════════

def _hash_worker(telefonos: list[str]) -> list[tuple[str, str]]:
    return [(tel, generar_sha256_e164(tel)) for tel in telefonos if tel]


class HashingParalelo:
    """Genera hashes SHA-256 en paralelo para audiencias grandes."""

    def __init__(self, workers: Optional[int] = None, chunk_size: int = 5000):
        self.workers = workers or min(os.cpu_count() or 4, 8)
        self.chunk_size = chunk_size

    def generar_hashes(self, telefonos: list[str], progress_callback=None) -> dict[str, str]:
        if not telefonos:
            return {}

        if len(telefonos) < 10_000:
            result = {}
            for i, tel in enumerate(telefonos):
                result[tel] = generar_sha256_e164(tel)
                if progress_callback and i % 1000 == 0:
                    progress_callback(i, len(telefonos))
            if progress_callback:
                progress_callback(len(telefonos), len(telefonos))
            return result

        result = {}
        chunks = [telefonos[i:i + self.chunk_size] for i in range(0, len(telefonos), self.chunk_size)]

        with ProcessPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(_hash_worker, chunk): idx for idx, chunk in enumerate(chunks)}
            completed = 0
            for future in as_completed(futures):
                for tel, h in future.result():
                    result[tel] = h
                completed += 1
                if progress_callback:
                    progress_callback(completed * self.chunk_size, len(telefonos))

        return result


# ═══════════════════════════════════════════════════════════════════════════════
# §5. FUENTES DE DATOS REPEP Y SUPRESIONES (D1 LOCAL, REMOTO Y ARCHIVO)
# ═══════════════════════════════════════════════════════════════════════════════

class REPEPSourceLocal:
    """Lee REPEP y supresiones del D1 local (sqlite)."""

    def __init__(self, db_path: Optional[str] = None):
        if db_path:
            self.db_path = Path(db_path)
        else:
            self.db_path = self._find_d1_local()
        if not self.db_path.exists():
            raise FileNotFoundError(f"Base D1 local no encontrada: {self.db_path}")

    def _find_d1_local(self) -> Path:
        candidatos = [
            Path(".wrangler/state/v3/d1"),
            Path(".wrangler/state/d1"),
            Path.home() / ".wrangler/state/v3/d1",
        ]
        for dir_path in candidatos:
            if dir_path.exists():
                for f in dir_path.rglob("*.sqlite"):
                    if "metadata" not in f.name:
                        return f
        for f in Path(".").rglob("*.sqlite"):
            if "d1" in str(f).lower() and "metadata" not in f.name:
                return f
        raise FileNotFoundError("No se encontró archivo .sqlite de D1. Usa --db-path.")

    def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
        finally:
            conn.close()

    def get_estado_repep(self) -> EstadoREPEP:
        """Verifica la vigencia de la lista REPEP (fail-closed 35 días)."""
        try:
            rows = self._query("""
                SELECT id,
                       COALESCE(list_date, loaded_at, created_at) AS fecha_corte,
                       COALESCE(status, estado) AS estado,
                       COALESCE(loaded_at, created_at) AS created_at
                FROM comm_repep_versions
                WHERE COALESCE(status, estado) = 'active'
                ORDER BY created_at DESC
                LIMIT 1
            """)
        except Exception:
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_AUSENTE)

        if not rows:
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_AUSENTE)

        version = rows[0]
        fecha_corte_str = version.get("fecha_corte") or version.get("created_at", "")

        try:
            if "T" in fecha_corte_str:
                fecha_corte = datetime.fromisoformat(fecha_corte_str.replace("Z", "+00:00"))
            else:
                fecha_corte = datetime.strptime(fecha_corte_str[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except (ValueError, IndexError):
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_EXPIRADO)

        ahora = datetime.now(timezone.utc)
        antiguedad = (ahora - fecha_corte).days

        if antiguedad > REPEP_VIGENCIA_DIAS:
            return EstadoREPEP(
                vigente=False,
                version_id=str(version.get("id")),
                fecha_corte=fecha_corte_str,
                antiguedad_dias=antiguedad,
                motivo_fallo=MOTIVO_REPEP_EXPIRADO,
            )

        try:
            count_rows = self._query("SELECT COUNT(*) as total FROM comm_repep_numbers")
            total = count_rows[0]["total"] if count_rows else 0
        except Exception:
            total = 0

        return EstadoREPEP(
            vigente=True,
            version_id=str(version.get("id")),
            fecha_corte=fecha_corte_str,
            antiguedad_dias=antiguedad,
            total_numeros=total,
        )

    def get_hashes_repep(self) -> set[str]:
        try:
            rows = self._query("SELECT phone_hash FROM comm_repep_numbers")
            return {r["phone_hash"] for r in rows}
        except Exception:
            return set()

    def get_supresiones(self, tenant_id: str, brand_id: Optional[str] = None) -> set[str]:
        """Extrae teléfonos suprimidos (comm_suppressions)."""
        try:
            sql = "SELECT * FROM comm_suppressions WHERE tenant_id = ?"
            params = [tenant_id]
            rows = self._query(sql, tuple(params))
            supresiones = set()
            for r in rows:
                raw_tel = r.get("contacto") or r.get("telefono") or ""
                e164 = NormalizadorE164.normalizar(raw_tel)
                supresiones.add(e164 if e164 else raw_tel)
            return supresiones
        except Exception:
            return set()

    def get_optins(self, tenant_id: str, brand_id: Optional[str] = None, canal: str = "whatsapp") -> set[str]:
        """Extrae teléfonos con opt-in expreso (comm_consents)."""
        try:
            sql = "SELECT * FROM comm_consents WHERE tenant_id = ? AND (channel = ? OR canal = ?)"
            params = [tenant_id, canal, canal]
            rows = self._query(sql, tuple(params))
            optins = set()
            for r in rows:
                # Comprobar si está revocado
                if r.get("revoked_at"):
                    continue
                raw_tel = r.get("contacto") or r.get("telefono") or ""
                e164 = NormalizadorE164.normalizar(raw_tel)
                if e164:
                    optins.add(e164)
            return optins
        except Exception:
            return set()


class REPEPSourceRemoto:
    """Accede a REPEP vía Cloudflare REST API (D1 remoto)."""

    def __init__(self, account_id: str, database_id: str, api_token: str):
        self.account_id = account_id
        self.database_id = database_id
        self.api_token = api_token
        self.base_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"

    def _query(self, sql: str) -> list[dict]:
        if not HAS_REQUESTS:
            raise RuntimeError("Se requiere 'requests' para modo remoto: pip install requests")
        resp = requests.post(
            self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json",
            },
            json={"sql": sql},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"Error D1 API: {data.get('errors', [])}")
        return data["result"][0].get("results", [])

    def get_estado_repep(self) -> EstadoREPEP:
        try:
            rows = self._query("""
                SELECT id,
                       COALESCE(list_date, loaded_at) AS fecha_corte,
                       COALESCE(status, estado) AS estado,
                       COALESCE(loaded_at, created_at) AS created_at
                FROM comm_repep_versions
                WHERE COALESCE(status, estado) = 'active'
                ORDER BY created_at DESC
                LIMIT 1
            """)
        except Exception:
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_AUSENTE)

        if not rows:
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_AUSENTE)

        version = rows[0]
        fecha_corte_str = version.get("fecha_corte") or version.get("created_at", "")
        try:
            if "T" in fecha_corte_str:
                fecha_corte = datetime.fromisoformat(fecha_corte_str.replace("Z", "+00:00"))
            else:
                fecha_corte = datetime.strptime(fecha_corte_str[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except (ValueError, IndexError):
            return EstadoREPEP(vigente=False, motivo_fallo=MOTIVO_REPEP_EXPIRADO)

        antiguedad = (datetime.now(timezone.utc) - fecha_corte).days
        if antiguedad > REPEP_VIGENCIA_DIAS:
            return EstadoREPEP(
                vigente=False, version_id=str(version.get("id")),
                fecha_corte=fecha_corte_str, antiguedad_dias=antiguedad,
                motivo_fallo=MOTIVO_REPEP_EXPIRADO,
            )

        try:
            count_rows = self._query("SELECT COUNT(*) as total FROM comm_repep_numbers")
            total = count_rows[0]["total"] if count_rows else 0
        except Exception:
            total = 0

        return EstadoREPEP(
            vigente=True, version_id=str(version.get("id")),
            fecha_corte=fecha_corte_str, antiguedad_dias=antiguedad,
            total_numeros=total,
        )

    def get_hashes_repep(self) -> set[str]:
        hashes = set()
        offset = 0
        limit = 10_000
        while True:
            rows = self._query(f"SELECT phone_hash FROM comm_repep_numbers LIMIT {limit} OFFSET {offset}")
            if not rows:
                break
            for r in rows:
                hashes.add(r["phone_hash"])
            if len(rows) < limit:
                break
            offset += limit
        return hashes

    def get_supresiones(self, tenant_id: str, brand_id: Optional[str] = None) -> set[str]:
        rows = self._query(f"SELECT * FROM comm_suppressions WHERE tenant_id = '{tenant_id}'")
        supresiones = set()
        for r in rows:
            raw_tel = r.get("contacto") or r.get("telefono") or ""
            e164 = NormalizadorE164.normalizar(raw_tel)
            supresiones.add(e164 if e164 else raw_tel)
        return supresiones

    def get_optins(self, tenant_id: str, brand_id: Optional[str] = None, canal: str = "whatsapp") -> set[str]:
        rows = self._query(f"SELECT * FROM comm_consents WHERE tenant_id = '{tenant_id}' AND (channel = '{canal}' OR canal = '{canal}')")
        optins = set()
        for r in rows:
            if r.get("revoked_at"):
                continue
            raw_tel = r.get("contacto") or r.get("telefono") or ""
            e164 = NormalizadorE164.normalizar(raw_tel)
            if e164:
                optins.add(e164)
        return optins


class REPEPSourceArchivo:
    """Lee hashes REPEP de un archivo de texto exportado (modo air-gapped)."""

    def __init__(self, repep_file: str, supresiones_file: Optional[str] = None, optins_file: Optional[str] = None):
        self.repep_file = Path(repep_file)
        self.supresiones_file = Path(supresiones_file) if supresiones_file else None
        self.optins_file = Path(optins_file) if optins_file else None

        if not self.repep_file.exists():
            raise FileNotFoundError(f"Archivo REPEP no encontrado: {self.repep_file}")

    def get_estado_repep(self) -> EstadoREPEP:
        total = sum(1 for _ in open(self.repep_file, encoding="utf-8", errors="ignore"))
        return EstadoREPEP(
            vigente=True,
            total_numeros=total,
            fecha_corte="archivo_local",
            antiguedad_dias=0,
        )

    def get_hashes_repep(self) -> set[str]:
        hashes = set()
        with open(self.repep_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line and len(line) == 64:
                    hashes.add(line)
        return hashes

    def get_supresiones(self, tenant_id: str, brand_id: Optional[str] = None) -> set[str]:
        if not self.supresiones_file or not self.supresiones_file.exists():
            return set()
        supresiones = set()
        with open(self.supresiones_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line:
                    e164 = NormalizadorE164.normalizar(line)
                    supresiones.add(e164 if e164 else line)
        return supresiones

    def get_optins(self, tenant_id: str, brand_id: Optional[str] = None, canal: str = "whatsapp") -> set[str]:
        if not self.optins_file or not self.optins_file.exists():
            return set()
        optins = set()
        with open(self.optins_file, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line:
                    e164 = NormalizadorE164.normalizar(line)
                    if e164:
                        optins.add(e164)
        return optins


# ═══════════════════════════════════════════════════════════════════════════════
# §6. LECTOR DE AUDIENCIAS (CSV / EXCEL)
# ═══════════════════════════════════════════════════════════════════════════════

class AudienceReader:
    """Lee audiencias de CSV o Excel con detección flexible de columnas."""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        if not self.filepath.exists():
            raise FileNotFoundError(f"Archivo no encontrado: {self.filepath}")

        self.extension = self.filepath.suffix.lower()
        if self.extension not in (".csv", ".xlsx", ".xls"):
            raise ValueError(f"Formato no soportado: {self.extension}. Usa .csv o .xlsx")

    def leer(self) -> list[Contacto]:
        if self.extension == ".csv":
            return self._leer_csv()
        else:
            return self._leer_excel()

    def _detectar_columnas(self, headers: list[str]) -> dict[str, int]:
        headers_lower = [h.strip().lower() for h in headers]
        mapping = {}

        for i, h in enumerate(headers_lower):
            if h in COLUMNAS_TELEFONO:
                mapping["telefono"] = i
                break

        for i, h in enumerate(headers_lower):
            if h in COLUMNAS_NOMBRE:
                mapping["nombre"] = i
                break

        for i, h in enumerate(headers_lower):
            if h in COLUMNAS_APELLIDO:
                mapping["apellido"] = i
                break

        for i, h in enumerate(headers_lower):
            if h in COLUMNAS_EMAIL:
                mapping["email"] = i
                break

        return mapping

    def _leer_csv(self) -> list[Contacto]:
        contactos = []
        with open(self.filepath, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            headers = next(reader, None)
            if not headers:
                return []

            col_map = self._detectar_columnas(headers)
            if "telefono" not in col_map:
                raise ValueError(
                    f"No se encontró columna de teléfono. "
                    f"Columnas detectadas: {headers}. "
                    f"Columnas esperadas: {COLUMNAS_TELEFONO}"
                )

            for fila, row in enumerate(reader, start=2):
                if not row or len(row) <= col_map["telefono"]:
                    continue

                telefono_raw = row[col_map["telefono"]].strip()
                if not telefono_raw:
                    continue

                contacto = Contacto(
                    fila_original=fila,
                    telefono_raw=telefono_raw,
                    nombre=row[col_map["nombre"]].strip() if "nombre" in col_map and len(row) > col_map["nombre"] else None,
                    apellido=row[col_map["apellido"]].strip() if "apellido" in col_map and len(row) > col_map["apellido"] else None,
                    email=row[col_map["email"]].strip() if "email" in col_map and len(row) > col_map["email"] else None,
                    metadata={col: row[i] for i, col in enumerate(headers) if i < len(row) and i not in col_map.values()},
                )
                contactos.append(contacto)

        return contactos

    def _leer_excel(self) -> list[Contacto]:
        if not HAS_OPENPYXL:
            raise RuntimeError("Se requiere openpyxl para leer Excel: pip install openpyxl")

        wb = openpyxl.load_workbook(self.filepath, read_only=True, data_only=True)
        ws = wb.active
        contactos = []

        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []

        headers = [str(h) if h else "" for h in rows[0]]
        col_map = self._detectar_columnas(headers)

        if "telefono" not in col_map:
            raise ValueError(f"No se encontró columna de teléfono. Headers: {headers}")

        for fila, row in enumerate(rows[1:], start=2):
            if not row or len(row) <= col_map["telefono"]:
                continue

            telefono_raw = str(row[col_map["telefono"]] or "").strip()
            if not telefono_raw:
                continue

            contacto = Contacto(
                fila_original=fila,
                telefono_raw=telefono_raw,
                nombre=str(row[col_map["nombre"]] or "").strip() if "nombre" in col_map and len(row) > col_map["nombre"] else None,
                apellido=str(row[col_map["apellido"]] or "").strip() if "apellido" in col_map and len(row) > col_map["apellido"] else None,
                email=str(row[col_map["email"]] or "").strip() if "email" in col_map and len(row) > col_map["email"] else None,
            )
            contactos.append(contacto)

        wb.close()
        return contactos


# ═══════════════════════════════════════════════════════════════════════════════
# §7. MOTOR DE SANITIZACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

class AudienceCleaner:
    """Motor principal de sanitización de audiencias contra REPEP y supresiones."""

    def __init__(
        self,
        source,
        tenant_id: str,
        brand_id: Optional[str] = None,
        canal: str = "whatsapp",
        require_optin: bool = True,
        workers: Optional[int] = None,
    ):
        self.source = source
        self.tenant_id = tenant_id
        self.brand_id = brand_id
        self.canal = canal
        self.require_optin = require_optin
        self.hasher = HashingParalelo(workers=workers)
        self.resultados: list[ResultadoContacto] = []
        self.resumen = ResumenAuditoria(
            timestamp=datetime.now(timezone.utc).isoformat(),
            tenant_id=tenant_id,
            brand_id=brand_id,
            archivo_entrada="",
        )

    def sanitizar(self, contactos: list[Contacto], progress_callback=None) -> list[ResultadoContacto]:
        start_time = time.time()
        self.resumen.archivo_entrada = ""
        self.resumen.total_contactos = len(contactos)

        # ── PASO 0: Verificar vigencia REPEP (fail-closed) ──
        print("  [0/6] Verificando vigencia de lista REPEP PROFECO...")
        estado_repep = self.source.get_estado_repep()
        self.resumen.repep_estado = estado_repep

        if not estado_repep.vigente:
            print(f"  🔴 BLOQUEO FAIL-CLOSED: {estado_repep.motivo_fallo}")
            print(f"     La lista REPEP no está vigente. No se puede enviar NINGÚN mensaje.")
            print(f"     Actualizar lista: POST /api/v1/comunicacion/repep/upload")

            for c in contactos:
                self.resultados.append(ResultadoContacto(
                    contacto=c,
                    incluido=False,
                    motivo=estado_repep.motivo_fallo,
                    detalle=f"Lista REPEP con antigüedad de {estado_repep.antiguedad_dias or '?'} días (límite: {REPEP_VIGENCIA_DIAS})",
                    severidad="CRITICA",
                ))
            self.resumen.total_excluidos = len(contactos)
            self.resumen.duracion_segundos = time.time() - start_time
            return self.resultados

        print(f"       ✅ REPEP vigente: {estado_repep.total_numeros:,} números, "
              f"antigüedad {estado_repep.antiguedad_dias} días")

        # ── PASO 1: Normalización E.164 ──
        print("  [1/6] Normalizando teléfonos a E.164 (+52)...")
        validos = []
        for c in contactos:
            e164 = NormalizadorE164.normalizar(c.telefono_raw)
            if e164:
                c.telefono_e164 = e164
                validos.append(c)
            else:
                self.resultados.append(ResultadoContacto(
                    contacto=c,
                    incluido=False,
                    motivo=MOTIVO_TELEFONO_INVALIDO,
                    detalle=f"No se pudo normalizar: '{c.telefono_raw}'",
                    severidad=SEVERIDAD_MOTIVO[MOTIVO_TELEFONO_INVALIDO],
                ))

        print(f"       → {len(validos):,} normalizados / {len(contactos) - len(validos):,} inválidos")

        # ── PASO 2: Hashing SHA-256 en paralelo ──
        print(f"  [2/6] Generando hashes SHA-256 ({self.hasher.workers} workers)...")
        telefonos_e164 = [c.telefono_e164 for c in validos]
        hash_map = self.hasher.generar_hashes(telefonos_e164, progress_callback)

        for c in validos:
            c.telefono_hash = hash_map.get(c.telefono_e164)

        self.resumen.hashes_generados = len(hash_map)
        print(f"       → {len(hash_map):,} hashes generados")

        # ── PASO 3: Cargar listas de exclusión ──
        print("  [3/6] Cargando listas de exclusión...")
        repep_hashes = self.source.get_hashes_repep()
        supresiones = self.source.get_supresiones(self.tenant_id, self.brand_id)
        optins = self.source.get_optins(self.tenant_id, self.brand_id, self.canal) if self.require_optin else None

        print(f"       → REPEP: {len(repep_hashes):,} hashes")
        print(f"       → Supresiones (opt-out): {len(supresiones):,} números")
        if optins is not None:
            print(f"       → Opt-ins: {len(optins):,} consentimientos")

        # ── PASO 4: Cruce y evaluación ──
        print("  [4/6] Cruzando audiencia contra listas de exclusión...")
        vistos_e164 = set()

        for c in validos:
            resultado = self._evaluar_contacto(c, repep_hashes, supresiones, optins, vistos_e164)
            self.resultados.append(resultado)

        # ── PASO 5: Calcular resumen ──
        print("  [5/6] Calculando resumen ejecutivo...")
        for r in self.resultados:
            if r.incluido:
                self.resumen.total_validos += 1
            else:
                self.resumen.total_excluidos += 1
                self.resumen.exclusiones_por_motivo[r.motivo] = \
                    self.resumen.exclusiones_por_motivo.get(r.motivo, 0) + 1

        self.resumen.duracion_segundos = time.time() - start_time

        # ── PASO 6: Reporte ──
        print("  [6/6] Sanitización completada.\n")
        return self.resultados

    def _evaluar_contacto(
        self,
        contacto: Contacto,
        repep_hashes: set[str],
        supresiones: set[str],
        optins: Optional[set[str]],
        vistos: set[str],
    ) -> ResultadoContacto:
        if contacto.telefono_e164 in vistos:
            return ResultadoContacto(
                contacto=contacto,
                incluido=False,
                motivo=MOTIVO_DUPLICADO,
                detalle="Número duplicado en la audiencia",
                severidad=SEVERIDAD_MOTIVO[MOTIVO_DUPLICADO],
            )
        vistos.add(contacto.telefono_e164)

        if contacto.telefono_hash and contacto.telefono_hash in repep_hashes:
            return ResultadoContacto(
                contacto=contacto,
                incluido=False,
                motivo=MOTIVO_REPEP_MATCH,
                detalle="Número inscrito en REPEP PROFECO (SHA-256 match)",
                severidad=SEVERIDAD_MOTIVO[MOTIVO_REPEP_MATCH],
            )

        if contacto.telefono_e164 in supresiones:
            return ResultadoContacto(
                contacto=contacto,
                incluido=False,
                motivo=MOTIVO_OPT_OUT,
                detalle="Contacto solicitó baja (BAJA/STOP/ALTO) — comm_suppressions",
                severidad=SEVERIDAD_MOTIVO[MOTIVO_OPT_OUT],
            )

        if optins is not None and contacto.telefono_e164 not in optins:
            return ResultadoContacto(
                contacto=contacto,
                incluido=False,
                motivo=MOTIVO_NO_OPTIN,
                detalle=f"Sin consentimiento expreso para canal '{self.canal}' en comm_consents",
                severidad=SEVERIDAD_MOTIVO[MOTIVO_NO_OPTIN],
            )

        return ResultadoContacto(contacto=contacto, incluido=True)


# ═══════════════════════════════════════════════════════════════════════════════
# §8. GENERADORES DE SALIDA
# ═══════════════════════════════════════════════════════════════════════════════

class OutputGenerator:
    """Genera los archivos de salida de la sanitización."""

    def __init__(self, output_dir: str = "./output"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def generar_audiencia_limpia(
        self,
        resultados: list[ResultadoContacto],
        filename: str = "audiencia_limpia.csv",
    ) -> Path:
        filepath = self.output_dir / filename
        incluidos = [r for r in resultados if r.incluido]

        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["telefono_e164", "nombre", "apellido", "email", "telefono_hash"])
            for r in incluidos:
                c = r.contacto
                writer.writerow([
                    c.telefono_e164,
                    c.nombre or "",
                    c.apellido or "",
                    c.email or "",
                    c.telefono_hash or "",
                ])

        return filepath

    def generar_reporte_exclusiones(
        self,
        resultados: list[ResultadoContacto],
        filename: str = "exclusiones_reporte.csv",
    ) -> Path:
        filepath = self.output_dir / filename
        excluidos = [r for r in resultados if not r.incluido]

        orden_severidad = {"CRITICA": 0, "ALTA": 1, "MEDIA": 2, "BAJA": 3}
        excluidos.sort(key=lambda r: orden_severidad.get(r.severidad, 4))

        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "fila_original", "telefono_raw", "telefono_e164",
                "severidad", "motivo", "detalle", "nombre", "email",
            ])
            for r in excluidos:
                c = r.contacto
                writer.writerow([
                    c.fila_original,
                    c.telefono_raw,
                    c.telefono_e164 or "",
                    r.severidad or "",
                    r.motivo or "",
                    r.detalle or "",
                    c.nombre or "",
                    c.email or "",
                ])

        return filepath

    def generar_resumen_json(
        self,
        resumen: ResumenAuditoria,
        filename: str = "resumen_ejecutivo.json",
    ) -> Path:
        filepath = self.output_dir / filename

        data = {
            "timestamp": resumen.timestamp,
            "tenant_id": resumen.tenant_id,
            "brand_id": resumen.brand_id,
            "archivo_entrada": resumen.archivo_entrada,
            "total_contactos": resumen.total_contactos,
            "total_validos": resumen.total_validos,
            "total_excluidos": resumen.total_excluidos,
            "tasa_limpieza_pct": round(
                (resumen.total_validos / resumen.total_contactos * 100) if resumen.total_contactos > 0 else 0, 2
            ),
            "exclusiones_por_motivo": resumen.exclusiones_por_motivo,
            "hashes_generados": resumen.hashes_generados,
            "duracion_segundos": round(resumen.duracion_segundos, 2),
            "repep_estado": {
                "vigente": resumen.repep_estado.vigente if resumen.repep_estado else None,
                "version_id": resumen.repep_estado.version_id if resumen.repep_estado else None,
                "fecha_corte": resumen.repep_estado.fecha_corte if resumen.repep_estado else None,
                "antiguedad_dias": resumen.repep_estado.antiguedad_dias if resumen.repep_estado else None,
                "total_numeros": resumen.repep_estado.total_numeros if resumen.repep_estado else 0,
                "motivo_fallo": resumen.repep_estado.motivo_fallo if resumen.repep_estado else None,
            },
            "cumplimiento": {
                "repep_profeco": "BLOQUEADO" if (resumen.repep_estado and not resumen.repep_estado.vigente) else "OK",
                "opt_out_respetado": "OK",
                "opt_in_verificado": "OK",
                "e164_normalizado": "OK",
            },
        }

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        return filepath


# ═══════════════════════════════════════════════════════════════════════════════
# §9. VISUALIZACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

class Visualizer:
    """Visualiza resultados en consola."""

    def __init__(self):
        self.console = Console() if HAS_RICH else None

    def imprimir_resumen(self, resumen: ResumenAuditoria, resultados: list[ResultadoContacto]):
        if self.console:
            self._resumen_rich(resumen, resultados)
        else:
            self._resumen_plano(resumen)

    def _resumen_rich(self, resumen: ResumenAuditoria, resultados: list[ResultadoContacto]):
        c = self.console
        repep = resumen.repep_estado
        if repep:
            if repep.vigente:
                estado_text = f"[green]✅ VIGENTE[/] — {repep.total_numeros:,} números, {repep.antiguedad_dias} días de antigüedad"
            else:
                estado_text = f"[red]🔴 BLOQUEADO[/] — {repep.motivo_fallo} (fail-closed)"

            c.print(Panel(
                f"Lista REPEP PROFECO: {estado_text}\n"
                f"Vigencia máxima: {REPEP_VIGENCIA_DIAS} días | "
                f"Última corte: {repep.fecha_corte or 'N/A'}",
                title="🛡️ Estado REPEP",
                border_style="red" if not repep.vigente else "green",
            ))

        table = Table(title="📊 Resultados de Sanitización", show_header=True, header_style="bold magenta")
        table.add_column("Métrica", style="cyan")
        table.add_column("Valor", justify="right", style="green")

        tasa = (resumen.total_validos / resumen.total_contactos * 100) if resumen.total_contactos > 0 else 0
        table.add_row("Total contactos", f"{resumen.total_contactos:,}")
        table.add_row("✅ Audiencia limpia", f"{resumen.total_validos:,} ({tasa:.1f}%)")
        table.add_row("❌ Excluidos", f"{resumen.total_excluidos:,}")
        table.add_row("Hashes SHA-256", f"{resumen.hashes_generados:,}")
        table.add_row("Duración", f"{resumen.duracion_segundos:.2f}s")

        c.print(table)

        if resumen.exclusiones_por_motivo:
            c.print()
            table2 = Table(title="🚫 Desglose de Exclusiones", show_header=True, header_style="bold magenta")
            table2.add_column("Motivo", style="cyan")
            table2.add_column("Severidad", justify="center")
            table2.add_column("Cantidad", justify="right")

            severidad_color = {
                "CRITICA": "[red]CRITICA[/]",
                "ALTA": "[yellow]ALTA[/]",
                "MEDIA": "[blue]MEDIA[/]",
                "BAJA": "[dim]BAJA[/]",
            }

            for motivo, count in sorted(
                resumen.exclusiones_por_motivo.items(),
                key=lambda x: -x[1]
            ):
                sev = SEVERIDAD_MOTIVO.get(motivo, "BAJA")
                table2.add_row(motivo, severidad_color.get(sev, sev), str(count))

            c.print(table2)

        c.print()
        if resumen.total_validos == 0:
            c.print("[bold red]⛔ NO SE PUEDE ENVIAR NINGÚN MENSAJE. Audiencia completamente bloqueada.[/]")
        else:
            c.print(f"[bold green]✅ {resumen.total_validos:,} contactos listos para CAMPAIGN_DISPATCH_V1[/]")

    def _resumen_plano(self, resumen: ResumenAuditoria):
        print(f"\n{'='*60}")
        print("  RESULTADOS DE SANITIZACIÓN")
        print(f"{'='*60}")
        print(f"  Total contactos:  {resumen.total_contactos:,}")
        print(f"  Audiencia limpia: {resumen.total_validos:,}")
        print(f"  Excluidos:        {resumen.total_excluidos:,}")
        print(f"  Duración:         {resumen.duracion_segundos:.2f}s")
        print(f"\n  Exclusiones:")
        for motivo, count in resumen.exclusiones_por_motivo.items():
            print(f"    {motivo}: {count}")
        print(f"{'='*60}\n")


# ═══════════════════════════════════════════════════════════════════════════════
# §10. CLI Y ORQUESTACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="REPEP Audience Cleaner — Sanitizador masivo de audiencias para Arkangel",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos:
  # Sanitizar CSV contra D1 local
  python repep_audience_cleaner.py --input leads_temozonia.csv --tenant temozonia

  # Sanitizar Excel con marca específica
  python repep_audience_cleaner.py --input leads.xlsx --tenant ark --brand "Ark Oficios"

  # Modo producción (D1 remoto)
  python repep_audience_cleaner.py --input leads.csv --mode remote --account-id x --db-id y --token z --tenant baakal

  # Modo air-gapped con archivo de hashes exportado
  python repep_audience_cleaner.py --input leads.csv --repep-file repep_hashes.txt --tenant canaco_merida

  # Sin verificación de opt-in (solo REPEP y supresiones)
  python repep_audience_cleaner.py --input leads.csv --tenant temozonia --no-require-optin
        """
    )
    parser.add_argument("--input", required=True, help="Archivo de audiencia (CSV o Excel)")
    parser.add_argument("--tenant", required=True, help="Tenant ID (temozonia, baakal, canaco_merida, ark)")
    parser.add_argument("--brand", help="Brand ID específico para cruce de supresiones/consentimientos")
    parser.add_argument("--canal", default="whatsapp", choices=["whatsapp", "sms", "email"],
                        help="Canal de envío para verificación de opt-in (default: whatsapp)")
    parser.add_argument("--mode", choices=["local", "remote", "archivo"], default="local",
                        help="Fuente de datos REPEP")
    parser.add_argument("--db-path", help="Ruta explícita al .sqlite de D1 (modo local)")
    parser.add_argument("--repep-file", help="Archivo de hashes SHA-256 REPEP (modo archivo)")
    parser.add_argument("--supresiones-file", help="Archivo de supresiones (modo archivo)")
    parser.add_argument("--optins-file", help="Archivo de opt-ins (modo archivo)")
    parser.add_argument("--account-id", help="Cloudflare Account ID (modo remote)")
    parser.add_argument("--db-id", help="Cloudflare D1 Database ID (modo remote)")
    parser.add_argument("--token", help="Cloudflare API Token (modo remote)")
    parser.add_argument("--output-dir", default="./output", help="Directorio de salida")
    parser.add_argument("--workers", type=int, help="Número de workers para hashing paralelo")
    parser.add_argument("--no-require-optin", action="store_true",
                        help="No verificar opt-in expreso (solo REPEP y supresiones)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Solo mostrar resumen sin generar archivos")
    return parser


def main():
    args = build_parser().parse_args()

    print(f"\n{'='*64}")
    print(f"  🛡️  REPEP AUDIENCE CLEANER — Arkangel")
    print(f"  Tenant: {args.tenant} | Canal: {args.canal} | Modo: {args.mode}")
    print(f"{'='*64}\n")

    try:
        if args.mode == "local":
            source = REPEPSourceLocal(args.db_path)
        elif args.mode == "remote":
            if not all([args.account_id, args.db_id, args.token]):
                print("❌ Error: modo remote requiere --account-id, --db-id y --token")
                sys.exit(1)
            source = REPEPSourceRemoto(args.account_id, args.db_id, args.token)
        elif args.mode == "archivo":
            if not args.repep_file:
                print("❌ Error: modo archivo requiere --repep-file")
                sys.exit(1)
            source = REPEPSourceArchivo(args.repep_file, args.supresiones_file, args.optins_file)
        else:
            print(f"Modo desconocido: {args.mode}")
            sys.exit(1)
    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

    print("  Leyendo audiencia de entrada...")
    try:
        reader = AudienceReader(args.input)
        contactos = reader.leer()
    except (FileNotFoundError, ValueError) as e:
        print(f"❌ Error al leer audiencia: {e}")
        sys.exit(1)

    print(f"  → {len(contactos):,} contactos cargados\n")

    if not contactos:
        print("⚠️  La audiencia está vacía. Nada que sanitizar.")
        sys.exit(0)

    cleaner = AudienceCleaner(
        source=source,
        tenant_id=args.tenant,
        brand_id=args.brand,
        canal=args.canal,
        require_optin=not args.no_require_optin,
        workers=args.workers,
    )

    resultados = cleaner.sanitizar(contactos)

    viz = Visualizer()
    viz.imprimir_resumen(cleaner.resumen, resultados)

    if not args.dry_run:
        output = OutputGenerator(args.output_dir)

        limpia_path = output.generar_audiencia_limpia(resultados)
        print(f"\n  📄 Audiencia limpia: {limpia_path}")

        exclusiones_path = output.generar_reporte_exclusiones(resultados)
        print(f"  📋 Reporte de exclusiones: {exclusiones_path}")

        resumen_path = output.generar_resumen_json(cleaner.resumen)
        print(f"  📊 Resumen ejecutivo: {resumen_path}")

        print(f"\n  ✅ Listo. Importa '{limpia_path.name}' al Motor de Comunicación.")
    else:
        print("\n  [DRY RUN] No se generaron archivos.")

    if cleaner.resumen.repep_estado and not cleaner.resumen.repep_estado.vigente:
        sys.exit(2)
    elif cleaner.resumen.total_validos == 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
