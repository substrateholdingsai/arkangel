# Instructivo 03: Operador Telefónico y Gestor de Cobranza Digital

> **Audiencia:** Ejecutivos de Cobranza Telefónica, Gestores de Negociación Omnicanal y Supervisores de Call Center.  
> **Alcance:** Gestión operativa del expediente, uso del Softphone Telnyx, dictado por voz, Copilot IA y mensajería protegida contra multas CONDUSEF.

---

## 1. Tu Misión como Operador en Arkangel

En Arkangel, tu labor no es confrontar ni amenazar al deudor, sino **guiarlo y facilitarle la liquidación de su cuenta** mediante soluciones viables, convenios autorizados y pagos instantáneos por SPEI.

Arkangel cuenta con un **Escudo Legal Automático**: si por error escribes algo que viole las normas de la CONDUSEF o la ley mexicana, el sistema te avisará y bloqueará el mensaje antes de que salga, protegiéndote a ti y a la empresa.

---

## 2. El Dashboard de Casos y Priorización por Score

Cuando inicias tu jornada:

1. Ingresa a la pantalla principal de Arkangel.
2. Observarás la lista de casos del día ordenados por el **Score Sherman v2**:
   - 🟢 **Score Alto (70 - 100):** Deudores con máxima probabilidad de pago hoy. Prioriza llamarlos o contactarlos primero.
   - 🟡 **Score Medio (40 - 69):** Deudores que suelen requerir una propuesta de quita o facilidades en 2 a 3 parcialidades.
   - 🔴 **Score Bajo (0 - 39):** Casos difíciles que probablemente requieran convenio formal o escalamiento judicial.
3. Haz clic sobre cualquier caso para abrir el **Expediente del Deudor** en la barra lateral derecha.

---

## 3. Uso del Softphone Telefónico Telnyx (Llamadas en Vivo)

En la parte superior del expediente encontrarás el panel de telefonía:

### ¿Cómo hacer una llamada telefónica?

1. **Selecciona la Línea de Salida:**
   - **Telnyx PSTN (Humano):** Conecta tu voz directamente al teléfono celular o fijo del deudor a través de la red telefónica tradicional.
   - **Telnyx Voice AI (Autónomo):** El sistema marcará y un asistente de Inteligencia Artificial entablará la conversación inicial de cobranza.
2. **Permiso de Micrófono:**
   - La primera vez que llames, el navegador te pedirá permiso para usar tu micrófono. Haz clic en **"Permitir"**.
3. **Iniciar la Llamada:**
   - Presiona el botón verde **"Iniciar Llamada"**.
   - En pantalla verás el estado de conexión (`Marcando...` $\to$ `Conectado`).
   - El cronómetro comenzará a contar la duración exacta de la llamada.
4. **Controles durante la llamada:**
   - **Silenciar Micrófono (Mute):** Presiona el icono del micrófono para silenciar tu audio si necesitas toser o consultar a un compañero. Presiónalo nuevamente para reanudar.
   - **Colgar Llamada:** Presiona el botón rojo **"Colgar"**. La llamada finalizará y el audio quedará guardado y enlazado al expediente con su identificador único de telecomunicaciones.

### Transferencia en Caliente (Call Bridging)

Si el deudor solicita hablar con un abogado o requiere autorización de una quita especial:
1. En el campo **"Transferir Llamada"**, ingresa el número o extensión del supervisor.
2. Haz clic en **"Transferir"**: el deudor será comunicado de inmediato sin cortar la llamada.

---

## 4. Respuestas Omnicanal (WhatsApp, SMS y Email) con Escudo Legal

Para enviar un mensaje formal al deudor:

1. Ve a la sección **"Responder como Operador"** al final del expediente.
2. **Selecciona el Canal:** Elige entre `WhatsApp`, `SMS` o `Email`.
3. **Botones de Asistencia Rápida:**
   - **"Insertar identificación CONDUSEF + CLABE":** Inserta automáticamente el saludo formal con la razón social del acreedor, registro CONDUSEF, saldo exacto y la CLABE interbancaria receptora.
   - **"Insertar Enlace 1-Click SPEI":** Añade el link único del deudor para que pueda abrir su portal de autoservicio desde su celular.
4. **Casilla `[x] Certificar con NOM-151`:**
   - Mantén marcada esta casilla para que tu mensaje quede sellado con huella criptográfica SHA-256 e incorporado a las pruebas legales del caso.
5. **Escribe tu mensaje y presiona "Validar y Enviar":**
   - El Motor Legal analizará tu texto en tiempo real.
   - Si no contiene infracciones, se enviará de inmediato.
   - Si detecta lenguaje agresivo, horarios indebidos o cobro a terceros, te mostrará una alerta roja indicando qué regla se infringe y cómo corregirla.

---

## 5. Dictado por Voz y Mascota Copilot 3D ("Ark")

Para redactar notas o mensajes sin usar el teclado:

1. **Dictado por Voz:**
   - Haz clic en el botón con icono de **Micrófono** ubicado en el cuadro de texto.
   - Háblale de forma natural en español de México (ej. *"Estimado cliente le recordamos que su fecha límite vence el día de mañana"*).
   - Tu voz se transcribirá automáticamente en el campo de texto.
2. **Asistente IA Copilot 3D:**
   - En la esquina inferior derecha verás a la mascota interactiva **Ark**.
   - Puedes hacerle clic y preguntarle: *"¿Cuál es la quita máxima que le puedo ofrecer a este cliente?"* o *"Recomiéndame un argumento para un cliente que dice que no tiene trabajo"*.
   - Ark te dará recomendaciones basadas en el perfil de riesgo del caso.

---

## 6. Registro de Promesas de Pago

Si llegas a un acuerdo con el titular de la deuda:

1. En el panel de **"Registrar Promesa de Pago"**:
   - Ingresa el **Monto Acordado en pesos**.
   - Selecciona la **Fecha Compromiso de Pago**.
2. Presiona **"Guardar Promesa"**:
   - El caso cambiará su estado a `promised`.
   - Se pausarán los recordatorios automáticos agresivos para respetar el compromiso acordado.
   - Cuando el deudor transfiera por SPEI, el sistema conciliará el abono automáticamente.
