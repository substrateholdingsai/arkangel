/**
 * API del módulo contable, mapa de cuentas por tenant (Fase 6) y reporte diario.
 *
 * · `GET /api/v1/contabilidad/resumen?fecha=YYYY-MM-DD[&live=1]` devuelve el
 *   corte publicado en R2 o lo calcula en vivo desde D1 cuando se pasa `live=1`.
 * · `GET/PUT /api/v1/tenant/accounting-map` gestiona el catálogo de cuentas
 *   contables de Alegra por despacho (`tenant_accounting_map`).
 * · `GET /api/v1/reports/daily` y `POST /api/v1/reports/daily/send` generan y
 *   envían por correo el Reporte Ejecutivo Diario Automatizado.
 */

import { Hono } from 'hono';
import { remitenteAuth } from '../auth/email';
import { exigeTenant } from '../auth/guards';
import type { AuthVars } from '../auth/middleware';
import { emailIsValid, listTenantMembers, normalizaEmail } from '../auth/native';
import {
  buildAccountingPayload,
  diaPrevioIso,
  SQL_MAP_CONTABLE,
  type MapaContable,
} from '../contabilidad/buildPayload';
import type { TipoAsiento } from '../contabilidad/schemas';
import { leerPayloadDesdeR2, leerUltimoPayload } from '../contabilidad/sendToAlegra';
import { configLegal } from '../legal/config';
import { logger } from '../lib/logger';
import { formatMXN } from '../lib/money';
import { todayIso } from '../services/db';
import { logEvent } from '../services/eventos';
import { resumenCumplimiento } from '../services/legalAudit';
import { dailyMetrics } from '../services/metricas';
import type { TenantContext } from '../tenancy/types';
import type { Env } from '../types/env';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';

export const contabilidad = new Hono<{ Bindings: Env; Variables: AuthVars }>();

export interface AccountingMapRule {
  regla_id: string;
  cuenta_debito: string;
  cuenta_credito: string;
  tipo_asiento: TipoAsiento;
  descripcion: string;
}

export const DEFAULT_ACCOUNTING_MAP: AccountingMapRule[] = [
  {
    regla_id: '1.1',
    cuenta_debito: '5101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'provision',
    descripcion: 'Provisión por usurpación de identidad corporativa',
  },
  {
    regla_id: '1.2',
    cuenta_debito: '5101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'provision',
    descripcion: 'Provisión por representación sin poder legal',
  },
  {
    regla_id: '2.1',
    cuenta_debito: '5101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'provision',
    descripcion: 'Provisión por amenaza de cobranza fuera de proceso',
  },
  {
    regla_id: '2.3',
    cuenta_debito: '5101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'provision',
    descripcion: 'Provisión por hostigamiento continuo',
  },
  {
    regla_id: '2.4',
    cuenta_debito: '6101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'gasto',
    descripcion: 'Gasto por contacto en horario prohibido (NOM-184)',
  },
  {
    regla_id: '3.1',
    cuenta_debito: '5101-002',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por smishing y suplantación de la entidad',
  },
  {
    regla_id: '3.2',
    cuenta_debito: '5101-002',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por destino de pago no trazable',
  },
  {
    regla_id: '4.2',
    cuenta_debito: '5101-001',
    cuenta_credito: '1102-003',
    tipo_asiento: 'provision',
    descripcion: 'Provisión por interés sobre interés no pactado',
  },
  {
    regla_id: '4.4',
    cuenta_debito: '5101-002',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por extorsión vía contactos',
  },
  {
    regla_id: '5.2',
    cuenta_debito: '5101-003',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por simulación de orden judicial',
  },
  {
    regla_id: '8.1',
    cuenta_debito: '5101-003',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por monto contrato vs CRM',
  },
  {
    regla_id: '8.7',
    cuenta_debito: '5101-003',
    cuenta_credito: '1102-003',
    tipo_asiento: 'contingencia',
    descripcion: 'Contingencia por falsedad de registros CRM',
  },
];

/**
 * Obtiene el mapa contable del despacho; si el despacho es nuevo y no tiene
 * filas en `tenant_accounting_map`, siembra automáticamente las 12 reglas base.
 */
