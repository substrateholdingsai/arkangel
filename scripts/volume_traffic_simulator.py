#!/usr/bin/env python3
"""
volume_traffic_simulator.py — Simulador de Carga y Tráfico Omnicanal
=====================================================================
Arkangel · Plataforma de Cobranza Agéntica
Plano Operativo: Prueba de estrés del Motor de Comunicación antes de eventos masivos.

Problema resuelto:
  No esperar a una venta masiva real (Hot Sale, quincena, campaña) para descubrir
  si el rate-limiting de Telnyx/Meta o las colas de Cloudflare se saturan.

Qué hace:
  - Genera ráfagas controladas de eventos concurrentes simulando tráfico real
    de Temozonía (carritos abandonados), Baak'al (servicios urgentes),
    CANACO Mérida (campañas institucionales) y Ark Oficios (compras).
  - Prueba en modo dry_run (simulación local) o live contra el endpoint
    POST /api/v1/comunicacion/campaigns.
  - Mide: latencia p50/p95/p99, throughput, tasa de éxito, comportamiento
    de Durable Objects (RateLimiterDO, FrequencyCapDO, TrunkGovernorDO),
    y proyecta costos de telecomunicaciones en MXN.

Escenarios predefinidos:
  hot_sale    — Ráfaga de 500 mensajes en 60s (WhatsApp + SMS)
  quincena    — Goteo sostenido de 200 mensajes en 5 min
  campana     — Campaña masiva de 1000 mensajes con pacing de 10/s
  burst       — Explosión instantánea de 100 mensajes (prueba de cola)

Uso:
  python volume_traffic_simulator.py --scenario hot_sale --mode dry_run
  python volume_traffic_simulator.py --scenario quincena --mode live --tenant temozonia
  python volume_traffic_simulator.py --scenario burst --mode dry_run --concurrency 50
  python volume_traffic_simulator.py --scenario custom --total 300 --rps 5 --mode dry_run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import statistics
import sys
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

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

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

try:
    from rich.console import Console
    from rich.table import Table
    from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn
    from rich.panel import Panel
    from rich.text import Text
    HAS_RICH = True
except ImportError:
    HAS_RICH = False


# ═══════════════════════════════════════════════════════════════════════════════
# §1. CONFIGURACIÓN Y CONSTANTES
# ═══════════════════════════════════════════════════════════════════════════════

# Endpoint del Motor de Comunicación
BASE_URL_LOCAL = "http://localhost:8787"
BASE_URL_PROD = "https://arkangel.arksystems.site"
ENDPOINT_PREVIEW = "/api/v1/comunicacion/preview"
ENDPOINT_CAMPAIGNS = "/api/v1/comunicacion/campaigns"

# Límites conocidos del sistema (según mapa del proyecto)
TELNYX_DPS_LIMIT = 30          # TrunkGovernorDO: 30 Dials Per Second
TELNYX_CONCURRENCY_L1 = 2      # Level 1: 2 canales concurrentes
TELNYX_CONCURRENCY_L2 = 10     # Level 2: 10 canales concurrentes
QUIET_HOURS_START = 21         # 21:00 CDMX
QUIET_HOURS_END = 8            # 08:00 CDMX
REPEP_VIGENCY_DAYS = 35        # Vigencia fail-closed de REPEP
FREQ_CAP_WINDOW_DAYS = 7       # Ventana deslizante FrequencyCapDO

# Tarifas para proyección de costos (MXN por mensaje)
COSTOS_MXN = {
    "whatsapp": 0.18,
    "sms": 0.12,
    "email": 0.05,
    "voice": 1.50,  # por minuto
}

# Tenants y sus perfiles de tráfico
TENANT_PROFILES = {
    "temozonia": {
        "nombre": "Temozonía",
        "perfil": "carritos_abandonados",
        "canales": ["whatsapp", "sms"],
        "mensajes_por_evento": (1, 3),
        "urgencia": "media",
    },
    "baakal": {
        "nombre": "Baak'al",
        "perfil": "servicios_urgentes",
        "canales": ["whatsapp", "sms", "email"],
        "mensajes_por_evento": (2, 5),
        "urgencia": "alta",
    },
    "canaco_merida": {
        "nombre": "CANACO Mérida",
        "perfil": "campana_institucional",
        "canales": ["whatsapp", "email"],
        "mensajes_por_evento": (1, 2),
        "urgencia": "baja",
    },
    "ark": {
        "nombre": "Ark Oficios",
        "perfil": "compras_oficios",
        "canales": ["whatsapp", "sms", "email"],
        "mensajes_por_evento": (1, 4),
        "urgencia": "media",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# §2. MODELOS DE DATOS
# ═══════════════════════════════════════════════════════════════════════════════

class Canal(str, Enum):
    WHATSAPP = "whatsapp"
    SMS = "sms"
    EMAIL = "email"
    VOICE = "voice"


class ScenarioType(str, Enum):
    HOT_SALE = "hot_sale"
    QUINCENA = "quincena"
    CAMPANA = "campana"
    BURST = "burst"
    CUSTOM = "custom"


@dataclass
class ScenarioConfig:
    """Configuración de un escenario de carga."""
    nombre: str
    total_mensajes: int
    duracion_segundos: float
    rps_objetivo: float  # Requests per second objetivo
    concurrencia_max: int
    canales: list[Canal]
    tenants: list[str]
    distribucion: str  # uniforme | poisson | burst
    descripcion: str


@dataclass
class RequestResult:
    """Resultado de una solicitud individual."""
    request_id: str
    tenant_id: str
    canal: str
    timestamp: float
    latencia_ms: float
    status_code: int
    success: bool
    error: Optional[str] = None
    rate_limited: bool = False
    queued: bool = False
    response_body: Optional[dict] = None


@dataclass
class SimulationMetrics:
    """Métricas agregadas de la simulación."""
    total_requests: int = 0
    total_success: int = 0
    total_failed: int = 0
    total_rate_limited: int = 0
    total_queued: int = 0
    latencies_ms: list = field(default_factory=list)
    latencies_by_canal: dict = field(default_factory=lambda: defaultdict(list))
    latencies_by_tenant: dict = field(default_factory=lambda: defaultdict(list))
    errors_by_type: dict = field(default_factory=lambda: defaultdict(int))
    start_time: float = 0.0
    end_time: float = 0.0
    costo_proyectado_mxn: float = 0.0

    @property
    def duration_seconds(self) -> float:
        return self.end_time - self.start_time

    @property
    def throughput_rps(self) -> float:
        if self.duration_seconds == 0:
            return 0
        return self.total_requests / self.duration_seconds

    @property
    def success_rate_pct(self) -> float:
        if self.total_requests == 0:
            return 0
        return (self.total_success / self.total_requests) * 100

    @property
    def p50_ms(self) -> float:
        return self._percentile(50)

    @property
    def p95_ms(self) -> float:
        return self._percentile(95)

    @property
    def p99_ms(self) -> float:
        return self._percentile(99)

    @property
    def avg_ms(self) -> float:
        if not self.latencies_ms:
            return 0
        return statistics.mean(self.latencies_ms)

    @property
    def max_ms(self) -> float:
        if not self.latencies_ms:
            return 0
        return max(self.latencies_ms)

    @property
    def min_ms(self) -> float:
        if not self.latencies_ms:
            return 0
        return min(self.latencies_ms)

    def _percentile(self, p: int) -> float:
        if not self.latencies_ms:
            return 0
        sorted_lat = sorted(self.latencies_ms)
        idx = int(len(sorted_lat) * p / 100)
        idx = min(idx, len(sorted_lat) - 1)
        return sorted_lat[idx]


# ═══════════════════════════════════════════════════════════════════════════════
# §3. ESCENARIOS PREDEFINIDOS
# ═══════════════════════════════════════════════════════════════════════════════

SCENARIOS: dict[str, ScenarioConfig] = {
    "hot_sale": ScenarioConfig(
        nombre="🔥 Hot Sale — Ráfaga Omnicanal",
        total_mensajes=500,
        duracion_segundos=60,
        rps_objetivo=8.3,  # 500/60
        concurrencia_max=50,
        canales=[Canal.WHATSAPP, Canal.SMS],
        tenants=["temozonia", "baakal", "ark"],
        distribucion="poisson",
        descripcion="Simula picos de carritos abandonados y notificaciones de compra durante Hot Sale.",
    ),
    "quincena": ScenarioConfig(
        nombre="💰 Quincena — Goteo Sostenido",
        total_mensajes=200,
        duracion_segundos=300,  # 5 minutos
        rps_objetivo=0.67,
        concurrencia_max=20,
        canales=[Canal.WHATSAPP, Canal.SMS, Canal.EMAIL],
        tenants=["temozonia", "canaco_merida", "ark"],
        distribucion="uniforme",
        descripcion="Goteo constante de recordatorios de pago y promociones quincenales.",
    ),
    "campana": ScenarioConfig(
        nombre="📢 Campaña Masiva — Pacing Controlado",
        total_mensajes=1000,
        duracion_segundos=120,
        rps_objetivo=8.3,
        concurrencia_max=100,
        canales=[Canal.WHATSAPP, Canal.EMAIL],
        tenants=["canaco_merida", "temozonia", "baakal", "ark"],
        distribucion="uniforme",
        descripcion="Campaña institucional masiva con pacing de CampaignRunnerDO.",
    ),
    "burst": ScenarioConfig(
        nombre="💥 Burst Instantáneo — Prueba de Cola",
        total_mensajes=100,
        duracion_segundos=2,  # Todo en 2 segundos
        rps_objetivo=50,
        concurrencia_max=100,
        canales=[Canal.WHATSAPP],
        tenants=["baakal"],
        distribucion="burst",
        descripcion="Explosión instantánea para probar encolamiento en Cloudflare Queues y backpressure.",
    ),
}


# ═══════════════════════════════════════════════════════════════════════════════
# §4. GENERADOR DE PAYLOADS
# ═══════════════════════════════════════════════════════════════════════════════

class PayloadGenerator:
    """Genera payloads CAMPAIGN_DISPATCH_V1 simulados."""

    NOMBRES_MEXICANOS = [
        "Juan", "María", "José", "Guadalupe", "Carlos", "Ana", "Miguel",
        "Laura", "Pedro", "Sofía", "Diego", "Valentina", "Andrés", "Camila",
        "Roberto", "Fernanda", "Alejandro", "Regina", "Jorge", "Daniela",
    ]
    APELLIDOS = [
        "García", "López", "Martínez", "Hernández", "González", "Rodríguez",
        "Pérez", "Sánchez", "Ramírez", "Torres", "Flores", "Rivera",
        "Gómez", "Díaz", "Cruz", "Morales", "Reyes", "Gutiérrez",
    ]

    PLANTILLAS = {
        "whatsapp": {
            "carrito_abandonado": "hsm_carrito_v2",
            "servicio_urgente": "hsm_urgente_v1",
            "campana_institucional": "hsm_institucional_v3",
            "compra_oficio": "hsm_compra_v1",
        },
        "sms": {
            "carrito_abandonado": "sms_carrito_v1",
            "servicio_urgente": "sms_urgente_v1",
            "compra_oficio": "sms_compra_v1",
        },
        "email": {
            "carrito_abandonado": "email_carrito_v2",
            "campana_institucional": "email_institucional_v1",
            "compra_oficio": "email_compra_v1",
        },
    }

    def __init__(self, seed: Optional[int] = None):
        self.rng = random.Random(seed)

    def generar_telefono_mx(self) -> str:
        """Genera un número E.164 mexicano válido (+52)."""
        area_codes = ["55", "56", "81", "33", "999", "222", "442", "477"]
        area = self.rng.choice(area_codes)
        digits = 8 if len(area) == 2 else 7
        number = "".join([str(self.rng.randint(0, 9)) for _ in range(digits)])
        return f"+52{area}{number}"

    def generar_email(self) -> str:
        """Genera un email simulado."""
        nombre = self.rng.choice(self.NOMBRES_MEXICANOS).lower()
        apellido = self.rng.choice(self.APELLIDOS).lower()
        dominio = self.rng.choice(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com.mx"])
        num = self.rng.randint(1, 999)
        return f"{nombre}.{apellido}{num}@{dominio}"

    def generar_payload_campaign(
        self,
        tenant_id: str,
        canal: Canal,
        campaign_id: Optional[str] = None,
    ) -> dict:
        """
        Genera un payload conforme al contrato CAMPAIGN_DISPATCH_V1.
        Ref: src/comunicacion/contrato.ts
        """
        profile = TENANT_PROFILES.get(tenant_id, TENANT_PROFILES["ark"])
        brand_id = f"brand_{tenant_id}_{self.rng.randint(1, 5)}"
        contact_count = self.rng.randint(*profile["mensajes_por_evento"])

        contacts = []
        for _ in range(contact_count):
            contact = {
                "phone": self.generar_telefono_mx(),
                "nombre": self.rng.choice(self.NOMBRES_MEXICANOS),
                "apellido": self.rng.choice(self.APELLIDOS),
            }
            if canal == Canal.EMAIL:
                contact["email"] = self.generar_email()
            contacts.append(contact)

        plantillas_canal = self.PLANTILLAS.get(canal.value, {})
        plantilla = self.rng.choice(list(plantillas_canal.values())) if plantillas_canal else "default_v1"

        payload = {
            "campaign_id": campaign_id or str(uuid.uuid4()),
            "tenant_id": tenant_id,
            "brand_id": brand_id,
            "brand_name": profile["nombre"],
            "canal": canal.value,
            "template_key": plantilla,
            "categoria": self._categoria_por_perfil(profile["perfil"]),
            "proposito": "marketing",
            "contacts": contacts,
            "variables": self._generar_variables(profile["perfil"], tenant_id),
            "dry_run": False,
            "metadata": {
                "simulator": True,
                "simulated_at": datetime.now(timezone.utc).isoformat(),
                "scenario_profile": profile["perfil"],
            },
        }
        return payload

    def _categoria_por_perfil(self, perfil: str) -> str:
        mapping = {
            "carritos_abandonados": "recuperacion",
            "servicios_urgentes": "transaccional",
            "campana_institucional": "institucional",
            "compras_oficios": "transaccional",
        }
        return mapping.get(perfil, "informativo")

    def _generar_variables(self, perfil: str, tenant_id: str) -> dict:
        """Genera variables de interpolación para la plantilla."""
        base = {
            "nombre": "{{nombre}}",
            "marca": TENANT_PROFILES.get(tenant_id, {}).get("nombre", "Arkangel"),
        }
        if perfil == "carritos_abandonados":
            base.update({
                "producto": self.rng.choice([
                    "Collar de Obsidiana", "Pulsera de Jade", "Anillo de Plata 925",
                    "Aretes de Turquesa", "Colgante de Cuarzo",
                ]),
                "monto_carrito": f"${self.rng.randint(200, 5000)}.00 MXN",
                "horas_restantes": str(self.rng.randint(2, 24)),
            })
        elif perfil == "servicios_urgentes":
            base.update({
                "servicio": self.rng.choice([
                    "Limpieza profunda", "Fumigación", "Mantenimiento eléctrico",
                    "Plomería de emergencia", "Pintura interior",
                ]),
                "urgencia": self.rng.choice(["2 horas", "4 horas", "mismo día"]),
            })
        elif perfil == "compras_oficios":
            base.update({
                "oficio": self.rng.choice([
                    "Carpintería", "Albañilería", "Jardinería", "Herrería", "Electricidad",
                ]),
                "estado": self.rng.choice(["confirmado", "en_proceso", "completado"]),
            })
        return base


# ═══════════════════════════════════════════════════════════════════════════════
# §5. MOTOR DE SIMULACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

class DryRunResponder:
    """Simula respuestas del endpoint sin tocar producción."""

    def __init__(self, simulate_latency: bool = True):
        self.simulate_latency = simulate_latency
        self.request_count = 0

    async def respond(self, payload: dict) -> tuple[int, dict, float]:
        """
        Simula la respuesta del Motor de Comunicación con latencia realista.
        Modela el comportamiento esperado de:
        - RateLimiterDO: rechazo si excede tasa por tenant
        - FrequencyCapDO: exclusión si excede cap semanal
        - CampaignRunnerDO: encolamiento si hay carga
        - TrunkGovernorDO: 429 si excede 30 DPS (solo voice)
        """
        self.request_count += 1
        latencia_base = random.gauss(45, 15)  # ~45ms base (edge V8 Isolate)
        latencia = max(5, latencia_base)

        # Simular quiet hours (21:00-08:00 CDMX)
        hora_cdmx = (datetime.now(timezone.utc).hour - 6) % 24  # UTC-6
        if QUIET_HOURS_START <= hora_cdmx or hora_cdmx < QUIET_HOURS_END:
            if self.simulate_latency:
                await asyncio.sleep(latencia / 1000)
            return 200, {
                "status": "excluded",
                "motivo": "quiet_hours",
                "detalle": f"Ventana NOM-184: {QUIET_HOURS_START}:00-{QUIET_HOURS_END:00} CDMX",
                "costo_mxn": 0,
            }, latencia

        # Simular rate limiting por tenant (RateLimiterDO)
        if self.request_count > 50 and random.random() < 0.05:
            if self.simulate_latency:
                await asyncio.sleep(latencia / 1000)
            return 429, {
                "error": "rate_limited",
                "retry_after_ms": random.randint(500, 3000),
                "motivo": "RateLimiterDO: tasa excedida para tenant",
            }, latencia

        # Simular frequency cap (FrequencyCapDO)
        if random.random() < 0.03:
            if self.simulate_latency:
                await asyncio.sleep(latencia / 1000)
            return 200, {
                "status": "excluded",
                "motivo": "frequency_cap",
                "detalle": f"Contacto ya alcanzó cap semanal ({FREQ_CAP_WINDOW_DAYS} días)",
                "costo_mxn": 0,
            }, latencia

        # Simular REPEP (lista de exclusión PROFECO)
        if random.random() < 0.02:
            if self.simulate_latency:
                await asyncio.sleep(latencia / 1000)
            return 200, {
                "status": "excluded",
                "motivo": "repep_match",
                "detalle": "Número inscrito en REPEP PROFECO (SHA-256 match)",
                "costo_mxn": 0,
            }, latencia

        # Simular falta de opt-in
        if random.random() < 0.04:
            if self.simulate_latency:
                await asyncio.sleep(latencia / 1000)
            return 200, {
                "status": "excluded",
                "motivo": "no_optin",
                "detalle": "Sin consentimiento expreso registrado en comm_consents",
                "costo_mxn": 0,
            }, latencia

        # Simular encolamiento (Cloudflare Queues)
        queued = random.random() < 0.1
        if queued:
            latencia += random.gauss(200, 50)

        if self.simulate_latency:
            await asyncio.sleep(latencia / 1000)

        canal = payload.get("canal", "whatsapp")
        costo = COSTOS_MXN.get(canal, 0.10)
        num_contacts = len(payload.get("contacts", [{}]))

        return 200, {
            "status": "queued" if queued else "sent",
            "campaign_id": payload.get("campaign_id"),
            "mensajes_aceptados": num_contacts,
            "mensajes_excluidos": 0,
            "mensajes_diferidos": 0,
            "costo_estimado_mxn": round(costo * num_contacts, 2),
            "canal": canal,
        }, latencia


class TrafficSimulator:
    """Motor principal de simulación de tráfico."""

    def __init__(
        self,
        scenario: ScenarioConfig,
        mode: str = "dry_run",
        base_url: str = BASE_URL_LOCAL,
        auth_token: Optional[str] = None,
        tenant_filter: Optional[str] = None,
        seed: Optional[int] = None,
    ):
        self.scenario = scenario
        self.mode = mode
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.tenant_filter = tenant_filter
        self.generator = PayloadGenerator(seed)
        self.metrics = SimulationMetrics()
        self.dry_responder = DryRunResponder(simulate_latency=(mode == "dry_run"))
        self._progress_callback = None

    async def ejecutar(self) -> SimulationMetrics:
        """Ejecuta la simulación completa."""
        self.metrics.start_time = time.time()

        payloads = self._generar_payloads()
        total = len(payloads)
        intervals = self._calcular_intervals(total)

        semaphore = asyncio.Semaphore(self.scenario.concurrencia_max)
        tasks = []

        for i, (payload, delay) in enumerate(zip(payloads, intervals)):
            if delay > 0:
                await asyncio.sleep(delay)
            task = asyncio.create_task(
                self._enviar_con_semaphore(semaphore, payload, i)
            )
            tasks.append(task)

            if self._progress_callback:
                self._progress_callback(i + 1, total)

        await asyncio.gather(*tasks, return_exceptions=True)

        self.metrics.end_time = time.time()
        self._calcular_costos()
        return self.metrics

    def _generar_payloads(self) -> list[dict]:
        """Genera todos los payloads para la simulación."""
        payloads = []
        tenants = self.scenario.tenants
        if self.tenant_filter:
            tenants = [self.tenant_filter] if self.tenant_filter in tenants else tenants

        for i in range(self.scenario.total_mensajes):
            tenant = self.generator.rng.choice(tenants)
            canal = self.generator.rng.choice(self.scenario.canales)
            payload = self.generator.generar_payload_campaign(tenant, canal)
            payload["dry_run"] = (self.mode == "dry_run")
            payload["metadata"]["sim_index"] = i
            payloads.append(payload)

        return payloads

    def _calcular_intervals(self, total: int) -> list[float]:
        """Calcula intervalos entre requests según la distribución."""
        if self.scenario.distribucion == "burst":
            return [0.0] * total

        elif self.scenario.distribucion == "poisson":
            rate = self.scenario.rps_objetivo
            intervals = []
            for _ in range(total):
                interval = random.expovariate(rate)
                intervals.append(interval)
            return intervals

        else:
            interval = 1.0 / self.scenario.rps_objetivo if self.scenario.rps_objetivo > 0 else 0
            return [interval] * total

    async def _enviar_con_semaphore(
        self,
        semaphore: asyncio.Semaphore,
        payload: dict,
        index: int,
    ):
        """Envía un request controlado por semaphore de concurrencia."""
        async with semaphore:
            await self._enviar_request(payload, index)

    async def _enviar_request(self, payload: dict, index: int):
        """Envía un request individual y registra métricas."""
        request_id = str(uuid.uuid4())[:8]
        tenant_id = payload["tenant_id"]
        canal = payload["canal"]
        start_time = time.time()

        try:
            if self.mode == "dry_run":
                status_code, body, latency = await self.dry_responder.respond(payload)
            else:
                status_code, body, latency = await self._enviar_http(payload)

            elapsed_ms = (time.time() - start_time) * 1000

            result = RequestResult(
                request_id=request_id,
                tenant_id=tenant_id,
                canal=canal,
                timestamp=start_time,
                latencia_ms=elapsed_ms,
                status_code=status_code,
                success=(200 <= status_code < 300),
                rate_limited=(status_code == 429),
                queued=(body.get("status") == "queued" if isinstance(body, dict) else False),
                response_body=body if isinstance(body, dict) else None,
            )

        except Exception as e:
            elapsed_ms = (time.time() - start_time) * 1000
            result = RequestResult(
                request_id=request_id,
                tenant_id=tenant_id,
                canal=canal,
                timestamp=start_time,
                latencia_ms=elapsed_ms,
                status_code=0,
                success=False,
                error=str(e),
            )

        self._registrar_resultado(result)

    async def _enviar_http(self, payload: dict) -> tuple[int, dict, float]:
        """Envía request HTTP real al endpoint."""
        if not HAS_AIOHTTP:
            raise RuntimeError("Se requiere aiohttp para modo live: pip install aiohttp")

        url = f"{self.base_url}{ENDPOINT_CAMPAIGNS}"
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        start = time.time()
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                body = await resp.json()
                latency = (time.time() - start) * 1000
                return resp.status, body, latency

    def _registrar_resultado(self, result: RequestResult):
        """Registra un resultado en las métricas agregadas."""
        self.metrics.total_requests += 1
        self.metrics.latencies_ms.append(result.latencia_ms)
        self.metrics.latencies_by_canal[result.canal].append(result.latencia_ms)
        self.metrics.latencies_by_tenant[result.tenant_id].append(result.latencia_ms)

        if result.success:
            self.metrics.total_success += 1
        else:
            self.metrics.total_failed += 1

        if result.rate_limited:
            self.metrics.total_rate_limited += 1

        if result.queued:
            self.metrics.total_queued += 1

        if result.error:
            error_type = type(result.error).__name__ if result.error else "unknown"
            self.metrics.errors_by_type[error_type] += 1

    def _calcular_costos(self):
        """Proyecta costos de telecomunicaciones en MXN."""
        total_mensajes_enviados = 0
        for result_canal, latencies in self.metrics.latencies_by_canal.items():
            count = len(latencies)
            total_mensajes_enviados += count

        mensajes_facturables = int(total_mensajes_enviados * (self.metrics.success_rate_pct / 100))
        costo_promedio = sum(COSTOS_MXN.values()) / len(COSTOS_MXN)
        self.metrics.costo_proyectado_mxn = mensajes_facturables * costo_promedio


# ═══════════════════════════════════════════════════════════════════════════════
# §6. REPORTERO Y VISUALIZACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

class SimulationReporter:
    """Genera reportes visuales de la simulación."""

    def __init__(self, scenario: ScenarioConfig, metrics: SimulationMetrics, mode: str):
        self.scenario = scenario
        self.metrics = metrics
        self.mode = mode
        self.console = Console() if HAS_RICH else None

    def imprimir_reporte(self):
        """Imprime el reporte completo."""
        if self.console:
            self._reporte_rich()
        else:
            self._reporte_plano()

    def _reporte_rich(self):
        """Reporte con formato Rich."""
        c = self.console
        m = self.metrics

        # Header
        c.print()
        c.print(Panel.fit(
            f"[bold cyan]{self.scenario.nombre}[/]\n"
            f"[dim]{self.scenario.descripcion}[/]",
            title="🚀 SIMULADOR DE TRÁFICO ARKANGEL",
            border_style="cyan",
        ))

        # Métricas principales
        table = Table(title="📊 Métricas de Rendimiento", show_header=True, header_style="bold magenta")
        table.add_column("Métrica", style="cyan", width=25)
        table.add_column("Valor", justify="right", style="green")
        table.add_column("Detalle", style="dim")

        table.add_row("Total Requests", f"{m.total_requests:,}", f"en {m.duration_seconds:.1f}s")
        table.add_row("Throughput", f"{m.throughput_rps:.2f} RPS", f"objetivo: {self.scenario.rps_objetivo:.2f} RPS")
        table.add_row("Tasa de Éxito", f"{m.success_rate_pct:.1f}%", f"{m.total_success:,} OK / {m.total_failed:,} FAIL")
        table.add_row("Rate Limited", f"{m.total_rate_limited:,}", "HTTP 429")
        table.add_row("Encolados", f"{m.total_queued:,}", "Cloudflare Queues")
        table.add_row("", "", "")
        table.add_row("Latencia P50", f"{m.p50_ms:.1f} ms", "mediana")
        table.add_row("Latencia P95", f"{m.p95_ms:.1f} ms", "percentil 95")
        table.add_row("Latencia P99", f"{m.p99_ms:.1f} ms", "percentil 99")
        table.add_row("Latencia Avg", f"{m.avg_ms:.1f} ms", "")
        table.add_row("Latencia Max", f"{m.max_ms:.1f} ms", "peor caso")
        table.add_row("Latencia Min", f"{m.min_ms:.1f} ms", "mejor caso")
        table.add_row("", "", "")
        table.add_row("Costo Proyectado", f"${m.costo_proyectado_mxn:,.2f} MXN", "solo mensajes exitosos")

        c.print(table)

        # Desglose por canal
        c.print()
        table_canal = Table(title="📡 Desglose por Canal", show_header=True, header_style="bold magenta")
        table_canal.add_column("Canal", style="cyan")
        table_canal.add_column("Requests", justify="right")
        table_canal.add_column("P50 (ms)", justify="right")
        table_canal.add_column("P95 (ms)", justify="right")
        table_canal.add_column("P99 (ms)", justify="right")
        table_canal.add_column("Costo MXN", justify="right")

        for canal, latencies in sorted(m.latencies_by_canal.items()):
            if latencies:
                sorted_lat = sorted(latencies)
                p50 = sorted_lat[len(sorted_lat) // 2]
                p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
                p99 = sorted_lat[min(int(len(sorted_lat) * 0.99), len(sorted_lat) - 1)]
                costo = len(latencies) * COSTOS_MXN.get(canal, 0.10)
                table_canal.add_row(
                    canal, str(len(latencies)),
                    f"{p50:.1f}", f"{p95:.1f}", f"{p99:.1f}",
                    f"${costo:,.2f}",
                )
        c.print(table_canal)

        # Desglose por tenant
        c.print()
        table_tenant = Table(title="🏢 Desglose por Tenant", show_header=True, header_style="bold magenta")
        table_tenant.add_column("Tenant", style="cyan")
        table_tenant.add_column("Requests", justify="right")
        table_tenant.add_column("P50 (ms)", justify="right")
        table_tenant.add_column("P95 (ms)", justify="right")

        for tenant, latencies in sorted(m.latencies_by_tenant.items()):
            if latencies:
                sorted_lat = sorted(latencies)
                p50 = sorted_lat[len(sorted_lat) // 2]
                p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
                nombre = TENANT_PROFILES.get(tenant, {}).get("nombre", tenant)
                table_tenant.add_row(nombre, str(len(latencies)), f"{p50:.1f}", f"{p95:.1f}")
        c.print(table_tenant)

        # Análisis de capacidad
        c.print()
        self._analisis_capacidad_rich()

    def _analisis_capacidad_rich(self):
        """Análisis de capacidad vs límites conocidos."""
        c = self.console
        m = self.metrics

        panel_text = []

        if m.throughput_rps > TELNYX_DPS_LIMIT:
            panel_text.append(f"[red]⚠️  Throughput ({m.throughput_rps:.1f} RPS) EXCEDE límite de TrunkGovernorDO ({TELNYX_DPS_LIMIT} DPS)[/]")
        else:
            panel_text.append(f"[green]✅ Throughput ({m.throughput_rps:.1f} RPS) dentro del límite de TrunkGovernorDO ({TELNYX_DPS_LIMIT} DPS)[/]")

        rate_limit_pct = (m.total_rate_limited / m.total_requests * 100) if m.total_requests > 0 else 0
        if rate_limit_pct > 10:
            panel_text.append(f"[red]🔴 Rate limiting alto: {rate_limit_pct:.1f}% de requests fueron 429[/]")
        elif rate_limit_pct > 5:
            panel_text.append(f"[yellow]🟡 Rate limiting moderado: {rate_limit_pct:.1f}% de requests fueron 429[/]")
        else:
            panel_text.append(f"[green]✅ Rate limiting bajo control: {rate_limit_pct:.1f}%[/]")

        if m.p95_ms > 800:
            panel_text.append(f"[yellow]⚠️  P95 ({m.p95_ms:.0f}ms) supera objetivo de 800ms de Voice AI[/]")
        else:
            panel_text.append(f"[green]✅ P95 ({m.p95_ms:.0f}ms) dentro del objetivo de <800ms[/]")

        hot_sale_factor = 10
        proyectorps = m.throughput_rps * hot_sale_factor
        panel_text.append(f"\n[dim]📈 Proyección Hot Sale (x{hot_sale_factor}): {proyectorps:.1f} RPS[/]")
        if proyectorps > TELNYX_DPS_LIMIT:
            panel_text.append(f"[yellow]   → Se necesitaría escalar TrunkGovernorDO o activar Level 2 ({TELNYX_CONCURRENCY_L2} canales)[/]")

        c.print(Panel("\n".join(panel_text), title="🔍 Análisis de Capacidad", border_style="yellow"))

    def _reporte_plano(self):
        """Reporte en texto plano (fallback sin Rich)."""
        m = self.metrics
        print(f"\n{'='*60}")
        print(f"  SIMULADOR DE TRÁFICO ARKANGEL")
        print(f"  Escenario: {self.scenario.nombre}")
        print(f"  Modo: {self.mode}")
        print(f"{'='*60}\n")
        print(f"  Total Requests:    {m.total_requests:,}")
        print(f"  Throughput:        {m.throughput_rps:.2f} RPS")
        print(f"  Tasa de Éxito:     {m.success_rate_pct:.1f}%")
        print(f"  Rate Limited:      {m.total_rate_limited:,}")
        print(f"  Encolados:         {m.total_queued:,}")
        print(f"\n  Latencias:")
        print(f"    P50: {m.p50_ms:.1f} ms")
        print(f"    P95: {m.p95_ms:.1f} ms")
        print(f"    P99: {m.p99_ms:.1f} ms")
        print(f"    Avg: {m.avg_ms:.1f} ms")
        print(f"    Max: {m.max_ms:.1f} ms")
        print(f"\n  Costo Proyectado: ${m.costo_proyectado_mxn:,.2f} MXN")
        print(f"{'='*60}\n")


# ═══════════════════════════════════════════════════════════════════════════════
# §7. CLI Y ORQUESTACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Volume Traffic Simulator — Simulador de carga omnicanal para Arkangel",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Escenarios disponibles:
  hot_sale    Ráfaga de 500 mensajes en 60s (Hot Sale / Buen Fin)
  quincena    Goteo sostenido de 200 mensajes en 5 min
  campana     Campaña masiva de 1000 mensajes con pacing
  burst       Explosión instantánea de 100 mensajes (prueba de cola)
  custom      Configura con --total, --rps, --duration, --concurrency

Ejemplos:
  python volume_traffic_simulator.py --scenario hot_sale --mode dry_run
  python volume_traffic_simulator.py --scenario burst --mode dry_run --concurrency 100
  python volume_traffic_simulator.py --scenario quincena --tenant temozonia --mode dry_run
  python volume_traffic_simulator.py --scenario custom --total 500 --rps 10 --mode dry_run
  python volume_traffic_simulator.py --scenario campana --mode live --url http://localhost:8787 --token $AUTH
        """
    )
    parser.add_argument("--scenario", choices=list(SCENARIOS.keys()) + ["custom"],
                        default="hot_sale", help="Escenario de carga a simular")
    parser.add_argument("--mode", choices=["dry_run", "live"], default="dry_run",
                        help="dry_run: simula respuestas localmente | live: toca el endpoint real")
    parser.add_argument("--url", default=BASE_URL_LOCAL,
                        help=f"URL base del Worker (default: {BASE_URL_LOCAL})")
    parser.add_argument("--token", help="Token de autenticación para modo live")
    parser.add_argument("--tenant", help="Filtrar por tenant específico")
    parser.add_argument("--seed", type=int, help="Seed para reproducibilidad")
    parser.add_argument("--concurrency", type=int, help="Override de concurrencia máxima")
    parser.add_argument("--total", type=int, help="Total de mensajes (solo custom)")
    parser.add_argument("--rps", type=float, help="Requests por segundo objetivo (solo custom)")
    parser.add_argument("--duration", type=float, help="Duración en segundos (solo custom)")
    parser.add_argument("--channels", nargs="+", choices=["whatsapp", "sms", "email"],
                        help="Canales a incluir (solo custom)")
    parser.add_argument("--output", choices=["console", "json"], default="console",
                        help="Formato de salida")
    parser.add_argument("--output-file", help="Archivo de salida para JSON")
    return parser


