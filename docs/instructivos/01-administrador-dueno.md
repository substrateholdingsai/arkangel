# Instructivo 01: Administrador, Dueño del Despacho y LegalTech Lead

> **Audiencia:** Directores Generales, Socios Directores de Despachos de Cobranza, Gerentes de Operaciones y Líderes de LegalTech.  
> **Alcance:** Configuración institucional, integración con ATEB Servicios PSC, provisión de telefonía Telnyx, pasarelas de pago y gobierno de usuarios.

---

## 1. Introducción y Responsabilidades del Rol

Como Administrador o Dueño del Despacho, eres responsable de la parametrización institucional de Arkangel para garantizar que todas las gestiones de cobro cumplan con la legislación mexicana (CONDUSEF, REDECO, Código de Comercio y Código Fiscal de la Federación), protegiendo la reputación del acreedor y habilitando la máxima tasa de recuperación.

---

## 2. Configuración Institucional del Despacho

Para que el **Motor Legal** permita el envío de mensajes y el timbrado de constancias, es indispensable registrar los datos formales de la entidad acreedora:

1. Inicia sesión en [https://arkangel.arksystems.site](https://arkangel.arksystems.site) con tu cuenta de Administrador.
2. En la barra superior, haz clic en **"⚙️ Configuración del Despacho"**.
3. Completa los siguientes campos obligatorios:
   - **Razón Social Formal:** (Ej. `Servicios Jurídicos y Cobranza Corporativa S.A. de C.V.`). Esta razón social se inyecta en cada WhatsApp, SMS, constancia NOM-151 y demanda judicial.
   - **Número de Registro CONDUSEF / REDECO:** (Ej. `REDECO-2026-9812`).
   - **Zona Horaria Institucional:** Selecciona `America/Mexico_City`.
   - **Ventana Legal de Contacto:** Configura inicio a las `08:00` y término a las `22:00` hrs. Todo intento de contacto fuera de esta ventana será bloqueado en automático por el Escudo Legal (Regla 1.1).
   - **Límite Diario de Contactos (NOM-184):** Mantén el valor en `3` contactos cada 24 horas por deudor.

---

## 3. Conexión con ATEB Servicios PSC (Modo Dual)

Arkangel integra nativamente el WebService de **ATEB Servicios PSC** (acreditado por la Secretaría de Economía) para otorgar **Prueba Plena** a las gestiones de cobranza.

### ¿Cómo activar las credenciales de ATEB?

1. En la consola, dirígete a la pestaña **"Conectores & PSC Legal"**.
2. Ubica la tarjeta de **"ATEB Servicios PSC (NOM-151-SCFI-2016)"**.
3. Configura los siguientes parámetros:
   - **Habilitar ATEB PSC:** Activa el interruptor (`ON`).
   - **Entorno:** Selecciona `Sandbox` (para pruebas iniciales) o `Production` (para litigio real).
   - **ID de Contrato / Cliente ATEB:** Ingresa el identificador provisto en tu contrato con ATEB.
   - **API Key / Token de Acceso:** Pega tu clave de autenticación.
   - **Sello de Tiempo Oficial (TSA RFC 3161):** Mantén activada la casilla para certificar fecha y hora oficial sincronizada con el CENAM.
   - **Auto-Estampado en Notificaciones Salientes:** Activa esta opción para que cada WhatsApp, SMS y convenio formal sea timbrado automáticamente ante ATEB al momento del envío.
4. Haz clic en **"Guardar y Probar Conexión"**.

> [!NOTE]
> **Modo B (Resiliencia Operativa):** Si no cuentas temporalmente con saldo de timbres en ATEB o el WebService entra en mantenimiento, Arkangel activará automáticamente el **Modo B (Motor Nativo Arkangel)**. Tus gestiones continuarán sellándose con huella SHA-256 interna y quedarán listas en cola para ser timbradas masivamente ante ATEB cuando se restablezca la conexión.

---

## 4. Provisión de Telefonía Telnyx y Voice AI Assistants

Arkangel utiliza **Telnyx Call Control v2** para marcación saliente telefónica y agentes conversacionales autónomos con IA.

### Pasos para conectar Telnyx:

1. Ve a **"Canales & Telecomunicaciones"** en el panel de configuración.
2. Ingresa tu **Telnyx API Key v2** (formato `KEY...`).
3. **Sincronización del Voice AI Assistant:**
   - Haz clic en el botón **"Sincronizar Asistente de Voz IA con Telnyx"**.
   - Arkangel creará y actualizará automáticamente en Telnyx el agente de voz con el guión legal fail-closed, instrucciones de empatía y reglas CONDUSEF.
4. **Números Telefónicos Salientes (Caller IDs):**
   - Asigna los números telefónicos virtuales (DIDs) validados para llamadas salientes.
   - Habilita la casilla **"Detección de Contestadora (AMD Premium)"**: esto asegurará que si contesta una máquina o buzón de voz, la llamada se corte de inmediato sin generar costos ni molestias innecesarias.

---

## 5. Pasarelas de Pago SPEI y Conciliación Automática

Para que los deudores puedan liquidar en 1 clic y el saldo se actualice en tiempo real:

1. En la pestaña **"Pasarelas Financieras"**:
   - **Cobre (SPEI B2B):** Ingresa tu `Secret Key` de Cobre para habilitar CLABEs STP dedicadas por deudor.
   - **Conekta (SPEI / OXXO):** Ingresa tus llaves pública y privada para recibir notificaciones de pago vía webhook.
2. **Dominios de Pago Permitidos:**
   - Configura `arksystems.site,pagos.arksystems.site`. Esto evita que operadores puedan insertar enlaces externos o no auditados en los mensajes (Regla CONDUSEF 3.2).

---

## 6. Gestión del Equipo y Asignación de Roles

Para invitar a abogados, supervisores y operadores:

1. En la sección **"Miembros del Despacho"**, haz clic en **"+ Invitar Miembro"**.
2. Ingresa el nombre completo, correo institucional y selecciona el rol:
   - **Owner / Admin:** Acceso irrestricto a configuraciones, llaves y bajas.
   - **Operator (Operador):** Acceso a la consola de casos, softphone, chat y emisión de constancias.
   - **Auditor / Contador:** Acceso de sólo lectura para conciliación contable, auditorías de materialidad SAT y descarga de expedientes.
3. El colaborador recibirá un correo con su enlace de activación de contraseña nativa encriptada con PBKDF2 (100,000 iteraciones).

---

## 7. Carga de Cartera (Ingesta Masiva de Deudores)

Para cargar un nuevo portafolio de créditos o facturas vencidas:

1. En el Dashboard principal, localiza el área de **"Subir Cartera (CSV)"**.
2. Arrastra tu archivo CSV estructurado con las columnas estándar:
   `nombre,telefono,email,monto,fecha_vencimiento,descripcion,curp`
3. Arkangel validará los números en formato E.164 (+52...), calculará el **Score Sherman v2** (propensión de pago) y segmentará los casos para los operadores.