export async function ensureTenantAccountingMap(ctx: TenantContext): Promise<AccountingMapRule[]> {
  try {
    const res = await ctx.env.DB.prepare(SQL_MAP_CONTABLE).bind(ctx.tenantId).all<MapaContable>();
    const existing = res.results ?? [];
    if (existing.length > 0) {
      return existing
        .map((r) => ({
          regla_id: r.regla_id,
          cuenta_debito: r.cuenta_debito,
          cuenta_credito: r.cuenta_credito,
          tipo_asiento: (r.tipo_asiento as TipoAsiento) || 'contingencia',
          descripcion: r.descripcion ?? '',
        }))
        .sort((a, b) => a.regla_id.localeCompare(b.regla_id, undefined, { numeric: true }));
    }

    for (const item of DEFAULT_ACCOUNTING_MAP) {
      await ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_accounting_map (tenant_id, regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          ctx.tenantId,
          item.regla_id,
          item.cuenta_debito,
          item.cuenta_credito,
          item.tipo_asiento,
          item.descripcion
        )
        .run();
    }
    return [...DEFAULT_ACCOUNTING_MAP];
  } catch {
    return [...DEFAULT_ACCOUNTING_MAP];
  }
}

/**
 * El resumen contable exige `accounting:read`.
 *
 * Ojo: `accounting:read` no está en `service_readonly` (sí en `viewer`): el
 * corte contable de un cliente es información sensible de negocio y no se
 * abre al rol de sólo lectura de los servicios.
 */
contabilidad.get('/contabilidad/resumen', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'accounting:read');
  if (!guardia.ok) return guardia.response;

  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const pedida = c.req.query('fecha');
  const live = c.req.query('live') === '1' || c.req.query('live') === 'true';

  if (pedida && !/^\d{4}-\d{2}-\d{2}$/.test(pedida)) {
    return c.json({ error: 'fecha_invalida', detalle: 'usa YYYY-MM-DD' }, 400);
  }

  // Modo en vivo: calcula el corte al vuelo sobre D1 (sin esperar al cron de medianoche)
  if (live) {
    const fechaLive = pedida || todayIso(ctx.config.tz);
    await ensureTenantAccountingMap(ctx);
    const payload = await buildAccountingPayload(ctx, fechaLive);
    return c.json({ ok: true, source: 'live', ...payload });
  }

  // Sin fecha: se devuelve el último corte publicado (el cron publica con un
  // día de rezago, así que "ayer" todavía no existe como payload).
  if (!pedida) {
    const ultimo = await leerUltimoPayload(ctx);
    if (!ultimo) {
      return c.json(
        {
          error: 'sin_payload',
          fecha_corte: diaPrevioIso(ctx.config.tz),
          detalle: 'el cron contable todavía no publicó ningún corte',
        },
        404
      );
    }
    return c.json({ ok: true, source: 'r2', ...ultimo.payload });
  }

  const payload = await leerPayloadDesdeR2(ctx, pedida);
  if (!payload) {
    return c.json(
      {
        error: 'sin_payload',
        fecha_corte: pedida,
        detalle: 'el cron contable todavía no generó el corte de esa fecha',
      },
      404
    );
  }

  return c.json({ ok: true, source: 'r2', ...payload });
});

/**
 * Mapa Contable por Tenant (Fase 6 Multi-Tenant):
 *   · `GET /api/v1/tenant/accounting-map`: devuelve las 12 reglas y sus cuentas Alegra.
 *   · `PUT /api/v1/tenant/accounting-map`: actualiza cuentas débito/crédito y tipo de asiento.
 */
contabilidad.get('/tenant/accounting-map', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'accounting:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const rules = await ensureTenantAccountingMap(ctx);
  return c.json({ ok: true, tenant_id: ctx.tenantId, rules });
});

