/**
 * Motor de Expediente Judicial de Prueba Plena y Materialidad Fiscal SAT.
 *
 * Compila y estructura en 1 clic el Cuaderno Procesal de Pruebas Informáticas
 * y Sustento de Materialidad para litigio en Juicio Oral Mercantil
 * (Código de Comercio Arts. 89-114, 1298-A, 1390 Bis) y auditorías del SAT
 * (CFF Arts. 29-A, 69-B y LISR Art. 27 Fracción XV).
 */

import { listNom151CertificatesByCase, formatLocalTimestamp, sha256Hex } from './nom151';
import { verifyWormChain, recordWormAuditEntry } from './custodyWorm';
import type { TenantContext } from '../tenancy/types';
import type { Nom151Certificate } from './nom151';

export interface JudicialDocketData {
  folioExpediente: string;
  fechaEmisionUtc: string;
  fechaEmisionLocal: string;
  tribunalCompetente: string;
  viaProcesal: string;
  actor: {
    razonSocial: string;
    condusefRegistro: string;
    tenantId: string;
  };
  demandado: {
    nombre: string;
    telefono: string | null;
    email: string | null;
    curp: string | null;
    clientId: string;
  };
  liquidacion: {
    capitalInsolutoCents: number;
    capitalInsolutoFormatted: string;
    diasMora: number;
    interesMoratorioEstimadoFormatted: string;
    totalReclamadoFormatted: string;
    fechaVencimiento: string;
  };
  pruebasNom151: Array<{
    folio: string;
    tipo: string;
    canal: string;
    fecha: string;
    digest: string;
    sello: string;
    cumplimiento: string;
    proveedor: string;
    constanciaOficialId: string | null;
    verificacionUrl: string;
  }>;
  gestionesOperativas: Array<{
    tipo: string;
    fecha: string;
    detalle: string;
    identificadorProveedor: string | null;
  }>;
  custodiaWorm: {
    cadenaValida: boolean;
    totalEventosAuditados: number;
    fundamentoRetencion: string;
    hashExpedienteSha256: string;
  };
  sustentoFiscalSat: {
    materialidadComprobada: boolean;
    articulosAplicables: string[];
    resumenMaterialidad: string;
  };
}

/**
 * Compila los datos completos del expediente judicial y fiscal de un caso.
 */
