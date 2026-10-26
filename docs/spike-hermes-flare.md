# Spike H · Agente Autónomo Hermes en Cloudflare Sandboxes (Hermes-flare)
## Inteligencia Forense, Skip-Tracing Patrimonial y Peritaje Judicial SAT

> **Estado**: Documento de Diseño Técnico y Arquitectura de Referencia (2026-10-25).  
> **Patrón Base**: `hermes-flare` (Chad Arimura / Nous Research) sobre **Cloudflare Sandbox SDK (`@cloudflare/sandbox`)** con Firecracker microVMs, Durable Objects y persistencia en Cloudflare R2.

---

## 1. Visión y Separación de Planos de Cómputo

En Arkangel, la Inteligencia Artificial se estructura en dos planos con responsabilidades, límites de memoria y capacidades de ejecución radicalmente diferenciados:

```
┌────────────────────────────────────────────────────────────────────────┐
│ PLANO 1: TRANSACCIONAL Y FRONTLINE (Edge V8 Isolates · < 128 MB RAM)   │
│ - Telnyx Voice AI Assistants (< 800 ms latencia, PSTN, AMD)            │
│ - WhatsApp Business, SMS y Email Transaccional                         │
│ - Motor Legal Fail-Closed (12 reglas CONDUSEF / REDECO / NOM-184)      │
│ - Conciliación SPEI en tiempo real (Conekta / Cobre)                   │
│ - Portal de Autoservicio del Deudor con 1-Click Checkout               │
│ - Tiempo de respuesta: < 50 ms por petición · 0 ms Cold Starts         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
               Disparo de Tareas de Alta Complejidad
               (Webhooks, Auditorías, Casos Escalados)
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PLANO 2: ALTA INTELIGENCIA FORENSE (Hermes-flare Sandbox · microVM)    │
│ - Runtime: Nous Research Hermes Agent (Python 3.11+, bash, Linux)      │
│ - Entorno: Firecracker microVM aislado (Cloudflare Containers SDK)     │
│ - Memoria de Trabajo: Workspace Linux con pip, Pandas, PyMuPDF, etc.   │
│ - Persistencia: Snapshots de /home/hermes a Cloudflare R2              │
│ - Inferencia: Workers AI (@cf/meta/llama-3.3-70b-instruct)             │
│ - Tiempo de ejecución: Trabajos de 30s a 15 min · Procesamiento Batch  │
└────────────────────────────────────────────────────────────────────────┘
```

El **Agente Hermes** no sustituye al agente conversacional ni realiza llamadas telefónicas al deudor. Sus funciones son de **nivel superior**: investigación patrimonial, análisis forense de facturas SAT, peritaje contable y síntesis de agravios para litigio mercantil.

---

## 2. Funciones Elevadas del Agente Hermes en Arkangel

### 2.1 Skip-Tracing y Solvencia Patrimonial Pre-Judicial
Antes de que un despacho invierta recursos en presentar una demanda ejecutiva mercantil con gastos de notificación y peritajes, el Agente Hermes ejecuta un escrutinio patrimonial autónomo:
1. **Rastreo de Activos y Sociedades**: Consulta registros públicos de comercio, boletines judiciales, directorios corporativos y contratos de gobierno (Compranet / DOF) para identificar si el titular es accionista, apoderado legal o proveedor activo.
2. **Georreferenciación y Localización Alternativa**: Cruce de domicilios fiscales y comerciales para identificar inmuebles potencialmente embargables mediante cédula catastral o folio real.
3. **Dictamen de Embargabilidad**: Emite un reporte clasificado (`A: Solvente con bienes inscritos`, `B: Flujo bancario activo sin inmuebles`, `C: Insolvente o desaparecido`) para que el abogado litigante decida si procede la vía ejecutiva o la deducción fiscal por incobrabilidad.