contabilidad.put('/tenant/accounting-map', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'legal:config');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const body = (await c.req.json().catch(() => ({}))) as { rules?: unknown };
  if (!Array.isArray(body.rules) || body.rules.length === 0) {
    return c.json(
      { ok: false, error: 'Se requiere el arreglo rules con las cuentas contables.' },
      400
    );
  }

  await ensureTenantAccountingMap(ctx);

  let updatedCount = 0;
  for (const raw of body.rules) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const reglaId = typeof item.regla_id === 'string' ? item.regla_id.trim() : '';
    const cuentaDebito = typeof item.cuenta_debito === 'string' ? item.cuenta_debito.trim() : '';
    const cuentaCredito = typeof item.cuenta_credito === 'string' ? item.cuenta_credito.trim() : '';
    const tipoAsiento: TipoAsiento =
      item.tipo_asiento === 'provision' ||
      item.tipo_asiento === 'gasto' ||
      item.tipo_asiento === 'contingencia'
        ? item.tipo_asiento
        : 'contingencia';
    const descripcion =
      typeof item.descripcion === 'string' ? item.descripcion.trim().slice(0, 200) : '';

    if (!reglaId || !cuentaDebito || !cuentaCredito) continue;

    await ctx.env.DB.prepare(
      `INSERT INTO tenant_accounting_map (tenant_id, regla_id, cuenta_debito, cuenta_credito, tipo_asiento, descripcion)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, regla_id) DO UPDATE SET
         cuenta_debito = excluded.cuenta_debito,
         cuenta_credito = excluded.cuenta_credito,
         tipo_asiento = excluded.tipo_asiento,
         descripcion = CASE WHEN excluded.descripcion != '' THEN excluded.descripcion ELSE tenant_accounting_map.descripcion END`
    )
      .bind(ctx.tenantId, reglaId, cuentaDebito, cuentaCredito, tipoAsiento, descripcion)
      .run();
    updatedCount += 1;
  }

  await logEvent(ctx, 'tenant.mapa_contable_actualizado', {
    payload: {
      actor: guardia.principal.actorId,
      updatedCount,
    },
  });

  const rules = await ensureTenantAccountingMap(ctx);
  return c.json({ ok: true, tenant_id: ctx.tenantId, updated: updatedCount, rules });
});

/**
 * Reporte Ejecutivo Diario Automatizado (`GET /api/v1/reports/daily` y `POST /api/v1/reports/daily/send`).
 * Consolida métricas operativas de cobranza, cumplimiento legal CONDUSEF y corte contable.
 */
export async function buildDailyExecutiveReport(ctx: TenantContext, date: string) {
  await ensureTenantAccountingMap(ctx);
  const [metrics, legalSummary, accounting] = await Promise.all([
    dailyMetrics(ctx, date),
    resumenCumplimiento(ctx, date),
    buildAccountingPayload(ctx, date),
  ]);

  const legal = configLegal(ctx);

  return {
    date,
    tenant: {
      id: ctx.tenantId,
      nombre: ctx.tenant.nombre,
      razon_social: legal.nombreLegal || null,
      condusef: legal.condusef || null,
    },
    operacion: {
      total_casos: metrics.total,
      mensajes_enviados: metrics.enviadas,
      casos_contestados: metrics.contestadas,
      promesas_registradas: metrics.promesas,
      monto_prometido_cents: metrics.monto_prometido_cents,
      monto_cobrado_cents: metrics.monto_cobrado_cents,
      escalados_humano: metrics.por_estado?.human ?? 0,
      en_cola_ready: metrics.por_estado?.ready ?? 0,
    },
    cumplimiento_legal: {
      total_auditorias: legalSummary.total,
      bloqueos: legalSummary.bloqueos,
      saneos: legalSummary.saneos,
      escalados: legalSummary.escalados,
      por_regla: legalSummary.porRegla,
    },
    contabilidad: {
      idempotency_key: accounting.idempotency_key,
      ledger_verificado: accounting.ledger_integrity.verificado,
      ledger_hash_ultimo: accounting.ledger_integrity.hash_ultimo_registro,
      ledger_total_registros: accounting.ledger_integrity.total_registros,
      ingresos_reconocidos_mxn: accounting.resumen.ingresos_reconocidos,
      provision_cartera_ilegal_mxn: accounting.resumen.provision_cartera_ilegal,
      ingresos_bloqueados_mxn: accounting.resumen.ingresos_no_reconocidos_por_bloqueo,
      iva_trasladado_mxn: accounting.resumen.iva_trasladado,
      iva_acreditable_estimado_mxn: accounting.resumen.iva_acreditable_estimado,
      total_asientos: accounting.asientos.length,
    },
  };
}