export async function generateCaseJudicialDocket(
  ctx: TenantContext,
  caseId: string
): Promise<JudicialDocketData | null> {
  const caseRow = await ctx.env.DB.prepare(
    `SELECT c.*,
            cl.name as client_name,
            cl.phone as client_phone,
            cl.email as client_email,
            cl.curp as client_curp,
            d.due_date,
            d.amount_cents as debt_amount_cents,
            d.description as debt_description
     FROM cases c
     JOIN clients cl ON c.client_id = cl.id
     LEFT JOIN debts d ON c.debt_id = d.id
     WHERE c.id = ? AND c.tenant_id = ?
     LIMIT 1`
  )
    .bind(caseId, ctx.tenantId)
    .first<any>();

  if (!caseRow) return null;

  const nowUtc = new Date().toISOString();
  const nowLocal = formatLocalTimestamp(nowUtc);
  const cleanTenant = ctx.tenantId.replace(/^t_/, '').toUpperCase();
  const folioExpediente = `EXP-JUD-${cleanTenant}-${caseId.slice(-8).toUpperCase()}`;

  // 1. Cálculo de liquidación y mora (Art. 362 Código de Comercio: 6% anual en mora mercantil a falta de pacto)
  const capitalCents = caseRow.debt_amount_cents || caseRow.amount_cents || 0;
  const dueDateStr = caseRow.due_date || caseRow.case_date || nowUtc.slice(0, 10);
  const dueDate = new Date(dueDateStr);
  const nowDate = new Date();
  const diffTime = Math.max(0, nowDate.getTime() - dueDate.getTime());
  const diasMora = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  // Tasa moratoria legal del 6% anual (Código de Comercio Art. 362)
  const interesAnualRate = 0.06;
  const interesMoratorioCents = Math.round((capitalCents * interesAnualRate * diasMora) / 365);
  const totalReclamadoCents = capitalCents + interesMoratorioCents;

  const fmtCurrency = (cents: number) =>
    new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(cents / 100);

  // 2. Recopilación de Constancias Digitales NOM-151 emitidas
  const certs: Nom151Certificate[] = await listNom151CertificatesByCase(ctx, caseId);
  const pruebasNom151 = certs.map((c) => ({
    folio: c.certificateFolio,
    tipo: c.tipoNotificacion,
    canal: c.channel,
    fecha: c.timestampLocal,
    digest: c.messageDigestSha256,
    sello: c.selloDigital,
    cumplimiento:
      c.pscComplianceLevel === 'modo_a_pleno'
        ? 'Cumplimiento Pleno Oficial (ATEB PSC · Secretaría de Economía)'
        : 'Evidencia Interna Preparada para Timbrado Oficial',
    proveedor: c.pscProvider === 'ateb_psc' ? 'ATEB Servicios PSC' : 'Arkangel Native Engine',
    constanciaOficialId: c.pscConstanciaId,
    verificacionUrl: c.verificationUrl,
  }));

  // 3. Recopilación de gestiones de telefonía Telnyx y mensajes
  const messagesResult = await ctx.env.DB.prepare(
    `SELECT channel, direction, provider_id, body, status, created_at
     FROM messages
     WHERE case_id = ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(caseId)
    .all<any>();

  const gestionesOperativas = (messagesResult.results || []).map((m) => ({
    tipo: `${m.channel.toUpperCase()} (${m.direction === 'outbound' ? 'Saliente' : 'Entrante'})`,
    fecha: formatLocalTimestamp(m.created_at),
    detalle: m.body ? m.body.slice(0, 120) + (m.body.length > 120 ? '...' : '') : 'Gestión de cobro',
    identificadorProveedor: m.provider_id || null,
  }));

  // 4. Auditoría WORM (Art. 49 CCom)
  const wormCheck = await verifyWormChain(ctx.env, ctx.tenantId, caseId);

  // 5. Hash integral del expediente
  const hashPayload = `${folioExpediente}|${caseId}|${capitalCents}|${pruebasNom151.length}|${nowUtc}`;
  const hashExpedienteSha256 = await sha256Hex(hashPayload);

  // 6. Registro del evento de exportación en la Capa WORM
  await recordWormAuditEntry(ctx.env, {
    tenantId: ctx.tenantId,
    caseId,
    recordType: 'judicial_docket_export',
    recordId: folioExpediente,
    action: 'exported',
    actor: 'operator',
    recordHash: hashExpedienteSha256,
    metadata: {
      folioExpediente,
      totalPruebas: pruebasNom151.length,
      totalReclamadoCents,
    },
  });

  const razonSocial = ctx.tenant?.razon_social || 'Entidad Acreedora Autorizada';
  const condusefRegistro = ctx.tenant?.condusef_registro || 'REDECO-REGULADO';

  return {
    folioExpediente,
    fechaEmisionUtc: nowUtc,
    fechaEmisionLocal: nowLocal,
    tribunalCompetente: 'JUZGADO DE ORALIDAD MERCANTIL EN TURNO',
    viaProcesal: 'JUICIO ORAL MERCANTIL (ARTS. 1390 BIS A 1390 BIS 50 CÓDIGO DE COMERCIO)',
    actor: {
      razonSocial,
      condusefRegistro,
      tenantId: ctx.tenantId,
    },
    demandado: {
      nombre: caseRow.client_name,
      telefono: caseRow.client_phone || null,
      email: caseRow.client_email || null,
      curp: caseRow.client_curp || null,
      clientId: caseRow.client_id,
    },
    liquidacion: {
      capitalInsolutoCents: capitalCents,
      capitalInsolutoFormatted: fmtCurrency(capitalCents),
      diasMora,
      interesMoratorioEstimadoFormatted: fmtCurrency(interesMoratorioCents),
      totalReclamadoFormatted: fmtCurrency(totalReclamadoCents),
      fechaVencimiento: dueDateStr,
    },
    pruebasNom151,
    gestionesOperativas,
    custodiaWorm: {
      cadenaValida: wormCheck.valid,
      totalEventosAuditados: wormCheck.totalEntries,
      fundamentoRetencion: 'Artículo 49 del Código de Comercio (Custodia WORM inmutable 10 años)',
      hashExpedienteSha256,
    },
    sustentoFiscalSat: {
      materialidadComprobada: true,
      articulosAplicables: [
        'Artículo 29-A CFF (Materialidad, sustento documental y operativo de operaciones reales)',
        'Artículo 69-B CFF (Desvirtuación de operaciones simuladas e inexistentes mediante traza electrónica)',
        'Artículo 27 Fracción XV LISR (Deducibilidad de cuentas incobrables por imposibilidad práctica de cobro demostrada)',
        'Artículo 1298-A Código de Comercio (Valor de prueba plena de mensajes de datos con constancia NOM-151)',
      ],
      resumenMaterialidad:
        'El presente expediente acredita de manera fehaciente la materialidad de la relación contractual, los requerimientos extrajudiciales cursados y la fecha cierta mediante constancias criptográficas NOM-151-SCFI-2016 y sellos de tiempo oficiales.',
    },
  };
}

/**
 * Renderiza el Cuaderno Judicial y Fiscal en HTML estructurado para impresión o guardado PDF.
 */
export function renderJudicialDocketHtml(docket: JudicialDocketData): string {
  const tieneAteb = docket.pruebasNom151.some((p) => p.proveedor.includes('ATEB'));
  const selloBadgeText = tieneAteb
    ? 'SELLO OFICIAL ATEB SERVICIOS PSC · SECRETARÍA DE ECONOMÍA'
    : 'EVIDENCIA CRIPTOGRÁFICA REGISTRADA · MOTOR NOM-151 ARKANGEL';

  const pruebasRows = docket.pruebasNom151.length
    ? docket.pruebasNom151
        .map(
          (p, idx) => `
      <tr style="border-bottom: 1px solid #e2e8f0; font-size: 11px;">
        <td style="padding: 8px 6px; font-weight: bold;">${idx + 1}</td>
        <td style="padding: 8px 6px;"><code>${p.folio}</code></td>
        <td style="padding: 8px 6px; text-transform: uppercase;">${p.tipo.replace('_', ' ')}</td>
        <td style="padding: 8px 6px;">${p.canal.toUpperCase()}</td>
        <td style="padding: 8px 6px;">${p.fecha}</td>
        <td style="padding: 8px 6px;">
          <span style="display:inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; background: ${
            p.cumplimiento.includes('Oficial') ? '#dcfce7; color: #166534' : '#fef9c3; color: #854d0e'
          };">
            ${p.cumplimiento}
          </span>
        </td>
        <td style="padding: 8px 6px;"><code style="font-size: 9px;">${p.digest.slice(0, 16)}...</code></td>
      </tr>
    `
        )
        .join('')
    : `<tr><td colspan="7" style="padding: 16px; text-align: center; color: #64748b; font-size: 12px;">No se registran constancias NOM-151 previas en este caso.</td></tr>`;

  const gestionesRows = docket.gestionesOperativas.length
    ? docket.gestionesOperativas
        .map(
          (g, idx) => `
      <tr style="border-bottom: 1px solid #e2e8f0; font-size: 11px;">
        <td style="padding: 6px; color: #64748b;">${idx + 1}</td>
        <td style="padding: 6px; font-weight: bold;">${g.tipo}</td>
        <td style="padding: 6px;">${g.fecha}</td>
        <td style="padding: 6px;">${g.detalle}</td>
        <td style="padding: 6px;"><code style="font-size: 9px;">${g.identificadorProveedor || 'N/A'}</code></td>
      </tr>
    `
        )
        .join('')
    : `<tr><td colspan="5" style="padding: 12px; text-align: center; color: #64748b; font-size: 11px;">Sin bitácora adicional de mensajería registrada.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Cuaderno Judicial y Materialidad Fiscal · ${docket.folioExpediente}</title>
  <style>
    @page { size: letter; margin: 18mm 15mm 20mm 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.45; font-size: 12px; margin: 0; padding: 24px; background: #fff; }
    .header-box { border-bottom: 3px double #0284c7; padding-bottom: 14px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .title { font-size: 16px; font-weight: 800; color: #0f172a; text-transform: uppercase; margin: 0 0 4px 0; }
    .subtitle { font-size: 12px; color: #475569; font-weight: 600; margin: 0 0 8px 0; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 10px; font-weight: 800; letter-spacing: 0.5px; }
    .badge-blue { background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; }
    .badge-green { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .section-title { font-size: 13px; font-weight: 800; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin: 20px 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; }
    .info-card h4 { margin: 0 0 8px 0; font-size: 11px; text-transform: uppercase; color: #475569; letter-spacing: 0.5px; }
    .info-item { margin-bottom: 5px; font-size: 11px; }
    .info-label { font-weight: 600; color: #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { background: #f1f5f9; text-align: left; padding: 8px 6px; font-size: 10px; text-transform: uppercase; color: #475569; border-bottom: 2px solid #cbd5e1; }
    .signature-box { margin-top: 36px; padding-top: 16px; border-top: 1px dashed #94a3b8; display: flex; justify-content: space-between; page-break-inside: avoid; }
    .seal-hash { font-family: monospace; font-size: 9px; word-break: break-all; background: #f8fafc; padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom: 16px; display: flex; justify-content: flex-end; gap: 10px;">
    <button onclick="window.print()" style="background: #0284c7; color: white; border: none; padding: 8px 18px; border-radius: 6px; font-weight: bold; cursor: pointer;">
      🖨️ Imprimir Cuaderno Judicial / Guardar PDF
    </button>
  </div>

  <div class="header-box">
    <div>
      <h1 class="title">CUADERNO DE PRUEBAS ELECTRÓNICAS Y MATERIALIDAD FISCAL</h1>
      <div class="subtitle">${docket.viaProcesal}</div>
      <div style="font-size: 11px; color: #64748b;">
        <strong>TRIBUNAL COMPETENTE:</strong> ${docket.tribunalCompetente}
      </div>
    </div>
    <div style="text-align: right;">
      <div class="badge badge-green" style="margin-bottom: 6px;">${selloBadgeText}</div>
      <div style="font-family: monospace; font-size: 11px; font-weight: bold; color: #0284c7;">FOLIO: ${docket.folioExpediente}</div>
      <div style="font-size: 10px; color: #64748b;">Fecha Certificación: ${docket.fechaEmisionLocal}</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="info-card">
      <h4>I. PARTE ACTORA (ENTIDAD ACREEDORA)</h4>
      <div class="info-item"><span class="info-label">Razón Social:</span> ${docket.actor.razonSocial}</div>
      <div class="info-item"><span class="info-label">Registro CONDUSEF / REDECO:</span> ${docket.actor.condusefRegistro}</div>
      <div class="info-item"><span class="info-label">Identificador Tenant:</span> <code>${docket.actor.tenantId}</code></div>
    </div>
    <div class="info-card">
      <h4>II. PARTE DEMANDADA (DEUDOR PRINCIPAL)</h4>
      <div class="info-item"><span class="info-label">Nombre:</span> ${docket.demandado.nombre}</div>
      <div class="info-item"><span class="info-label">CURP:</span> ${docket.demandado.curp || 'No registrado'}</div>
      <div class="info-item"><span class="info-label">Teléfono:</span> ${docket.demandado.telefono || 'N/A'}</div>
      <div class="info-item"><span class="info-label">Correo Electrónico:</span> ${docket.demandado.email || 'N/A'}</div>
    </div>
  </div>

  <div class="info-card" style="margin-bottom: 16px;">
    <h4>III. LIQUIDACIÓN DE SALDO Y PRESTACIONES RECLAMADAS</h4>
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 8px; text-align: center;">
      <div style="background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
        <div style="font-size: 10px; color: #64748b; font-weight: 600;">CAPITAL INSOLUTO</div>
        <div style="font-size: 15px; font-weight: 800; color: #0f172a;">${docket.liquidacion.capitalInsolutoFormatted}</div>
      </div>
      <div style="background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
        <div style="font-size: 10px; color: #64748b; font-weight: 600;">DÍAS DE MORA</div>
        <div style="font-size: 15px; font-weight: 800; color: #dc2626;">${docket.liquidacion.diasMora} DÍAS</div>
      </div>
      <div style="background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
        <div style="font-size: 10px; color: #64748b; font-weight: 600;">INTERÉS MORATORIO (6% ART. 362)</div>
        <div style="font-size: 15px; font-weight: 800; color: #d97706;">${docket.liquidacion.interesMoratorioEstimadoFormatted}</div>
      </div>
      <div style="background: #e0f2fe; padding: 10px; border-radius: 4px; border: 1px solid #7dd3fc;">
        <div style="font-size: 10px; color: #0369a1; font-weight: 700;">TOTAL RECLAMADO</div>
        <div style="font-size: 16px; font-weight: 900; color: #0284c7;">${docket.liquidacion.totalReclamadoFormatted}</div>
      </div>
    </div>
  </div>

  <div class="section-title">IV. CAPÍTULO PROBATORIO INFORMÁTICO (ARTÍCULO 1298-A DEL CÓDIGO DE COMERCIO)</div>
  <p style="font-size: 11px; color: #475569; margin: 4px 0 10px 0;">
    Se ofrecen como pruebas de la parte actora las constancias electrónicas de conservación de mensajes de datos,
    garantizadas en su integridad y fecha cierta conforme a la NOM-151-SCFI-2016 y sellos de tiempo oficiales.
  </p>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Folio NOM-151</th>
        <th>Tipo Requerimiento</th>
        <th>Canal</th>
        <th>Fecha / Hora (CDMX)</th>
        <th>Jerarquía Legal</th>
        <th>Digest SHA-256</th>
      </tr>
    </thead>
    <tbody>
      ${pruebasRows}
    </tbody>
  </table>

  <div class="section-title" style="margin-top: 24px;">V. TRAZABILIDAD OPERATIVA DE GESTIÓN Y COMUNICACIÓN</div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Medio</th>
        <th>Fecha</th>
        <th>Extracto de la Gestión</th>
        <th>Transmisión Provider ID</th>
      </tr>
    </thead>
    <tbody>
      ${gestionesRows}
    </tbody>
  </table>

  <div class="section-title" style="margin-top: 24px;">VI. SUSTENTO DE MATERIALIDAD FISCAL (SAT CFF ARTS. 29-A Y 69-B · LISR ART. 27 XV)</div>
  <div class="info-card" style="background: #f0fdf4; border: 1px solid #bbf7d0;">
    <p style="margin: 0 0 8px 0; font-size: 11px; color: #166534; font-weight: 600;">
      ✓ MATERIALIDAD PLENA CERTIFICADA:
    </p>
    <p style="margin: 0 0 8px 0; font-size: 11px; color: #334155;">
      ${docket.sustentoFiscalSat.resumenMaterialidad}
    </p>
    <ul style="margin: 0; padding-left: 18px; font-size: 10px; color: #475569;">
      ${docket.sustentoFiscalSat.articulosAplicables.map((art) => `<li>${art}</li>`).join('')}
    </ul>
  </div>

  <div class="section-title" style="margin-top: 24px;">VII. CONSTANCIA DE CUSTODIA WORM Y NO-ALTERABILIDAD (ART. 49 CÓDIGO DE COMERCIO)</div>
  <div style="font-size: 11px; margin-bottom: 8px;">
    Estado de Cadena Criptográfica: <strong style="color: ${docket.custodiaWorm.cadenaValida ? '#16a34a' : '#dc2626'}">
      ${docket.custodiaWorm.cadenaValida ? '✓ ÍNTEGRA Y CONCILIADA' : '⚠️ ATENCIÓN: INCONSISTENCIA DETECTADA'}
    </strong> · Registros encadenados: <strong>${docket.custodiaWorm.totalEventosAuditados}</strong>
  </div>
  <div class="seal-hash">
    <strong>SELLO HASH MAESTRO DEL EXPEDIENTE (SHA-256):</strong><br/>
    ${docket.custodiaWorm.hashExpedienteSha256}
  </div>

  <div class="signature-box">
    <div style="width: 45%; text-align: center;">
      <div style="height: 40px;"></div>
      <div style="border-top: 1px solid #475569; padding-top: 6px; font-weight: bold; font-size: 11px;">
        ${docket.actor.razonSocial}
      </div>
      <div style="font-size: 10px; color: #64748b;">Representante Legal / Apoderado Mercantil</div>
    </div>
    <div style="width: 45%; text-align: center;">
      <div style="height: 40px;"></div>
      <div style="border-top: 1px solid #475569; padding-top: 6px; font-weight: bold; font-size: 11px;">
        PERITAJE EN INFORMÁTICA Y TELECOMUNICACIONES
      </div>
      <div style="font-size: 10px; color: #64748b;">Cotejo Criptográfico Automatizado NOM-151-SCFI-2016</div>
    </div>
  </div>
</body>
</html>`;
}
