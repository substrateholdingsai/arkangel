# Anexo Técnico, Auditoría de Calidad y Propuesta Comercial

> **Destinatarios:** Equipos de Desarrollo (CTO / Arquitectura de Software), Seguridad de la Información (CISO), Compliance Legal y Dirección Comercial de **ATEB Servicios PSC**, Bancos, Fintechs y Grandes Despachos de Cobranza.  
> **Documento:** Diligencia Técnica (Due Diligence), Auditoría de Calidad de Software, Especificaciones de Integración y Condiciones Comerciales de **Arkangel LegalTech Platform**.

---

## 1. Resumen Ejecutivo de la Solución

**Arkangel** es una plataforma de software de grado empresarial (*Enterprise LegalTech*) diseñada para automatizar la cobranza judicial y extrajudicial en México. 

La plataforma fusiona tres motores en una sola arquitectura de borde (*Edge Computing*):
1. **Motor Operativo Omnicanal:** Telefonía saliente PSTN con detección de contestadoras (AMD), asistentes de voz con Inteligencia Artificial (Telnyx Voice AI) y mensajería certificada (WhatsApp Business API v2 y SMS).
2. **Motor Criptográfico Legal Dual-Engine:** Conexión nativa con **ATEB Servicios PSC** para estampas de tiempo RFC 3161 TSA y constancias NOM-151-SCFI-2016 en formato oficial ASN.1 DER / PKCS#7 (con failover a motor interno Arkangel).
3. **Generador Procesal y Fiscal:** Cuaderno de pruebas para Juicios Orales Mercantiles (Código de Comercio Art. 1298-A) y carpeta de materialidad para el SAT (CFF Arts. 29-A, 69-B y LISR Art. 27 Fracc. XV).

---

## 2. Ficha Técnica y Arquitectura de Infraestructura

| Componente | Especificación Técnica | Justificación de Calidad y Rendimiento |
| :--- | :--- | :--- |
| **Arquitectura de Ejecución** | Cloudflare Workers (Serverless V8 Isolates) | Sin servidores que parchar; arranque en frío de 0 ms; latencia global < 30 ms en territorio mexicano. |
| **Base de Datos Distribuida** | Cloudflare D1 (Motor relacional SQLite distribuido) | Cumplimiento ACID completo, aislamiento multi-inquilino (*multi-tenant*) estricto con claves foráneas activas (`PRAGMA foreign_keys = ON`). |
| **Almacenamiento Inmutable** | Cloudflare R2 (Bóveda Object Storage WORM) | Almacenamiento tipo *Write Once, Read Many* para registros contables y audios de llamadas sin costo de transferencia de salida (*zero egress fees*). |
| **Colas de Mensajería** | Cloudflare Queues | Procesamiento asíncrono desacoplado para envíos masivos de más de 10,000 requerimientos/minuto sin bloqueos. |
| **Criptografía y Hashing** | Web Crypto API (Nativo en V8) | Cálculo de huellas deterministas **SHA-256 (FIPS PUB 180-4)** y firmas **HMAC-SHA256**. |
| **Seguridad de Autenticación** | Hashing PBKDF2 | Derivación de contraseñas con **100,000 iteraciones** y sal criptográfica de 16 bytes. |
| **Telecomunicaciones & Audio** | Telnyx Call Control v2 + WebRTC | Audio digital Opus / G.711u, captura física de micrófono, transferencias en vivo (*call bridging*) y detección de máquina (AMD). |
| **Inteligencia Artificial** | Workers AI (Llama 3.3 70B Instruct) | Análisis de sentimiento, extracción de acuerdos y redacción de respuestas supervisadas. |

---

## 3. Anexo de Integración con ATEB Servicios PSC (Dual-Engine)

Arkangel fue concebido desde su código fuente para actuar como un **cliente de altísima velocidad para los WebServices de ATEB**:

```
┌────────────────────────────────────────────────────────┐
│                   GESTIÓN OPERATIVA                    │
│    (Llamada Telnyx / WhatsApp HSM / Convenio SPEI)     │
└───────────────────────────┬────────────────────────────┘
                            │ (Digest SHA-256)
                            ▼
┌────────────────────────────────────────────────────────┐
│              CONECTOR ATEB SERVICIOS PSC               │
│  • Endpoint REST/SOAP sobre TLS 1.3 con Timeout de 6s │
│  • Autenticación por Bearer Token + Client ID          │
│  • Emisión de Sello de Tiempo RFC 3161 TSA (CENAM)    │
│  • Emisión de Constancia NOM-151 (ASN.1 DER / PKCS#7)  │
└───────────────────────────┬────────────────────────────┘
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
      [Respuesta Exitosa]       [Fallo Red / Sin Saldo]
      MODO A: PLENO OFICIAL     MODO B: FAILOVER PREVENTIVO
      (Sello SE ATEB Acreditado) (Resguardo WORM + Cola Sync)
```

### Protocolo de Resiliencia ante Caídas del PSC (Failover):
* Si el WebService de ATEB presenta una interrupción temporal o el cliente agota sus timbres, la operación de cobranza **NUNCA se detiene**.
* Arkangel sella la evidencia en **Modo B (Presuntivo)**, guarda la huella en la bitácora WORM y coloca la transacción en cola para timbrado automático posterior ante ATEB en cuanto se normalice el servicio.

---

## 4. Matriz de Auditoría de Calidad y Cumplimiento Legal

| Marco Normativo | Regulación Específica | Mecanismo de Garantía en Arkangel |
| :--- | :--- | :--- |
| **Código de Comercio** | **Artículos 89 a 114** | Mensajes de datos con validez, no-repudio y presunción legal de autoría mediante cadena original. |
| **Código de Comercio** | **Artículo 1298-A** | **Prueba Plena Judicial**: El juez mercantil reconoce como prueba indiscutible la constancia emitida por el PSC. |
| **Código de Comercio** | **Artículo 49** | **Custodia WORM de 10 años**: Bitácora inmutable encadenada (`prev_hash` $\to$ `entry_hash`) a prueba de borrado. |
| **Código Fiscal de la Federación** | **Artículos 29-A y 69-B (Reforma 2026)** | **Materialidad y Fecha Cierta**: Sustento documental que desvirtúa la presunción de operaciones simuladas ante el SAT. |
| **Ley del Impuesto sobre la Renta** | **Artículo 27 Fracción XV** | **Deducibilidad de Incobrables**: Generación del expediente de imposibilidad práctica de cobro en 1 clic. |
| **CONDUSEF / REDECO** | **Reglas de Cobranza Extrajudicial** | **Escudo Legal Fail-Closed**: Bloqueo automático de mensajes con amenazas, cobro a terceros o fuera de 8:00 a 22:00 hrs. |
| **NOM-184-SCFI-2018** | **Límite de Contactos** | Semáforo de frecuencia que impide más de 3 contactos al deudor en un periodo de 24 horas. |
| **Privacidad Financiera** | **LFPDPPP y Ley de Inst. de Crédito** | Enmascaramiento de nombres, teléfonos y correos en verificaciones públicas y en el portal de autoservicio. |

---

## 5. Checklist de Verificación para el Equipo de Desarrollo del Cliente

Para que el equipo de arquitectura y desarrollo de ATEB o del despacho cliente valide la compatibilidad:

