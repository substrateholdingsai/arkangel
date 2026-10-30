#!/usr/bin/env python3

"""

carrier_cost_watchdog.py — Auditor de Costos, Conciliación y Márgenes por Tenant

=================================================================================

Arkangel · Plataforma de Cobranza Agéntica

Plano Financiero: Visibilidad exacta de margen por carrier y tenant.



Problema resuelto:

  Arkangel paga centavos a carriers (Telnyx WhatsApp/SMS, Resend, Meta) y cobra

  a tenants por paquete o por mensaje. Este script cruza estados reales de

  entrega contra tarifas para detectar fugas de dinero y generar reportes

  de cobro listos para facturación.



Fuentes de datos:

  - D1 local (.wrangler/state/v3/d1/*.sqlite) — modo desarrollo

  - D1 remoto vía Cloudflare REST API — modo producción

  - CSV exportado de comm_envios / usage_events — modo offline



Salidas:

  - Alertas de anomalías (mensajes cobrados no entregados, errores de plantilla)

  - Reporte mensual por tenant en CSV, Excel (.xlsx) o PDF

  - Resumen ejecutivo con márgenes por carrier



Uso:

  python carrier_cost_watchdog.py --mode local --month 2026-10

  python carrier_cost_watchdog.py --mode remote --month 2026-10 --output xlsx

  python carrier_cost_watchdog.py --mode csv --input comm_envios_dump.csv

  python carrier_cost_watchdog.py --mode local --month 2026-10 --tenant canaco_merida

"""



from __future__ import annotations



import argparse

import csv

import hashlib

import json

import os

import sqlite3

import sys

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

from collections import defaultdict

from dataclasses import dataclass, field

from datetime import datetime, timedelta

from pathlib import Path

from typing import Optional



# ─── Dependencias opcionales (graceful degradation) ──────────────────────────



try:

    import requests

    HAS_REQUESTS = True

except ImportError:

    HAS_REQUESTS = False



try:

    from openpyxl import Workbook

    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    from openpyxl.utils import get_column_letter

    HAS_OPENPYXL = True

except ImportError:

    HAS_OPENPYXL = False



try:

    from reportlab.lib import colors

    from reportlab.lib.pagesizes import letter, landscape

    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    from reportlab.lib.units import inch

    from reportlab.platypus import (

        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak

    )

    HAS_REPORTLAB = True

except ImportError:

    HAS_REPORTLAB = False



try:

    import pandas as pd

    HAS_PANDAS = True

except ImportError:

    HAS_PANDAS = False





# ═══════════════════════════════════════════════════════════════════════════════

# §1. CONFIGURACIÓN DE TARIFAS

# ═══════════════════════════════════════════════════════════════════════════════



@dataclass

class TarifaCarrier:

    """Tarifa de costo (lo que Arkangel paga al proveedor)."""

    carrier: str

    canal: str

    costo_unitario_usd: float

    moneda_costo: str = "USD"

    notas: str = ""





@dataclass

class TarifaCliente:

    """Tarifa de facturación (lo que Arkangel cobra al tenant)."""

    canal: str

    precio_unitario_mxn: float

    moneda: str = "MXN"

    esquema: str = "por_mensaje"  # por_mensaje | paquete | minuto

    notas: str = ""





# Tarifas de costo de proveedores (actualizar según contrato vigente)

TARIFAS_CARRIER = {

    "whatsapp_telnyx": TarifaCarrier(

        carrier="Telnyx",

        canal="whatsapp",

        costo_unitario_usd=0.005,  # Tarifa Telnyx WhatsApp Business

        notas="Session message rate MX via Telnyx v2 API"

    ),

    "whatsapp_meta": TarifaCarrier(

        carrier="Meta",

        canal="whatsapp",

        costo_unitario_usd=0.0075,  # Tarifa Meta Business (fallback)

        notas="Meta Cloud API direct (si aplica)"

    ),

    "sms_telnyx": TarifaCarrier(

        carrier="Telnyx",

        canal="sms",

        costo_unitario_usd=0.0079,  # SMS México outbound

        notas="SMS MX outbound Telnyx"

    ),

    "email_resend": TarifaCarrier(

        carrier="Resend",

        canal="email",

        costo_unitario_usd=0.001,  # ~$1 por 1000 emails

        notas="Resend transactional email"

    ),

    "voice_telnyx": TarifaCarrier(

        carrier="Telnyx",

        canal="voice",

        costo_unitario_usd=0.013,  # Por minuto MX PSTN

        notas="Voice AI PSTN MX por minuto"

    ),

}



# Tarifas de facturación al cliente (configurar por contrato con cada tenant)

TARIFAS_CLIENTE = {

    "whatsapp": TarifaCliente(canal="whatsapp", precio_unitario_mxn=0.18, notas="WhatsApp HSM template"),

    "sms": TarifaCliente(canal="sms", precio_unitario_mxn=0.12, notas="SMS transaccional"),

    "email": TarifaCliente(canal="email", precio_unitario_mxn=0.05, notas="Email transaccional"),

    "voice": TarifaCliente(canal="voice", precio_unitario_mxn=1.50, esquema="minuto", notas="Voice AI por minuto"),

}