### 2.2 Peritaje Forense de Materialidad SAT (Arts. 29-A, 69-B CFF y 27-XV LISR)
En carteras mercantiles complejas (crédito PyME, factoraje o arrendamiento financiero):
1. **Parseo Masivo de XMLs y PDFs**: Hermes ingesta cientos de CFDIs (Ingreso, Egreso, Pago) y estados de cuenta bancarios en formato PDF.
2. **Detección de Operaciones Simuladas (Art. 69-B CFF)**: Cruza el RFC de los emisores y receptores contra las listas negras del SAT (EFOS definitivos y presuntos) para blindar a la institución financiera adquirente.
3. **Conciliación Matemática de Cuentas Incobrables**: Genera la corrida contable de pagos parciales, capital insoluto y comprobantes de requerimiento formal necesarios para emitir la **Carpeta de Materialidad Fiscal** que valida la deducción del ISR ante el SAT conforme al **Artículo 27 Fracción XV de la LISR**.

### 2.3 Redacción Pericial del Cuaderno Judicial Mercantil (Art. 1298-A CCom)
1. **Hechos y Agravios Jurídicos**: Hermes procesa el historial completo de notificaciones NOM-151, audios transcritos y cartas convenio quebrantadas, redactando de forma estructurada los capítulos de hechos y ofrecimiento de pruebas informáticas.
2. **Liquidación de Intereses Moratorios**: Ejecuta scripts en Python para computar día por día los intereses moratorios al 6% anual legal (**Art. 362 CCom**) o la tasa pactada en el pagaré, entregando una tabla anexa lista para el juzgado.

---

## 3. Arquitectura Técnica de Implementación

### 3.1 Dockerfile del Sandbox (`Dockerfile.sandbox`)
El contenedor encapsula el runtime de Hermes y el enlace de comunicación con el Worker (`sandbox-shim`):

```dockerfile
# Dockerfile para Cloudflare Sandbox - Runtime Hermes Agent
FROM python:3.11-slim-bookworm AS base

# Herramientas del sistema requeridas por Hermes y análisis forense
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    build-essential \
    libxml2-dev \
    libxslt1-dev \
    poppler-utils \
    tesseract-ocr \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Inyección del sandbox-shim oficial de Cloudflare
COPY --from=docker.io/cloudflare/sandbox:latest /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Creación de usuario no privilegiado para seguridad
RUN useradd -m -s /bin/bash hermes
USER hermes
WORKDIR /home/hermes

# Instalación de Hermes Agent (Nous Research) y librerías forenses
RUN pip install --no-cache-dir --user \
    hermes-agent \
    pandas \
    pypdf \
    cryptography \
    httpx

# Directorio de trabajo y memoria persistente
RUN mkdir -p /home/hermes/workspace /home/hermes/.hermes

CMD ["sleep", "infinity"]
```

### 3.2 Configuración de Wrangler (`wrangler.jsonc`)
Se configuran los bindings para el Durable Object del Sandbox, el bucket R2 de memoria y Workers AI:

```jsonc
{
  "name": "arkangel-cobranza",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-20",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "HERMES_SANDBOX",
        "class_name": "Sandbox"
      }
    ]
  },
  "r2_buckets": [
    {
      "binding": "HERMES_MEMORY_BUCKET",
      "bucket_name": "arkangel-hermes-snapshots"
    }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

### 3.3 Orquestador en TypeScript (`src/services/hermesForensics.ts`)
El Worker de Arkangel administra el ciclo de vida del contenedor mediante el SDK `@cloudflare/sandbox`:

```typescript
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";
import type { TenantContext } from "../tenancy/types";

export interface ForensicJobParams {
  caseId: string;
  clientId: string;
  taskType: 'skip_trace' | 'sat_materiality' | 'judicial_synthesis';
  documentsR2Urls: string[];
}

