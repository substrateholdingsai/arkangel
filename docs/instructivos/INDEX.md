# ARKANGEL · Centro de Instructivos y Manuales Operativos

Bienvenido al centro oficial de instructivos y guías de uso de **Arkangel**, la plataforma de cobranza legal asistida por Inteligencia Artificial, telefonía en vivo (Telnyx), certificación criptográfica NOM-151-SCFI-2016 (ATEB Servicios PSC) y blindaje de materialidad fiscal ante el SAT.

Este repositorio de instructivos está estructurado por **nivel de usuario y rol operativo**, permitiendo que cada miembro de la organización domine sus herramientas específicas sin fricción técnica.

---

## Mapa de Instructivos por Nivel de Usuario

| # | Perfil / Rol | Archivo de Instrucciones | Objetivo Principal |
| :---: | :--- | :--- | :--- |
| **01** | **Administrador / Dueño / LegalTech Lead** | [`01-administrador-dueno.md`](./01-administrador-dueno.md) | Configuración del despacho, credenciales ATEB PSC, telefonía Telnyx, pasarelas SPEI y gestión de equipo. |
| **02** | **Abogado Litigante / Director Jurídico** | [`02-abogado-litigante-compliance.md`](./02-abogado-litigante-compliance.md) | Generación del Cuaderno de Pruebas Judiciales (CCom Art. 1298-A), constancias NOM-151, liquidación de mora y custodia WORM de 10 años. |
| **03** | **Operador / Gestor de Cobranza** | [`03-operador-gestor-cobranza.md`](./03-operador-gestor-cobranza.md) | Operación diaria del expediente, Softphone Telnyx PSTN / Voice AI, Copilot 3D por voz y mensajería protegida por el Escudo Legal. |
| **04** | **Contador / CFO / Auditor Fiscal** | [`04-contador-auditor-fiscal.md`](./04-contador-auditor-fiscal.md) | Sustento de Materialidad SAT (CFF Arts. 29-A y 69-B), deducción de cuentas incobrables (LISR Art. 27 Fracc. XV) y sincronización con Alegra. |
| **05** | **Deudor / Titular del Crédito (Autoservicio)** | [`05-portal-deudor-autoservicio.md`](./05-portal-deudor-autoservicio.md) | Guía del portal de autoservicio 1-Click SPEI (`/pay/:id`), simulación de quitas, liquidación bancaria y descarga de Carta Finiquito. |
| **06** | **Equipos de Ventas, TI & Due Diligence** | [`06-auditoria-calidad-anexo-tecnico-comercial.md`](./06-auditoria-calidad-anexo-tecnico-comercial.md) | Anexo técnico, auditoría de calidad de software, integración ATEB PSC, matriz de cumplimiento y propuesta comercial. |

---

## Matriz de Permisos y Capacidades por Rol

```
┌──────────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│ Capacidad / Módulo                   │ Admin       │ Abogado     │ Operador    │ Contador    │
├──────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────────┤
│ Configurar ATEB PSC y Telnyx         │      ✓      │      -      │      -      │      -      │
│ Invitar y dar de baja miembros       │      ✓      │      -      │      -      │      -      │
│ Cargar cartera (Ingesta CSV)         │      ✓      │      -      │      ✓      │      -      │
│ Softphone y Marcación Telnyx PSTN/AI │      ✓      │      ✓      │      ✓      │      -      │
│ Emitir Constancias NOM-151           │      ✓      │      ✓      │      ✓      │      -      │
│ Generar Cuaderno Judicial y SAT (PDF)│      ✓      │      ✓      │      ✓      │      ✓      │
│ Validar Cadena de Custodia WORM      │      ✓      │      ✓      │      -      │      ✓      │
│ Ver conciliación y asientos contables│      ✓      │      -      │      -      │      ✓      │
│ Reestructurar y condonar adeudos     │      ✓      │      ✓      │      -      │      -      │
└──────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

---

## Acceso Rápido a la Plataforma

* **Consola Web Principal:** [https://arkangel.arksystems.site](https://arkangel.arksystems.site)
* **Verificador Público Judicial NOM-151:** `https://arkangel.arksystems.site/verify/nom151/:folio`
* **Portal de Autoservicio del Deudor:** `https://arkangel.arksystems.site/pay/:id`
* **Documentación Técnica General:** [`../map.md`](../map.md)