# Tipo de cambio de referencia (actualizar periódicamente)

TIPO_CAMBIO_USD_MXN = 17.85  # Octubre 2026 aproximado



# Tenants conocidos del sistema

TENANTS_CONOCIDOS = {

    "temozonia": "Temozonía",

    "baakal": "Baak'al",

    "canaco_merida": "CANACO Mérida",

    "ark": "Ark Systems",

}





# ═══════════════════════════════════════════════════════════════════════════════

# §2. MODELOS DE DATOS

# ═══════════════════════════════════════════════════════════════════════════════



@dataclass

class Envio:

    """Registro individual de comm_envios."""

    id: int

    tenant_id: str

    campaign_id: Optional[str]

    canal: str  # whatsapp | sms | email | voice

    carrier: str  # telnyx | meta | resend

    phone: str

    brand_id: Optional[str]

    status: str  # sent | delivered | read | failed | excluded | deferred

    motivo: Optional[str]

    provider_id: Optional[str]

    provider_status: Optional[str]

    error_code: Optional[str]

    created_at: str

    costo_estimado_usd: float = 0.0

    facturable: bool = True





@dataclass

class Anomalia:

    """Anomalía detectada en la auditoría."""

    severidad: str  # critica | alta | media | baja

    tipo: str

    tenant_id: str

    carrier: str

    descripcion: str

    cantidad_afectada: int

    monto_estimado_usd: float

    mensajes_ejemplo: list = field(default_factory=list)





@dataclass

class ResumenTenant:

    """Resumen agregado por tenant."""

    tenant_id: str

    tenant_nombre: str

    canal: str

    carrier: str

    total_enviados: int = 0

    total_entregados: int = 0

    total_leidos: int = 0

    total_fallidos: int = 0

    total_excluidos: int = 0

    total_diferidos: int = 0

    costo_carrier_usd: float = 0.0

    costo_carrier_mxn: float = 0.0

    facturacion_estimada_mxn: float = 0.0

    margen_mxn: float = 0.0

    margen_pct: float = 0.0

    tasa_entrega_pct: float = 0.0





# ═══════════════════════════════════════════════════════════════════════════════

# §3. FUENTES DE DATOS

# ═══════════════════════════════════════════════════════════════════════════════



class D1LocalSource:

    """Lee directamente del archivo .sqlite de D1 local (Wrangler state)."""



    def __init__(self, db_path: Optional[str] = None):

        if db_path:

            self.db_path = Path(db_path)

        else:

            self.db_path = self._find_d1_local()

        if not self.db_path.exists():

            raise FileNotFoundError(

                f"No se encontró la base D1 local en: {self.db_path}\n"

                f"Hint: Ejecuta 'wrangler d1 execute arkangel-db --local' primero."

            )



    def _find_d1_local(self) -> Path:

        """Busca el archivo .sqlite de D1 en el estado local de Wrangler."""

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

        # Fallback: buscar en todo el proyecto

        for f in Path(".").rglob("*.sqlite"):

            if "d1" in str(f).lower() and "metadata" not in f.name:

                return f

        raise FileNotFoundError(

            "No se encontró ningún archivo .sqlite de D1. "

            "Usa --db-path para especificar manualmente."

        )



    def query(self, sql: str, params: tuple = ()) -> list[dict]:

        conn = sqlite3.connect(str(self.db_path))

        conn.row_factory = sqlite3.Row

        try:

            cursor = conn.execute(sql, params)

            return [dict(row) for row in cursor.fetchall()]

        finally:

            conn.close()



    def get_envios(self, mes: str, tenant_id: Optional[str] = None) -> list[Envio]:

        """Extrae comm_envios para el período especificado."""

        año, mes_num = mes.split("-")

        fecha_inicio = f"{año}-{mes_num}-01"

        # Calcular fin de mes

        mes_int = int(mes_num)

        año_int = int(año)

        if mes_int == 12:

            fecha_fin = f"{año_int + 1}-01-01"

        else:

            fecha_fin = f"{año_int}-{mes_int + 1:02d}-01"



        sql = """

            SELECT * FROM comm_envios

            WHERE created_at >= ? AND created_at < ?

        """

        params = [fecha_inicio, fecha_fin]



        if tenant_id:

            sql += " AND tenant_id = ?"

            params.append(tenant_id)



        sql += " ORDER BY created_at ASC"



        rows = self.query(sql, tuple(params))

        return [self._row_to_envio(r) for r in rows]



    def get_usage_events(self, mes: str, tenant_id: Optional[str] = None) -> list[dict]:

        """Extrae usage_events para el período (bolsa de consumo)."""

        año, mes_num = mes.split("-")

        fecha_inicio = f"{año}-{mes_num}-01"

        mes_int = int(mes_num)

        año_int = int(año)

        fecha_fin = f"{año_int + 1}-01-01" if mes_int == 12 else f"{año_int}-{mes_int + 1:02d}-01"



        sql = """

            SELECT

                id,

                tenant_id,

                tipo,

                cantidad,

                costo_unitario,

                total,

                created_at

            FROM usage_events

            WHERE created_at >= ? AND created_at < ?

        """

        params = [fecha_inicio, fecha_fin]

        if tenant_id:

            sql += " AND tenant_id = ?"

            params.append(tenant_id)



        return self.query(sql, tuple(params))



    @staticmethod

    def _row_to_envio(row: dict) -> Envio:
        canal = row.get("canal") or row.get("channel", "unknown")
        carrier = row.get("carrier")
        if not carrier:
            if canal == "email":
                carrier = "resend"
            elif str(row.get("provider_id", "")).startswith("wamid"):
                carrier = "meta"
            else:
                carrier = "telnyx"

        key = f"{canal}_{carrier}"
        tarifa = TARIFAS_CARRIER.get(key)
        costo = tarifa.costo_unitario_usd if tarifa else 0.0

        status = row.get("status", "sent")
        facturable = status in ("sent", "delivered", "read")

        return Envio(

            id=row.get("id", 0),

            tenant_id=row.get("tenant_id", "unknown"),

            campaign_id=row.get("campaign_id"),

            canal=canal,

            carrier=carrier,

            phone=row.get("phone") or row.get("contacto", ""),

            brand_id=row.get("brand_id") or row.get("tenant_id"),

            status=status,

            motivo=row.get("motivo"),

            provider_id=row.get("provider_id"),

            provider_status=row.get("provider_status") or status,

            error_code=row.get("error_code") or row.get("motivo"),

            created_at=row.get("created_at", ""),

            costo_estimado_usd=costo,

            facturable=facturable,

        )