- [x] **Seguridad de Transporte:** Todas las comunicaciones están forzadas sobre **HTTPS con TLS 1.3** y certificados HSTS pre-cargados.
- [x] **Aislamiento Multi-Tenant:** Ningún tenant puede consultar, alterar ni recibir notificaciones de otra cartera (`tenant_id` obligatorio en todas las consultas y middleware de contexto).
- [x] **Idempotencia Transaccional:** Cada pago, timbrado de constancia y mensaje cuenta con llaves de idempotencia (`idempotency_key`) para impedir cobros dobles o timbrados duplicados.
- [x] **Sin Estado en el Edge (Stateless):** Los Workers escalan horizontalmente de forma instantánea de 1 a 100,000 peticiones concurrentes sin degradación de memoria.
- [x] **Pruebas Automatizadas:** Cobertura de **23 suites de pruebas unitarias y de integración (358 tests al 100% verdes)** verificables con `npm test`.
- [x] **Código Limpio:** Verificación con ESLint y TypeScript estricto (**0 errores, 0 advertencias**).

---

## 6. Propuesta y Características Comerciales

Arkangel está listo para operar bajo tres esquemas comerciales flexibles adaptados al volumen del cliente:

### Esquema A: Alianza Estratégica con ATEB Servicios PSC (Canal Oficial)
* **Objetivo:** Convertir a Arkangel en el motor oficial de consumo de timbres de ATEB para el sector financiero y de cobranza.
* **Modelo:**
  - ATEB ofrece Arkangel a su cartera de clientes (bancos, fintechs, comercializadoras y despachos).
  - ATEB comercializa y factura los **timbres NOM-151, estampas de tiempo TSA y custodia WORM de 10 años**.
  - Arkangel cobra una suscripción SaaS mensual por despacho activo y soporte técnico continuo.

### Esquema B: Implementación Directa para Despachos Multicartera / Bancos
* **Modelo SaaS por Volumen de Cuentas Activas:**
  - **Setup e Inicialización:** Configuración de dominio personalizado, carga de cartera y parametrización de plantillas legales.
  - **Tarifa Base Mensual:** Incluye acceso para operadores ilimitados, softphone Telnyx, servidor MCP y módulo de expediente judicial.
  - **Timbres ATEB PSC:** Facturados por paquete de consumo según volumen (desde \$0.50 a \$2.50 MXN por constancia según escalonamiento).

### Esquema C: Marca Blanca Empresarial ("White-Label")
* Implementación en infraestructura dedicada con la identidad corporativa de ATEB o del grupo financiero:
  - Dominio propio (ej. `cobranza.atebservicios.com.mx` o `legaltech.tudespacho.mx`).
  - Personalización visual (logotipos, paleta de colores corporativa y correos con remitente institucional).
  - Integración vía API directa con el Core Bancario o ERP del cliente.

---

## 7. Acuerdos de Nivel de Servicio (SLA)

| Parámetro | Compromiso SLA |
| :--- | :--- |
| **Disponibilidad de la Plataforma (Uptime)** | **99.95% anual** respaldado por la red global de Cloudflare presente en más de 330 ciudades. |
| **Tiempo de Respuesta de la API (P95)** | **< 150 milisegundos** para emisión interna y validación de reglas legales. |
| **Tiempo de Timbrado con ATEB PSC** | **< 2 segundos** (sujeto a la latencia del WebService de ATEB; failover inmediato a los 6 segundos). |
| **Soporte Técnico de Nivel 3** | Atención 24/7 para incidencias críticas de pasarelas de pago y telefonía. |
| **Ventana de Mantenimiento** | Cero tiempo de inactividad (*Zero-Downtime Deployments*) gracias a la arquitectura serverless. |

---

## 8. Siguientes Pasos para Homologación Técnica

1. **Prueba de Concepto en Sandbox (PoC):** Provisión de una cuenta demo con credenciales de prueba de ATEB PSC para que el equipo técnico realice llamadas, emita constancias y valide el recálculo matemático de hashes en tiempo real.
2. **Revisión de Seguridad:** Entrega del reporte de análisis estático de código, logs de auditoría WORM y diagramas de flujo de datos.
3. **Firma de Acuerdo Comercial y Arranque Operativo:** Activación de credenciales productivas en menos de 24 horas.