contabilidad.get('/reports/daily', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'metrics:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const pedida = c.req.query('date');
  if (pedida && !/^\d{4}-\d{2}-\d{2}$/.test(pedida)) {
    return c.json({ error: 'fecha_invalida', detalle: 'usa YYYY-MM-DD' }, 400);
  }
  const date = pedida || todayIso(ctx.config.tz);
  const report = await buildDailyExecutiveReport(ctx, date);

  return c.json({ ok: true, report });
});

contabilidad.post('/reports/daily/send', async (c) => {
  const guardia = await exigePrincipalConScope(c, 'metrics:read');
  if (!guardia.ok) return guardia.response;
  const resultado = await tenantContextDeRequest(c, guardia.principal, guardia.origen);
  if (!resultado.ok) return resultado.response;
  const ctx = resultado.ctx;
  const denegado = exigeTenant(guardia.principal, ctx.tenantId);
  if (denegado) return denegado;

  const body = (await c.req.json().catch(() => ({}))) as { date?: string; to?: string };
  const date =
    typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : todayIso(ctx.config.tz);

  const report = await buildDailyExecutiveReport(ctx, date);

  let recipients: string[] = [];
  if (typeof body.to === 'string' && emailIsValid(normalizaEmail(body.to))) {
    recipients = [normalizaEmail(body.to)];
  } else {
    const members = await listTenantMembers(ctx.env, ctx.tenantId);
    recipients = members
      .filter((m) => m.role === 'owner' && emailIsValid(m.email))
      .map((m) => m.email);
  }

  let emailSent = false;
  const apiKey = ctx.env.RESEND_API_KEY?.trim() ?? '';
  const from = remitenteAuth(ctx.env).trim();

  if (apiKey && from && recipients.length > 0) {
    const subject = `Reporte Ejecutivo Diario · ${report.tenant.nombre} (${report.date})`;
    const textBody = [
      `REPORTE EJECUTIVO DIARIO — ${report.tenant.nombre} (${report.date})`,
      `Razón Social: ${report.tenant.razon_social ?? 'Sin configurar'} · CONDUSEF: ${report.tenant.condusef ?? 'N/A'}`,
      '',
      '1. OPERACIÓN Y COBRANZA',
      `• Casos del día: ${report.operacion.total_casos}`,
      `• Mensajes enviados: ${report.operacion.mensajes_enviados}`,
      `• Promesas de pago: ${report.operacion.promesas_registradas} (${formatMXN(report.operacion.monto_prometido_cents)})`,
      `• Monto cobrado / conciliado: ${formatMXN(report.operacion.monto_cobrado_cents)}`,
      `• Escalados a humano: ${report.operacion.escalados_humano}`,
      '',
      '2. CUMPLIMIENTO LEGAL (MOTOR CONDUSEF / NOM-184)',
      `• Auditorías ejecutadas: ${report.cumplimiento_legal.total_auditorias}`,
      `• Bloqueos preventivos: ${report.cumplimiento_legal.bloqueos}`,
      `• Saneos automáticos: ${report.cumplimiento_legal.saneos}`,
      '',
      '3. CORTE CONTABLE Y LEDGER',
      `• Estado del Ledger: ${report.contabilidad.ledger_verificado ? 'VERIFICADO' : 'ALERTA DE INTEGRIDAD'}`,
      `• Ingresos reconocidos: $${report.contabilidad.ingresos_reconocidos_mxn.toFixed(2)} MXN`,
      `• Provisión cartera ilegal: $${report.contabilidad.provision_cartera_ilegal_mxn.toFixed(2)} MXN`,
      `• Pólizas Alegra generadas: ${report.contabilidad.total_asientos}`,
    ].join('\n');

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: recipients,
          subject,
          text: textBody,
        }),
      });
      emailSent = response.ok;
    } catch (error) {
      logger.error('Error enviando reporte ejecutivo diario por Resend', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await logEvent(ctx, 'reporte.diario_enviado', {
    payload: {
      actor: guardia.principal.actorId,
      date,
      recipients,
      emailSent,
    },
  });

  return c.json({
    ok: true,
    email_sent: emailSent,
    recipients,
    report,
  });
});