class D1RemoteSource:

    """Accede a D1 remoto vía Cloudflare REST API."""



    def __init__(self, account_id: str, database_id: str, api_token: str):

        self.account_id = account_id

        self.database_id = database_id

        self.api_token = api_token

        self.base_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"



    def query(self, sql: str) -> list[dict]:

        if not HAS_REQUESTS:

            raise RuntimeError("Se requiere 'requests' para modo remoto: pip install requests")



        resp = requests.post(

            self.base_url,

            headers={

                "Authorization": f"Bearer {self.api_token}",

                "Content-Type": "application/json",

            },

            json={"sql": sql},

            timeout=30,

        )

        resp.raise_for_status()

        data = resp.json()

        if not data.get("success"):

            raise RuntimeError(f"Error D1 API: {data.get('errors', [])}")

        return data["result"][0].get("results", [])



    def get_envios(self, mes: str, tenant_id: Optional[str] = None) -> list[Envio]:

        año, mes_num = mes.split("-")

        fecha_inicio = f"{año}-{mes_num}-01"

        mes_int = int(mes_num)

        año_int = int(año)

        fecha_fin = f"{año_int + 1}-01-01" if mes_int == 12 else f"{año_int}-{mes_int + 1:02d}-01"



        where = f"WHERE created_at >= '{fecha_inicio}' AND created_at < '{fecha_fin}'"

        if tenant_id:

            where += f" AND tenant_id = '{tenant_id}'"



        sql = f"""

            SELECT * FROM comm_envios

            {where}

            ORDER BY created_at ASC

        """

        rows = self.query(sql)

        return [D1LocalSource._row_to_envio(r) for r in rows]





class CSVSource:

    """Lee de un CSV exportado previamente."""



    def __init__(self, csv_path: str):

        self.csv_path = Path(csv_path)

        if not self.csv_path.exists():

            raise FileNotFoundError(f"CSV no encontrado: {self.csv_path}")



    def get_envios(self, mes: str = "", tenant_id: Optional[str] = None) -> list[Envio]:

        envios = []

        with open(self.csv_path, "r", encoding="utf-8") as f:

            reader = csv.DictReader(f)

            for row in reader:

                if tenant_id and row.get("tenant_id") != tenant_id:

                    continue

                envios.append(D1LocalSource._row_to_envio(row))

        return envios





# ═══════════════════════════════════════════════════════════════════════════════

# §4. MOTOR DE AUDITORÍA

# ═══════════════════════════════════════════════════════════════════════════════



