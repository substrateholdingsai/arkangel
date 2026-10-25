# Instructivo 02: Abogado Litigante, Director Jurídico y Perito en Compliance

> **Audiencia:** Abogados Litigantes en Materia Mercantil, Directores Jurídicos, Especialistas en Recuperación Judicial y Peritos en Informática Legal.  
> **Alcance:** Aportación de pruebas electrónicas, emisión de constancias NOM-151, Cuaderno Procesal para Juicios Orales y Ejecutivos Mercantiles, custodia WORM de 10 años y blindaje ante objeciones procesales.

---

## 1. Fundamento Jurídico del Ecosistema Probatorio de Arkangel

Históricamente, los litigios mercantiles de cobranza se complicaban por la fragilidad de las pruebas digitales: capturas de pantalla de WhatsApp o correos electrónicos impresos eran fácilmente objetados de falsedad por el demandado.

Arkangel opera bajo el marco procesal de vanguardia en México:

* **Artículo 89 y 89 Bis del Código de Comercio:** Reconocimiento pleno de los efectos jurídicos, validez y fuerza obligatoria de los mensajes de datos en actos de comercio.
* **Artículo 90 del Código de Comercio:** Presunción legal de autoría del mensaje cuando se empleen métodos de identificación y trazabilidad acordados.
* **Artículo 1298-A del Código de Comercio:** **Reconocimiento como PRUEBA PLENA** de la información comunicada por medios electrónicos que cuente con constancia de conservación emitida por un Prestador de Servicios de Certificación (PSC) acreditado.
* **Norma Oficial Mexicana NOM-151-SCFI-2016:** Requisitos técnicos de inalterabilidad, fecha cierta y sellos de tiempo oficiales.
* **Artículo 49 del Código de Comercio:** Obligación de custodia y conservación inalterable de correspondencia y registros mercantiles por un plazo mínimo de **10 años**.
* **Artículo 362 del Código de Comercio:** Aplicación del interés legal moratorio del **6% anual** en materia mercantil cuando no se haya fijado contractualmente una tasa específica.
* **Artículo 112 Bis de la Ley Federal de Protección al Consumidor:** Formalidades de las cartas convenio y cartas finiquito para extinción de obligaciones crediticias.

---

## 2. Emisión de Constancias NOM-151 desde el Expediente

Cada requerimiento de pago, convenio extrajudicial o aviso de cobranza puede convertirse en un documento con fuerza probatoria plena:

### Pasos para certificar una notificación:

1. Ingresa al expediente del deudor en la consola de Arkangel.
2. Despliega la barra lateral del caso y ubica el panel **"Constancias Digitales NOM-151"**.
3. Haz clic en **"+ Certificar Notificación"**:
   - Arkangel tomará los datos del deudor, saldo adeudado, razón social del acreedor y número de registro CONDUSEF.
   - Generará la **Cadena Original Normalizada**:
     `||NOM151|1.0|FOLIO|TIMESTAMP_UTC|RAZON_SOCIAL|CONDUSEF|CLIENTE|TIPO|CANAL|PROVIDER_ID|SHA256_MENSAJE||`
   - Calculará el **Digest SHA-256** del texto íntegro.
   - Si tu despacho tiene activo ATEB Servicios PSC, conectará con el WebService oficial y sellará la constancia con valor de **Prueba Plena ante la Secretaría de Economía**.
4. Haz clic en **"Ver Acta ↗"** sobre cualquier constancia emitida:
   - Se abrirá el modal notarial con la representación formal del acta, huella SHA-256, sello digital, cadena original y fundamentos jurídicos.
   - Puedes pulsar **"Imprimir / PDF"** para anexarla a tu escrito inicial de demanda.

---

## 3. Generación del Cuaderno de Pruebas Judiciales en 1 Clic

Para preparar una demanda de **Juicio Oral Mercantil (Arts. 1390 Bis a 1390 Bis 50 CCom)** o **Juicio Ejecutivo Mercantil**:

1. En la cabecera de la sección NOM-151 del caso, pulsa el botón **"⚖️ Cuaderno Judicial & SAT"**.
2. Arkangel abrirá el modal interactivo con el expediente completamente compilado:
   - **Rubro Procesal:** Identificación del Tribunal Competente, Parte Actora y Parte Demandada con CURP.
   - **Liquidación Cuantitativa de Prestaciones:**
     - Capital Insoluto reclamado.
     - Días de mora transcurridos desde la fecha de vencimiento del crédito o pagaré.
     - Cómputo de intereses moratorios devengados (al 6% anual legal o tasa convenida).
     - Monto total líquido reclamado.
   - **Capítulo Probatorio Informático (Art. 1298-A CCom):** Tabla detallada de cada requerimiento con folio NOM-151, canal de transmisión (WhatsApp, SMS, Email), fecha local CDMX, Digest SHA-256 y nivel de cumplimiento oficial (ATEB PSC).
   - **Bitácora de Telefonía Telnyx:** Registros de llamadas con fecha, duración, extracto y Provider Call SID.
   - **Sustento de Materialidad Fiscal:** Resumen documental bajo los artículos 29-A y 69-B del CFF.
   - **Sello Hash Maestro del Expediente (SHA-256):** Huella global que ampara la totalidad de las fojas del expediente.
3. Haz clic en **"🖨️ Imprimir / PDF Oficial"**:
   - Se generará un documento imprimible con formato judicial, márgenes legales, encabezados procesales dobles y bloques de firmas para el representante legal y peritaje informático.

---

## 4. Cadena de Custodia WORM y Cómo Desvirtuar Objeciones en Juzgado

Si el abogado del demandado intenta impugnar tus notificaciones electrónicas alegando que *"son capturas de pantalla fáciles de alterar"* o *"mensajes fabricados"*:

### Estrategia de defensa procesal:

1. **Invocar el Artículo 1298-A del Código de Comercio:**
   Señalar que no se trata de impresiones simples, sino de un **Mensaje de Datos con Constancia de Conservación NOM-151-SCFI-2016** emitida conforme al estándar oficial de la Secretaría de Economía.
2. **Cotejo Forense en Audiencia:**
   - En la audiencia preliminar o de juicio, proporciona al Juez o al Secretario Instructor la URL pública de verificación:
     `https://arkangel.arksystems.site/verify/nom151/:folio`
   - El sistema recalculará en milisegundos y en tiempo real el hash del mensaje original frente al sello digital registrado. El Juez constatará que los hashes coinciden idénticamente bit a bit.
3. **Ofrecimiento de la Cadena WORM (Art. 49 CCom):**
   Arkangel mantiene un registro encadenado inmutable (tipo blockchain) en el cual cada notificación sella el hash de la anterior. Se puede aportar el reporte de conciliación de la cadena WORM (`/api/v1/nom151/cases/:id/worm-chain`) para acreditar que ningún registro ha sido intercalado ni modificado en el tiempo.

---

## 5. Emisión de Cartas Convenio y Finiquito (Art. 112 Bis LFPC)

Cuando el deudor acepta una propuesta de pago o liquida su cuenta:

1. **Carta Convenio Extrajudicial:**
   - Especifica el importe con descuento, esquema de parcialidades, CLABE interbancaria receptora y fecha improrrogable de pago.
   - Se sella automáticamente con folio NOM-151 y se pone a disposición del deudor en el Portal de Autoservicio.
2. **Carta Finiquito y Extinción de Obligación:**
   - Una vez confirmado el pago vía SPEI, Arkangel genera la Carta Finiquito declarando la deuda saldada a satisfacción del acreedor.
   - Incluye la cláusula obligatoria de compromiso de actualización de historial crediticio ante las Sociedades de Información Crediticia (**Buró de Crédito y Círculo de Crédito**) dentro de los **5 días hábiles** siguientes a la fecha de acreditación bancaria.
