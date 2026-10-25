# Instructivo 04: Contador General, Director de Finanzas (CFO) y Auditor Fiscal

> **Audiencia:** Contadores Públicos, Contralores, Directores de Finanzas (CFOs) y Auditores Fiscales.  
> **Alcance:** Cumplimiento de la Reforma Fiscal 2026 (CFF Arts. 29-A, 69-B y 5-A), Deducibilidad de Cuentas Incobrables (LISR Art. 27 Fracc. XV), Conciliación SPEI y Automatización Contable con Alegra.

---

## 1. El Nuevo Paradigma Fiscal: La Cobranza como Escudo de Materialidad

Con la entrada en vigor de la **Reforma al Artículo 29-A del Código Fiscal de la Federación (CFF)**, el Servicio de Administración Tributaria (SAT) ha establecido un criterio estricto:

> *"Ya no basta con exhibir el CFDI timbrado de ingreso o de egreso; los contribuyentes están obligados a demostrar la **materialidad**, existencia real, sustento documental y operativo de las operaciones y de las gestiones posteriores de cobro o castigo."*

En conjunto con los artículos **69-B** (presunción de operaciones simuladas) y **5-A** (razón de negocios) del CFF, las empresas enfrentan el riesgo de que el SAT rechace las deducciones por pérdidas de cuentas incobrables o presuma ingresos no declarados en acuerdos de quita si no se cuenta con **Fecha Cierta** y sustento inalterable.

Arkangel resuelve este dolor transformando cada interacción de cobranza en un **Expediente de Materialidad Fiscal 100% auditable**.

---

## 2. Deducibilidad de Cuentas Incobrables (Art. 27, Fracción XV de la LISR)

Para que una empresa pueda deducir legalmente una pérdida por crédito incobrable y disminuir su base gravable de Impuesto Sobre la Renta (ISR), la Ley exige:
1. Comprobar que ha transcurrido un año de mora a partir de que se incurrió en ella, o
2. **Demostrar la imposibilidad práctica de cobro**, habiendo agotado las gestiones formales de cobro ante el deudor.

### ¿Cómo generar el Expediente de Deducibilidad en Arkangel?

1. En la consola de Arkangel, ingresa al expediente del crédito castigado o en mora prolongada.
2. Haz clic en el botón **"⚖️ Cuaderno Judicial & SAT"**.
3. Revisa la sección **"VI. SUSTENTO DE MATERIALIDAD FISCAL (SAT CFF ARTS. 29-A Y 69-B · LISR ART. 27 XV)"**.
4. Haz clic en **"🖨️ Imprimir / PDF Oficial"**:
   - Arkangel compilará el paquete probatorio completo:
     - Constancias NOM-151 con estampado de tiempo oficial y sellos de ATEB Servicios PSC.
     - Bitácora inmutable de llamadas Telnyx y mensajes cursados.
     - Fecha cierta de cada requerimiento de cobro no atendido por el deudor.
     - Certificación de custodia inmutable WORM de 10 años conforme al Art. 49 del Código de Comercio.
5. Este PDF se archiva en la póliza contable de cierre del ejercicio fiscal como **soporte probatorio pleno de la deducción**.

---

## 3. Conciliación Bancaria de Pagos SPEI en Tiempo Real

Arkangel elimina la necesidad de buscar depósitos en estados de cuenta bancarios o verificar comprobantes en PDF falsificados:

1. **Rieles Automatizados (Cobre / Conekta):**
   - Cada crédito cuenta con una CLABE interbancaria receptora exclusiva (STP o bancaria).
2. **Conciliación Inmediata por Webhook:**
   - En el instante en que el deudor transfiere vía SPEI, el sistema recibe el evento bancario.
   - Valida el importe, la referencia y la **Clave de Rastreo de Banxico (CEP)**.
   - Aplica el abono al caso, actualiza el saldo insoluto en la base de datos D1 y cancela los recordatorios de mora.
3. **Módulo de Reportes de Pago:**
   - En la pestaña **"Pagos & Conciliación"**, podrás exportar en formato CSV o Excel todos los abonos del mes, listando:
     - Fecha y hora UTC / CDMX.
     - Clave de Rastreo SPEI de Banxico.
     - Banco emisor y Banco receptor.
     - Importe desglosado (Capital, Intereses, Descuento otorgado e IVA correspondiente).

---

## 4. Asientos Automáticos y Enlace con Alegra Contabilidad

Arkangel cuenta con un motor contable integrado que ejecuta un corte diario automatizado a las **23:59 hrs (Hora Centro de México)**:

### Asientos Contables Generados:

| Concepto | Cuenta Debe | Cuenta Haber | Fundamento |
| :--- | :--- | :--- | :--- |
| **Recuperación de Cartera** | Bancos (Caja / STP) | Clientes (Cuentas por Cobrar) | Liquidación confirmada vía SPEI |
| **Ingreso por Gestión / Intereses** | Clientes | Ingresos Financieros / Moratorios | Art. 362 Código de Comercio |
| **IVA Trasladado (16%)** | Clientes | IVA Trasladado Cobrado | Cobro de comisiones y recargos |
| **Castigo / Condonación Acordada** | Pérdidas por Cuentas Incobrables | Clientes | Art. 27 Fracc. XV LISR |

### Auditoría del Ledger Criptográfico en Cloudflare R2:

Cada asiento diario se firma con una huella SHA-256 encadenada al día anterior y se deposita en el bucket inmutable de Cloudflare R2 (`arkangel-contabilidad`). Ningún registro histórico puede ser modificado ni eliminado, garantizando integridad absoluta ante auditorías externas del SAT o de firmas contables independientes (Big Four).