class CostWatchdog:

    """Motor principal de auditoría de costos y márgenes."""



    def __init__(self, source, mes: str, tenant_filter: Optional[str] = None):

        self.source = source

        self.mes = mes

        self.tenant_filter = tenant_filter

        self.envios: list[Envio] = []

        self.anomalias: list[Anomalia] = []

        self.resumenes: list[ResumenTenant] = []



    def ejecutar(self):

        """Ejecuta el pipeline completo de auditoría."""

        print(f"{'='*72}")

        print(f"  CARRIER COST WATCHDOG — Arkangel")

        print(f"  Período: {self.mes} | Tenant: {self.tenant_filter or 'TODOS'}")

        print(f"{'='*72}\n")



        # 1. Extraer datos

        print("[1/5] Extrayendo comm_envios de D1...")

        self.envios = self.source.get_envios(self.mes, self.tenant_filter)

        print(f"       → {len(self.envios):,} registros de envío encontrados")



        # 2. Enriquecer con costos

        print("[2/5] Enriqueciendo con tarifas de costo y facturación...")

        self._enriquecer_costos()



        # 3. Detectar anomalías

        print("[3/5] Ejecutando reglas de auditoría...")

        self._detectar_anomalias()



        # 4. Agregar resúmenes por tenant

        print("[4/5] Generando resúmenes por tenant/canal/carrier...")

        self._generar_resumenes()



        # 5. Reporte

        print("[5/5] Compilando reporte...")

        print()



        self._imprimir_resumen_ejecutivo()

        self._imprimir_anomalias()



    def _enriquecer_costos(self):

        """Calcula costos y facturabilidad por envío."""

        for envio in self.envios:

            key = f"{envio.canal}_{envio.carrier}"

            tarifa = TARIFAS_CARRIER.get(key)

            if tarifa:

                envio.costo_estimado_usd = tarifa.costo_unitario_usd

            # Mensajes fallidos/excluidos no deberían facturarse

            if envio.status in ("failed", "excluded"):

                envio.facturable = False



    def _detectar_anomalias(self):

        """Aplica reglas de detección de anomalías."""

        self._regla_mensajes_fallidos_cobrados()

        self._regla_errores_plantilla()

        self._regla_tasa_entrega_baja()

        self._regla_carrier_desconocido()

        self._regla_costo_sin_tarifa()



    def _regla_mensajes_fallidos_cobrados(self):

        """REGLA 1: Detecta mensajes fallidos que podrían estar cobrándose."""

        fallidos_por_tenant = defaultdict(lambda: {"count": 0, "costo": 0.0, "ejemplos": []})



        for e in self.envios:

            if e.status == "failed" and e.facturable:

                key = (e.tenant_id, e.carrier)

                fallidos_por_tenant[key]["count"] += 1

                fallidos_por_tenant[key]["costo"] += e.costo_estimado_usd

                if len(fallidos_por_tenant[key]["ejemplos"]) < 5:

                    fallidos_por_tenant[key]["ejemplos"].append(

                        f"  id={e.id} phone={e.phone[:8]}*** status={e.status}"

                    )



        for (tenant, carrier), data in fallidos_por_tenant.items():

            if data["count"] > 0:

                self.anomalias.append(Anomalia(

                    severidad="CRITICA" if data["count"] > 50 else "ALTA",

                    tipo="MENSAJE_FALLIDO_COBRADO",

                    tenant_id=tenant,

                    carrier=carrier,

                    descripcion=(

                        f"{data['count']} mensajes con estado 'failed' podrían estar "

                        f"incluidos en facturación. El carrier NO debería cobrar estos."

                    ),

                    cantidad_afectada=data["count"],

                    monto_estimado_usd=data["costo"],

                    mensajes_ejemplo=data["ejemplos"],

                ))



    def _regla_errores_plantilla(self):

        """REGLA 2: Errores de plantilla HSM (WhatsApp) que generan costo sin entrega."""

        errores_plantilla = defaultdict(lambda: {"count": 0, "ejemplos": []})



        for e in self.envios:

            if e.canal == "whatsapp" and e.error_code:

                # Códigos de error de plantilla Meta/Telnyx

                errores_template = [

                    "130472",  # Template not approved

                    "131047",  # Re-engagement required

                    "131051",  # Unsupported message type

                    "132000",  # Template param mismatch

                    "133000",  # Template not found

                ]

                if e.error_code in errores_template:

                    key = (e.tenant_id, e.carrier)

                    errores_plantilla[key]["count"] += 1

                    if len(errores_plantilla[key]["ejemplos"]) < 5:

                        errores_plantilla[key]["ejemplos"].append(

                            f"  id={e.id} error={e.error_code} brand={e.brand_id}"

                        )



        for (tenant, carrier), data in errores_plantilla.items():

            if data["count"] > 0:

                self.anomalias.append(Anomalia(

                    severidad="ALTA",

                    tipo="ERROR_PLANTILLA_HSM",

                    tenant_id=tenant,

                    carrier=carrier,

                    descripcion=(

                        f"{data['count']} mensajes WhatsApp rechazados por error de "

                        f"plantilla HSM. Costo perdido: Meta cobra intentos aunque fallen."

                    ),

                    cantidad_afectada=data["count"],

                    monto_estimado_usd=data["count"] * TARIFAS_CARRIER.get(

                        "whatsapp_telnyx", TarifaCarrier("x", "x", 0.005)

                    ).costo_unitario_usd,

                    mensajes_ejemplo=data["ejemplos"],

                ))



    def _regla_tasa_entrega_baja(self):

        """REGLA 3: Tasa de entrega anormalmente baja por tenant/carrier."""

        stats = defaultdict(lambda: {"total": 0, "entregados": 0})



        for e in self.envios:

            if e.status not in ("excluded", "deferred"):

                key = (e.tenant_id, e.carrier, e.canal)

                stats[key]["total"] += 1

                if e.status in ("delivered", "read"):

                    stats[key]["entregados"] += 1



        for (tenant, carrier, canal), data in stats.items():

            if data["total"] >= 10:  # Solo evaluar con muestra suficiente

                tasa = data["entregados"] / data["total"] * 100

                if tasa < 70:  # Umbral: menos del 70% de entrega

                    self.anomalias.append(Anomalia(

                        severidad="MEDIA",

                        tipo="TASA_ENTREGA_BAJA",

                        tenant_id=tenant,

                        carrier=carrier,

                        descripcion=(

                            f"Tasa de entrega del {tasa:.1f}% en canal '{canal}' "

                            f"({data['entregados']}/{data['total']}). "

                            f"Posible problema de calidad de número o spam."

                        ),

                        cantidad_afectada=data["total"] - data["entregados"],

                        monto_estimado_usd=(data["total"] - data["entregados"]) * 0.005,

                    ))



    def _regla_carrier_desconocido(self):

        """REGLA 4: Envíos con carrier no mapeado en tarifas."""

        carriers_vistos = set()

        for e in self.envios:

            key = f"{e.canal}_{e.carrier}"

            if key not in TARIFAS_CARRIER:

                carriers_vistos.add((e.tenant_id, e.carrier, e.canal))



        for tenant, carrier, canal in carriers_vistos:

            self.anomalias.append(Anomalia(

                severidad="MEDIA",

                tipo="CARRIER_SIN_TARIFA",

                tenant_id=tenant,

                carrier=carrier,

                descripcion=(

                    f"Canal '{canal}' con carrier '{carrier}' no tiene tarifa "

                    f"configurada. Los costos se están calculando en $0."

                ),

                cantidad_afectada=0,

                monto_estimado_usd=0,

            ))



    def _regla_costo_sin_tarifa(self):

        """REGLA 5: Mensajes sin costo asignado (fuga silenciosa)."""

        sin_costo = [e for e in self.envios if e.costo_estimado_usd == 0 and e.status == "sent"]

        if sin_costo:

            tenants_afectados = set(e.tenant_id for e in sin_costo)

            self.anomalias.append(Anomalia(

                severidad="ALTA",

                tipo="ENVIO_SIN_COSTO",

                tenant_id=", ".join(tenants_afectados),

                carrier="varios",

                descripcion=(

                    f"{len(sin_costo)} envíos con estado 'sent' sin costo calculado. "

                    f"Verificar mapeo de tarifas."

                ),

                cantidad_afectada=len(sin_costo),

                monto_estimado_usd=0,

            ))



    def _generar_resumenes(self):

        """Agrega métricas por tenant/canal/carrier."""

        agregado: dict[tuple, ResumenTenant] = {}



        for e in self.envios:

            key = (e.tenant_id, e.canal, e.carrier)

            if key not in agregado:

                nombre = TENANTS_CONOCIDOS.get(e.tenant_id, e.tenant_id)

                agregado[key] = ResumenTenant(

                    tenant_id=e.tenant_id,

                    tenant_nombre=nombre,

                    canal=e.canal,

                    carrier=e.carrier,

                )



            r = agregado[key]

            if e.status == "sent":

                r.total_enviados += 1

            elif e.status == "delivered":

                r.total_entregados += 1

            elif e.status == "read":

                r.total_leidos += 1

            elif e.status == "failed":

                r.total_fallidos += 1

            elif e.status == "excluded":

                r.total_excluidos += 1

            elif e.status == "deferred":

                r.total_diferidos += 1



            # Solo cobrar mensajes enviados/entregados/leídos

            if e.status in ("sent", "delivered", "read"):

                r.costo_carrier_usd += e.costo_estimado_usd



        # Calcular márgenes

        for r in agregado.values():

            r.costo_carrier_mxn = r.costo_carrier_usd * TIPO_CAMBIO_USD_MXN

            tarifa_cliente = TARIFAS_CLIENTE.get(r.canal)

            if tarifa_cliente:

                mensajes_facturables = r.total_enviados + r.total_entregados + r.total_leidos

                r.facturacion_estimada_mxn = mensajes_facturables * tarifa_cliente.precio_unitario_mxn



            r.margen_mxn = r.facturacion_estimada_mxn - r.costo_carrier_mxn

            if r.facturacion_estimada_mxn > 0:

                r.margen_pct = (r.margen_mxn / r.facturacion_estimada_mxn) * 100



            total_intentos = r.total_enviados + r.total_entregados + r.total_leidos + r.total_fallidos

            if total_intentos > 0:

                r.tasa_entrega_pct = (r.total_entregados + r.total_leidos) / total_intentos * 100



        self.resumenes = list(agregado.values())



    def _imprimir_resumen_ejecutivo(self):

        """Imprime el resumen ejecutivo en consola."""

        print("┌─────────────────────────────────────────────────────────────────────────┐")

        print("│                    RESUMEN EJECUTIVO DE MÁRGENES                        │")

        print("└─────────────────────────────────────────────────────────────────────────┘")

        print()



        # Totales globales

        total_costo_usd = sum(r.costo_carrier_usd for r in self.resumenes)

        total_fact_mxn = sum(r.facturacion_estimada_mxn for r in self.resumenes)

        total_margen_mxn = sum(r.margen_mxn for r in self.resumenes)

        total_envios = sum(

            r.total_enviados + r.total_entregados + r.total_leidos +

            r.total_fallidos + r.total_excluidos + r.total_diferidos

            for r in self.resumenes

        )



        print(f"  Período: {self.mes}")

        print(f"  Total envíos procesados: {total_envios:,}")

        print(f"  Costo total carriers: ${total_costo_usd:,.2f} USD (${total_costo_usd * TIPO_CAMBIO_USD_MXN:,.2f} MXN)")

        print(f"  Facturación estimada: ${total_fact_mxn:,.2f} MXN")

        print(f"  Margen bruto: ${total_margen_mxn:,.2f} MXN ({(total_margen_mxn/total_fact_mxn*100) if total_fact_mxn > 0 else 0:.1f}%)")

        print()



        # Desglose por tenant

        print("  ┌─────────────────┬──────────┬───────────┬───────────┬────────────┬────────┬─────────┐")

        print("  │ Tenant          │ Canal    │ Carrier   │ Envíos    │ Costo USD  │ Fact.  │ Margen  │")

        print("  │                 │          │           │ (fact.)   │            │ MXN    │ MXN (%) │")

        print("  ├─────────────────┼──────────┼───────────┼───────────┼────────────┼────────┼─────────┤")



        for r in sorted(self.resumenes, key=lambda x: (x.tenant_id, x.canal)):

            fact = r.total_enviados + r.total_entregados + r.total_leidos

            print(

                f"  │ {r.tenant_nombre[:15]:<15} │ {r.canal[:8]:<8} │ {r.carrier[:9]:<9} │ "

                f"{fact:>9,} │ ${r.costo_carrier_usd:>8.2f} │ ${r.facturacion_estimada_mxn:>8.2f} │ "

                f"${r.margen_mxn:>7.2f} ({r.margen_pct:>4.1f}%) │"

            )



        print("  └─────────────────┴──────────┴───────────┴───────────┴────────────┴────────┴─────────┘")

        print()



    def _imprimir_anomalias(self):

        """Imprime las anomalías detectadas."""

        if not self.anomalias:

            print("  ✅ Sin anomalías detectadas. Los costos están limpios.")

            return



        print("┌─────────────────────────────────────────────────────────────────────────┐")

        print("│                        ⚠️  ANOMALÍAS DETECTADAS                        │")

        print("└─────────────────────────────────────────────────────────────────────────┘")

        print()



        severidad_emoji = {"CRITICA": "🔴", "ALTA": "🟠", "MEDIA": "🟡", "BAJA": "🟢"}



        for a in sorted(self.anomalias, key=lambda x: {"CRITICA": 0, "ALTA": 1, "MEDIA": 2, "BAJA": 3}.get(x.severidad, 4)):

            emoji = severidad_emoji.get(a.severidad, "⚪")

            print(f"  {emoji} [{a.severidad}] {a.tipo}")

            print(f"     Tenant: {a.tenant_id} | Carrier: {a.carrier}")

            print(f"     {a.descripcion}")

            print(f"     Cantidad: {a.cantidad_afectada:,} | Impacto est.: ${a.monto_estimado_usd:.4f} USD")

            if a.mensajes_ejemplo:

                print("     Ejemplos:")

                for ej in a.mensajes_ejemplo[:3]:

                    print(f"       {ej}")

            print()