async def run_simulation(args) -> SimulationMetrics:
    """Orquesta la ejecución de la simulación."""
    if args.scenario == "custom":
        scenario = ScenarioConfig(
            nombre="🔧 Custom — Configuración Manual",
            total_mensajes=args.total or 100,
            duracion_segundos=args.duration or 60,
            rps_objetivo=args.rps or 5.0,
            concurrencia_max=args.concurrency or 50,
            canales=[Canal(c) for c in (args.channels or ["whatsapp"])],
            tenants=[args.tenant] if args.tenant else list(TENANT_PROFILES.keys()),
            distribucion="uniforme",
            descripcion="Escenario personalizado",
        )
    else:
        scenario = SCENARIOS[args.scenario]
        if args.concurrency:
            scenario.concurrencia_max = args.concurrency

    if args.mode == "live":
        print("\n⚠️  MODO LIVE: Se enviarán requests reales al endpoint.")
        print(f"   URL: {args.url}")
        print(f"   Total: {scenario.total_mensajes} mensajes")
        if not args.token:
            print("   ⚠️  Sin token de auth — asegúrate de que el endpoint sea accesible.")
        confirm = input("   ¿Continuar? [y/N]: ")
        if confirm.lower() != "y":
            print("   Cancelado.")
            sys.exit(0)

    simulator = TrafficSimulator(
        scenario=scenario,
        mode=args.mode,
        base_url=args.url,
        auth_token=args.token,
        tenant_filter=args.tenant,
        seed=args.seed,
    )

    if HAS_RICH:
        console = Console()
        console.print(f"\n[bold]Iniciando simulación:[/] {scenario.nombre}")
        console.print(f"[dim]Modo: {args.mode} | Mensajes: {scenario.total_mensajes} | "
                      f"RPS objetivo: {scenario.rps_objetivo:.1f} | "
                      f"Concurrencia: {scenario.concurrencia_max}[/]\n")

    metrics = await simulator.ejecutar()

    reporter = SimulationReporter(scenario, metrics, args.mode)
    reporter.imprimir_reporte()

    if args.output == "json":
        output = {
            "scenario": scenario.nombre,
            "mode": args.mode,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "metrics": {
                "total_requests": metrics.total_requests,
                "success_rate_pct": round(metrics.success_rate_pct, 2),
                "throughput_rps": round(metrics.throughput_rps, 2),
                "latency_p50_ms": round(metrics.p50_ms, 1),
                "latency_p95_ms": round(metrics.p95_ms, 1),
                "latency_p99_ms": round(metrics.p99_ms, 1),
                "latency_avg_ms": round(metrics.avg_ms, 1),
                "rate_limited": metrics.total_rate_limited,
                "queued": metrics.total_queued,
                "costo_proyectado_mxn": round(metrics.costo_proyectado_mxn, 2),
            },
        }
        if args.output_file:
            with open(args.output_file, "w") as f:
                json.dump(output, f, indent=2)
            print(f"\n📄 Reporte JSON: {args.output_file}")
        else:
            print(json.dumps(output, indent=2))

    return metrics


def main():
    args = build_parser().parse_args()

    if args.mode == "live" and not HAS_AIOHTTP:
        print("❌ Error: modo live requiere aiohttp. Instala con: pip install aiohttp")
        sys.exit(1)

    try:
        asyncio.run(run_simulation(args))
    except KeyboardInterrupt:
        print("\n\n⏹️  Simulación cancelada por el usuario.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error fatal: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