export async function dispatchHermesForensicJob(
  ctx: TenantContext,
  params: ForensicJobParams
): Promise<{ jobId: string; status: string }> {
  const sessionId = `hermes-${ctx.tenantId}-${params.caseId}`;
  
  // 1. Obtener o despertar la sesión del Sandbox
  const sandbox = getSandbox(ctx.env.HERMES_SANDBOX, sessionId);

  // 2. Restaurar snapshot previo de memoria desde R2 si existe
  try {
    await sandbox.restoreBackup({
      bucket: ctx.env.HERMES_MEMORY_BUCKET,
      path: `snapshots/${sessionId}.tar.gz`,
    });
  } catch {
    // Primera ejecución para este caso: arranca limpio
  }

  // 3. Inyectar credenciales y contexto legal en el workspace
  await sandbox.files.write(
    "/home/hermes/workspace/case_context.json",
    JSON.stringify({
      tenantId: ctx.tenantId,
      caseId: params.caseId,
      taskType: params.taskType,
      documents: params.documentsR2Urls,
      aiProviderUrl: "http://workers-ai.local/v1", // Proxy a Workers AI
    })
  );

  // 4. Ejecutar el agente Hermes en segundo plano (proceso desacoplado)
  const process = await sandbox.startProcess({
    cmd: "python3",
    args: ["-m", "hermes", "run", "--config", "/home/hermes/workspace/case_context.json"],
    cwd: "/home/hermes/workspace",
  });

  return {
    jobId: process.pid.toString(),
    status: "processing",
  };
}
```

### 3.4 Persistencia y Ahorro Serverless (`DirectoryBackup`)
Para evitar costos ociosos, el contenedor se suspende tras completar su tarea forense. Antes de cerrarse, el Durable Object ejecuta:

```typescript
// Snapshot de memoria episódica a Cloudflare R2
await sandbox.createBackup({
  bucket: env.HERMES_MEMORY_BUCKET,
  path: `snapshots/${sessionId}.tar.gz`,
  directory: "/home/hermes/.hermes",
});
```

---

## 4. Endpoints Propuestos para la API de Arkangel

| Método | Ruta | Scope | Descripción |
| :--- | :--- | :--- | :--- |
| POST | `/api/v1/hermes/forensics/:caseId` | `cases:resolve` | Detona auditoría forense de facturas SAT, estados de cuenta y simulación de operaciones (Art. 69-B) |
| POST | `/api/v1/hermes/skip-trace/:clientId` | `clients:read` | Inicia investigación patrimonial autónoma de bienes, inmuebles y sociedades del deudor |
| GET | `/api/v1/hermes/jobs/:jobId` | `cases:read` | Consulta estado, logs de ejecución y conclusiones emitidas por el agente Hermes |
| POST | `/api/v1/hermes/docket-synthesis/:caseId` | `cases:write` | Solicita la redacción pericial automatizada del capítulo de pruebas para el Cuaderno Judicial |

---

## 5. Gobernanza, Aislamiento y Seguridad

1. **Aislamiento Físico por MicroVM**: Hermes corre dentro de una microVM Firecracker aislada. Ningún comando de terminal o script de Python tiene acceso a la red interna ni a las credenciales maestras de Cloudflare D1 o KV.
2. **Acceso de Solo Lectura al Expediente**: El Worker descarga las evidencias y las monta en el sandbox; Hermes no tiene permisos de borrado (`DELETE`) ni de modificación sobre las tablas del ledger.
3. **Registro en Bitácora WORM (Art. 49 CCom)**: El dictamen final emitido por Hermes (ej. `forensic_report.pdf` o dictamen de insolvencia) se calcula con hash SHA-256 y se inyecta en `worm_audit_log`, asegurando su inmutabilidad durante 10 años.
4. **Cero Fugas de Datos Personales**: Al utilizar Cloudflare Workers AI (`--provider workers-ai`) como motor de inferencia, ningún RFC, CURP o saldo financiero viaja a APIs de terceros fuera de la infraestructura de Cloudflare.

---

## 6. Siguientes Pasos para Activación

1. **Validación de Capacidad**: Confirmar el acceso a **Cloudflare Containers / Sandbox SDK** en la cuenta de Cloudflare del proyecto.
2. **Prueba Piloto en Local**: Levantar un contenedor local con Docker usando la imagen de `carimura/hermes-flare` para validar el consumo de memoria de Hermes con Llama 3.3 70B en Workers AI.
3. **Integración con el Cuaderno Judicial**: Añadir el botón en el dashboard de Arkangel: `[Solicitar Peritaje Hermes SAT / Skip-Tracing]` en la pestaña del expediente judicial.