# ═══════════════════════════════════════════════════════════════════════════════

# §5. GENERADORES DE REPORTE

# ═══════════════════════════════════════════════════════════════════════════════



class ReportGenerator:

    """Genera reportes en múltiples formatos."""



    def __init__(self, watchdog: CostWatchdog, output_dir: str = "./reports"):

        self.watchdog = watchdog

        self.output_dir = Path(output_dir)

        self.output_dir.mkdir(parents=True, exist_ok=True)



    def csv(self, filename: Optional[str] = None) -> Path:

        """Genera reporte CSV."""

        if not filename:

            filename = f"carrier_cost_report_{self.watchdog.mes}.csv"

        filepath = self.output_dir / filename



        with open(filepath, "w", newline="", encoding="utf-8") as f:

            writer = csv.writer(f)

            # Header

            writer.writerow([

                "tenant_id", "tenant_nombre", "canal", "carrier",

                "enviados", "entregados", "leidos", "fallidos",

                "excluidos", "diferidos",

                "costo_carrier_usd", "costo_carrier_mxn",

                "facturacion_estimada_mxn", "margen_mxn", "margen_pct",

                "tasa_entrega_pct",

            ])

            for r in self.watchdog.resumenes:

                writer.writerow([

                    r.tenant_id, r.tenant_nombre, r.canal, r.carrier,

                    r.total_enviados, r.total_entregados, r.total_leidos,

                    r.total_fallidos, r.total_excluidos, r.total_diferidos,

                    f"{r.costo_carrier_usd:.4f}", f"{r.costo_carrier_mxn:.2f}",

                    f"{r.facturacion_estimada_mxn:.2f}", f"{r.margen_mxn:.2f}",

                    f"{r.margen_pct:.1f}", f"{r.tasa_entrega_pct:.1f}",

                ])



        print(f"  📄 Reporte CSV generado: {filepath}")

        return filepath



    def excel(self, filename: Optional[str] = None) -> Path:

        """Genera reporte Excel con formato."""

        if not HAS_OPENPYXL:

            print("  ⚠️  openpyxl no instalado. Usa: pip install openpyxl")

            return self.csv()



        if not filename:

            filename = f"carrier_cost_report_{self.watchdog.mes}.xlsx"

        filepath = self.output_dir / filename



        wb = Workbook()



        # ── Hoja 1: Resumen por Tenant ──

        ws = wb.active

        ws.title = "Resumen"



        # Estilos

        header_font = Font(bold=True, color="FFFFFF", size=11)

        header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")

        money_fmt = '#,##0.00'

        pct_fmt = '0.0%'



        # Título

        ws.merge_cells("A1:P1")

        ws["A1"] = f"ARKANGEL — Reporte de Costos y Márgenes | {self.watchdog.mes}"

        ws["A1"].font = Font(bold=True, size=14)

        ws["A2"] = f"Generado: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | TC: {TIPO_CAMBIO_USD_MXN}"

        ws["A2"].font = Font(italic=True, size=9)



        # Headers

        headers = [

            "Tenant", "Nombre", "Canal", "Carrier",

            "Enviados", "Entregados", "Leídos", "Fallidos",

            "Excluidos", "Diferidos",

            "Costo USD", "Costo MXN", "Facturación MXN",

            "Margen MXN", "Margen %", "Tasa Entrega %"

        ]

        for col, h in enumerate(headers, 1):

            cell = ws.cell(row=4, column=col, value=h)

            cell.font = header_font

            cell.fill = header_fill

            cell.alignment = Alignment(horizontal="center", wrap_text=True)



        # Data

        for row_idx, r in enumerate(self.watchdog.resumenes, 5):

            data = [

                r.tenant_id, r.tenant_nombre, r.canal, r.carrier,

                r.total_enviados, r.total_entregados, r.total_leidos,

                r.total_fallidos, r.total_excluidos, r.total_diferidos,

                r.costo_carrier_usd, r.costo_carrier_mxn,

                r.facturacion_estimada_mxn, r.margen_mxn,

                r.margen_pct / 100, r.tasa_entrega_pct / 100,

            ]

            for col, val in enumerate(data, 1):

                cell = ws.cell(row=row_idx, column=col, value=val)

                if col >= 11 and col <= 14:

                    cell.number_format = money_fmt

                elif col >= 15:

                    cell.number_format = pct_fmt



        # Anchos de columna

        for col in range(1, 17):

            ws.column_dimensions[get_column_letter(col)].width = 14



        # ── Hoja 2: Anomalías ──

        if self.watchdog.anomalias:

            ws2 = wb.create_sheet("Anomalías")

            headers2 = ["Severidad", "Tipo", "Tenant", "Carrier", "Descripción", "Cantidad", "Impacto USD"]

            for col, h in enumerate(headers2, 1):

                cell = ws2.cell(row=1, column=col, value=h)

                cell.font = header_font

                cell.fill = PatternFill(start_color="C00000", end_color="C00000", fill_type="solid")



            for row_idx, a in enumerate(self.watchdog.anomalias, 2):

                ws2.cell(row=row_idx, column=1, value=a.severidad)

                ws2.cell(row=row_idx, column=2, value=a.tipo)

                ws2.cell(row=row_idx, column=3, value=a.tenant_id)

                ws2.cell(row=row_idx, column=4, value=a.carrier)

                ws2.cell(row=row_idx, column=5, value=a.descripcion)

                ws2.cell(row=row_idx, column=6, value=a.cantidad_afectada)

                ws2.cell(row=row_idx, column=7, value=a.monto_estimado_usd)



        wb.save(filepath)

        print(f"  📊 Reporte Excel generado: {filepath}")

        return filepath



    def pdf(self, filename: Optional[str] = None) -> Path:

        """Genera reporte PDF."""

        if not HAS_REPORTLAB:

            print("  ⚠️  reportlab no instalado. Usa: pip install reportlab")

            return self.csv()



        if not filename:

            filename = f"carrier_cost_report_{self.watchdog.mes}.pdf"

        filepath = self.output_dir / filename



        doc = SimpleDocTemplate(str(filepath), pagesize=landscape(letter))

        elements = []

        styles = getSampleStyleSheet()



        # Título

        title_style = ParagraphStyle("Title", parent=styles["Title"], fontSize=18)

        elements.append(Paragraph(

            f"ARKANGEL — Auditoría de Costos y Márgenes | {self.watchdog.mes}",

            title_style

        ))

        elements.append(Spacer(1, 0.2 * inch))



        # Tabla resumen

        table_data = [[

            "Tenant", "Canal", "Carrier", "Envíos", "Costo USD",

            "Fact. MXN", "Margen MXN", "Margen %"

        ]]

        for r in self.watchdog.resumenes:

            fact = r.total_enviados + r.total_entregados + r.total_leidos

            table_data.append([

                r.tenant_nombre[:12], r.canal, r.carrier,

                f"{fact:,}", f"${r.costo_carrier_usd:,.2f}",

                f"${r.facturacion_estimada_mxn:,.2f}",

                f"${r.margen_mxn:,.2f}", f"{r.margen_pct:.1f}%"

            ])



        table = Table(table_data)

        table.setStyle(TableStyle([

            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E79")),

            ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),

            ("ALIGN", (0, 0), (-1, -1), "CENTER"),

            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),

            ("FONTSIZE", (0, 0), (-1, 0), 9),

            ("BOTTOMPADDING", (0, 0), (-1, 0), 8),

            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F2F2F2")),

            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),

            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#E8E8E8")]),

        ]))

        elements.append(table)

        elements.append(Spacer(1, 0.3 * inch))



        # Anomalías

        if self.watchdog.anomalias:

            elements.append(PageBreak())

            elements.append(Paragraph("Anomalías Detectadas", styles["Heading2"]))

            elements.append(Spacer(1, 0.1 * inch))



            for a in self.watchdog.anomalias:

                sev_color = {"CRITICA": colors.red, "ALTA": colors.orange}.get(a.severidad, colors.black)

                elements.append(Paragraph(

                    f"<b>[{a.severidad}] {a.tipo}</b> — {a.tenant_id} / {a.carrier}",

                    ParagraphStyle("anom", parent=styles["Normal"], textColor=sev_color, fontSize=10)

                ))

                elements.append(Paragraph(f"  {a.descripcion}", styles["Normal"]))

                elements.append(Spacer(1, 0.1 * inch))



        doc.build(elements)

        print(f"  📑 Reporte PDF generado: {filepath}")

        return filepath





# ═══════════════════════════════════════════════════════════════════════════════

# §6. CLI

# ═══════════════════════════════════════════════════════════════════════════════



def build_parser() -> argparse.ArgumentParser:

    parser = argparse.ArgumentParser(

        description="Carrier Cost Watchdog — Auditor de costos y márgenes por tenant",

        formatter_class=argparse.RawDescriptionHelpFormatter,

        epilog="""

Ejemplos:

  python carrier_cost_watchdog.py --mode local --month 2026-10

  python carrier_cost_watchdog.py --mode local --month 2026-10 --tenant canaco_merida --output xlsx

  python carrier_cost_watchdog.py --mode remote --month 2026-10 --account-id xxx --db-id yyy --token zzz

  python carrier_cost_watchdog.py --mode csv --input dump.csv --month 2026-10

        """

    )

    parser.add_argument("--mode", choices=["local", "remote", "csv"], default="local",

                        help="Fuente de datos: local (D1 sqlite), remote (CF API), csv (archivo)")

    parser.add_argument("--month", default=datetime.now().strftime("%Y-%m"),

                        help="Período a auditar en formato YYYY-MM (default: mes actual)")

    parser.add_argument("--tenant", help="Filtrar por tenant específico")

    parser.add_argument("--output", choices=["console", "csv", "xlsx", "pdf", "all"],

                        default="console", help="Formato de salida del reporte")

    parser.add_argument("--output-dir", default="./reports", help="Directorio de salida")

    parser.add_argument("--db-path", help="Ruta explícita al archivo .sqlite de D1")

    parser.add_argument("--input", help="Ruta al CSV de entrada (modo csv)")

    parser.add_argument("--account-id", help="Cloudflare Account ID (modo remote)")

    parser.add_argument("--db-id", help="Cloudflare D1 Database ID (modo remote)")

    parser.add_argument("--token", help="Cloudflare API Token (modo remote)")

    parser.add_argument("--tc", type=float, default=TIPO_CAMBIO_USD_MXN,

                        help=f"Tipo de cambio USD/MXN (default: {TIPO_CAMBIO_USD_MXN})")

    return parser





def main():

    args = build_parser().parse_args()



    # Override tipo de cambio si se especifica

    global TIPO_CAMBIO_USD_MXN

    TIPO_CAMBIO_USD_MXN = args.tc



    # Seleccionar fuente de datos

    try:

        if args.mode == "local":

            source = D1LocalSource(args.db_path)

        elif args.mode == "remote":

            if not all([args.account_id, args.db_id, args.token]):

                print("Error: modo remote requiere --account-id, --db-id y --token")

                sys.exit(1)

            source = D1RemoteSource(args.account_id, args.db_id, args.token)

        elif args.mode == "csv":

            if not args.input:

                print("Error: modo csv requiere --input")

                sys.exit(1)

            source = CSVSource(args.input)

        else:

            print(f"Modo desconocido: {args.mode}")

            sys.exit(1)

    except FileNotFoundError as e:

        print(f"❌ Error: {e}")

        sys.exit(1)



    # Ejecutar auditoría

    watchdog = CostWatchdog(source, args.month, args.tenant)

    watchdog.ejecutar()



    # Generar reportes

    if args.output != "console":

        reporter = ReportGenerator(watchdog, args.output_dir)

        if args.output == "csv":

            reporter.csv()

        elif args.output == "xlsx":

            reporter.excel()

        elif args.output == "pdf":

            reporter.pdf()

        elif args.output == "all":

            reporter.csv()

            reporter.excel()

            reporter.pdf()





if __name__ == "__main__":

    main()
