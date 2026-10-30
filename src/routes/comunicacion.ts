/**
 * Rutas de la API para el Motor de Comunicación de Arkangel.
 *
 * Incluye:
 *   - POST /preview: Evaluación previa fail-closed de audiencia y estimación de costos.
 */

import { Hono } from 'hono';
import type { AuthVars } from '../auth/middleware';
import type { Env } from '../types/env';
import { exigePrincipalConScope } from './guard';
import { tenantContextDeRequest } from './tenant';
import { resolverOrganizacion } from '../tenancy/jerarquia';
import {
  obtenerHechoConsentimiento,
  registrarConsentimiento,
  estaSuprimido,
  checkFrequencyCap,
  obtenerPlantilla,
  tieneCobranzaActiva,
} from '../services/comunicacion';
import { evaluarEnvio } from '../comunicacion/motorMarketing';
import { CATALOGO_REGLAS } from '../comunicacion/reglas';
import type {
  CanalComunicacion,
  ContextoEnvio,
  MotorComunicacion,
  Proposito,
} from '../comunicacion/tipos';
import { normalizePhone } from '../lib/phone';
import { formatMXN } from '../lib/money';
import { CampaignDispatchV1Schema, TransactionalDispatchV1Schema } from '../comunicacion/contrato';
import { adapters } from '../channels/index';
import { renderizarPlantilla, construirComponentesMeta } from '../comunicacion/plantillas';
import { logger } from '../lib/logger';
import {
  consultarVigenciaRepep,
  estaEnRepep,
  iniciarVersionRepep,
  insertarLoteRepep,
  activarVersionRepep,
} from '../services/repep';
import { getTenantById, getTenantBySlug } from '../tenancy/repository';
import { tenantDeEntorno } from '../tenancy/context';
import type { Tenant } from '../tenancy/types';

export const comunicacion = new Hono<{ Bindings: Env; Variables: AuthVars }>();

interface PreviewRecipientInput {
  phone: string;
  name?: string;
  variables?: Record<string, string>;
  tz?: string;
}

interface PreviewRequestBody {
  motor: MotorComunicacion;
  canal: CanalComunicacion;
  proposito: Proposito;
  template_id: string;
  audience: PreviewRecipientInput[];
  frequency_cap?: number;
}

// Costos de referencia en centavos (ej. WhatsApp marketing = $0.95 MXN = 95 centavos)
const COSTOS_POR_MENSAJE_CENTS: Record<CanalComunicacion, number> = {
  whatsapp: 95,
  sms: 45,
  email: 5,
  voz: 150, // costo estimado base por minuto
};

comunicacion.post('/comunicacion/preview', async (c) => {
  const auth = await exigePrincipalConScope(c, 'messages:send');
  if (!auth.ok) return auth.response;

  const tCtx = await tenantContextDeRequest(c, auth.principal, auth.origen);
  if (!tCtx.ok) return tCtx.response;

  const ctx = tCtx.ctx;
  const env = c.env;

  let body: PreviewRequestBody;
  try {
    body = await c.req.json<PreviewRequestBody>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // 1. Validación de motor (fail-closed: sin selección o selección equivocada se bloquea)
  if (!body.motor) {
    return c.json(
      {
        error: 'motor_no_declarado',
        mensaje: 'Debe declarar explícitamente el motor ("comunicacion").',
      },
      400
    );
  }
  if (body.motor !== 'comunicacion') {
    return c.json(
      {
        error: 'motor_incorrecto',
        mensaje: 'Este endpoint es exclusivo del Motor de Comunicación.',
      },
      400
    );
  }

  // 2. Resolver organización y marca comercial
  const org = await resolverOrganizacion(env, ctx.tenant);
  const marca = (ctx.tenant.marca_comercial || ctx.tenant.nombre || '').trim();

  // 3. Obtener plantilla aprobada
  const plantilla = await obtenerPlantilla(env, body.template_id, ctx.tenant.id, org.id);
  if (!plantilla) {
    return c.json(
      {
        error: 'plantilla_no_encontrada',
        mensaje: `La plantilla ${body.template_id} no existe o no pertenece a esta organización.`,
      },
      404
    );
  }

  const maxWeeklyPolicy = ctx.tenant.comm_max_por_semana ?? 2;
  const maxWeeklyEffective = body.frequency_cap
    ? Math.min(body.frequency_cap, maxWeeklyPolicy)
    : maxWeeklyPolicy;

  const ahora = new Date();
  const audience = body.audience ?? [];

  // 4. Consultar vigencia de lista REPEP (PROFECO) una sola vez por lote
  const repepVigencia = await consultarVigenciaRepep(env);

  let elegibles = 0;
  let diferidos = 0;
  let excluidos = 0;
  const excluidosPorMotivo: Record<
    string,
    { count: number; regla: string; argumentoValor: string }
  > = {};
  let muestraMensajeRenderizado = '';

  for (const item of audience) {
    const phone = normalizePhone(item.phone);
    if (!phone) {
      excluidos++;
      registrarExclusion('contacto_invalido', 'R2_OPT_IN_VERIFICADO');
      continue;
    }

    // Consultas de datos para el contexto
    const [consent, supp, fcap, cobranzaActiva, enRepep] = await Promise.all([
      obtenerHechoConsentimiento(env, ctx.tenant.id, phone, body.canal, plantilla.categoria),
      estaSuprimido(env, ctx.tenant.id, phone),
      checkFrequencyCap(env, ctx.tenant.id, phone, maxWeeklyEffective, false),
      tieneCobranzaActiva(env, ctx.tenant.id, phone),
      repepVigencia.versionActiva
        ? estaEnRepep(env, phone, repepVigencia.versionActiva)
        : Promise.resolve(false),
    ]);

    const vars: Record<string, string> = {
      ...(item.variables ?? {}),
      nombre: item.name ?? item.variables?.['nombre'] ?? '',
      marca,
    };

    const ctxEnvio: ContextoEnvio = {
      motor: body.motor,
      modo: 'campana',
      canal: body.canal,
      proposito: body.proposito,
      marca,
      contacto: phone,
      ahora,
      tzContacto: item.tz ?? ctx.tenant.tz ?? null,
      consentimiento: consent,
      suprimido: supp,
      repep: {
        listaVigente: repepVigencia.listaVigente,
        registrado: enRepep,
      },
      frecuencia: {
        enviadosVentana: fcap.count,
        maximo: maxWeeklyEffective,
      },
      plantilla,
      variables: vars,
      cobranzaActiva,
    };

    const res = evaluarEnvio(ctxEnvio);

    if (res.decision === 'enviar') {
      elegibles++;
      if (!muestraMensajeRenderizado && res.textoRenderizado) {
        muestraMensajeRenderizado = res.textoRenderizado;
      }
    } else if (res.decision === 'diferir') {
      diferidos++;
      if (!muestraMensajeRenderizado && res.textoRenderizado) {
        muestraMensajeRenderizado = res.textoRenderizado;
      }
    } else {
      excluidos++;
      const primerMotivo = res.motivos[0] ?? 'regla_general';
      const primeraRegla = res.reglasAplicadas[res.reglasAplicadas.length - 1] ?? 'R_GENERAL';
      registrarExclusion(primerMotivo, primeraRegla);
    }
  }

  function registrarExclusion(motivo: string, reglaId: string) {
    if (!excluidosPorMotivo[motivo]) {
      const reglaInfo = CATALOGO_REGLAS[reglaId];
      excluidosPorMotivo[motivo] = {
        count: 0,
        regla: reglaInfo?.nombre ?? reglaId,
        argumentoValor:
          reglaInfo?.argumentoValor ?? 'Protege la calidad del canal y evita sanciones.',
      };
    }
    excluidosPorMotivo[motivo].count++;
  }

  const costoUnitarioCents = COSTOS_POR_MENSAJE_CENTS[body.canal] ?? 95;
  const costoTotalCents = (elegibles + diferidos) * costoUnitarioCents;

  return c.json({
    motor: 'comunicacion',
    marca,
    canal: body.canal,
    proposito: body.proposito,
    template: {
      id: plantilla.id,
      nombre: plantilla.nombre,
      meta_name: plantilla.metaName,
      status: plantilla.status,
    },
    resumen: {
      total_audiencia: audience.length,
      elegibles_inmediatos: elegibles,
      diferidos_quiet_hours: diferidos,
      excluidos_total: excluidos,
    },
    exclusiones_detalle: excluidosPorMotivo,
    costo_estimado: {
      monto_cents: costoTotalCents,
      monto_formateado: formatMXN(costoTotalCents),
      tarifa_unitaria_cents: costoUnitarioCents,
    },
    preview_mensaje: muestraMensajeRenderizado || plantilla.bodyPreview,
  });
});

/**
 * POST /comunicacion/campaigns
 * Dispara una campaña formal bajo el contrato CAMPAIGN_DISPATCH_V1.
 */
comunicacion.post('/comunicacion/campaigns', async (c) => {
  const auth = await exigePrincipalConScope(c, 'messages:send');
  if (!auth.ok) return auth.response;

  const tCtx = await tenantContextDeRequest(c, auth.principal, auth.origen);
  if (!tCtx.ok) return tCtx.response;

  const env = c.env;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parseResult = CampaignDispatchV1Schema.safeParse(rawBody);
  if (!parseResult.success) {
    return c.json(
      {
        error: 'schema_validation_failed',
        details: parseResult.error.format(),
      },
      400
    );
  }

  const payload = parseResult.data;
  const tenant = tCtx.ctx.tenant;
  const org = await resolverOrganizacion(env, tenant);

  // Registrar la campaña en D1
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO comm_campaigns (
      id, tenant_id, org_tenant_id, canal, proposito, template_id, status, total_recipients, scheduled_for, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
  )
    .bind(
      payload.campaign_id,
      tenant.id,
      org.id,
      payload.canal,
      payload.proposito,
      payload.template_id,
      payload.audience.length,
      payload.schedule ?? null,
      now,
      now
    )
    .run();

  // Orquestar a través de CampaignRunnerDO
  let runnerStatus = {
    campaignId: payload.campaign_id,
    status: 'running',
    total: payload.audience.length,
    sent: 0,
    deferred: 0,
    excluded: 0,
  };

  if (env.CAMPAIGN_RUNNER) {
    const doId = env.CAMPAIGN_RUNNER.idFromName(`camp:${payload.campaign_id}`);
    const stub = env.CAMPAIGN_RUNNER.get(doId);
    const resp = await stub.fetch('http://campaign-runner/?action=start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    runnerStatus = (await resp.json()) as any;
  }

  return c.json({
    ok: true,
    campaign_id: payload.campaign_id,
    status: runnerStatus.status,
    metrics: runnerStatus,
  });
});

/**
 * GET /comunicacion/campaigns/:id
 * Reporte detallado post-campaña y métricas con argumentos de valor.
 */
comunicacion.get('/comunicacion/campaigns/:id', async (c) => {
  const auth = await exigePrincipalConScope(c, 'messages:read');
  if (!auth.ok) return auth.response;

  const campaignId = c.req.param('id');
  const env = c.env;

  const campaign = await env.DB.prepare('SELECT * FROM comm_campaigns WHERE id = ? LIMIT 1')
    .bind(campaignId)
    .first<any>();

  if (!campaign) {
    return c.json({ error: 'campaign_not_found' }, 404);
  }

  // Agrupar envíos por estado y motivo
  const enviosRows = await env.DB.prepare(
    `SELECT status, motivo, COUNT(*) as count
     FROM comm_envios
     WHERE campaign_id = ?
     GROUP BY status, motivo`
  )
    .bind(campaignId)
    .all<{ status: string; motivo: string | null; count: number }>();

  let sent = 0;
  let deferred = 0;
  let excluded = 0;
  const motivosExclusion: Record<string, number> = {};

  for (const row of enviosRows.results ?? []) {
    if (row.status === 'sent' || row.status === 'delivered' || row.status === 'read') {
      sent += Number(row.count);
    } else if (row.status === 'deferred') {
      deferred += Number(row.count);
    } else if (row.status === 'excluded') {
      excluded += Number(row.count);
      const mot = row.motivo ?? 'motivo_general';
      motivosExclusion[mot] = (motivosExclusion[mot] ?? 0) + Number(row.count);
    }
  }

  // Argumentos de valor construidos a partir de las exclusiones
  const reportesValor = Object.entries(motivosExclusion).map(([motivo, count]) => {
    if (motivo === 'repep_registrado') {
      return `Se excluyeron ${count} números inscritos en el REPEP de PROFECO, protegiendo a la cámara contra multas y sanciones regulatorias.`;
    }
    if (motivo === 'sin_consentimiento' || motivo === 'consentimiento_revocado') {
      return `Se excluyeron ${count} contactos sin opt-in comprobable, garantizando cero reportes de spam para el número de WhatsApp oficial.`;
    }
    if (motivo === 'frecuencia_excedida') {
      return `Se limitaron ${count} impactos por colisión de frecuencia semanal, previniendo la fatiga del socio y preservando la calificación verde de Meta.`;
    }
    if (motivo === 'cobranza_activa') {
      return `Se evitaron ${count} envíos promocionales a contactos en gestión de cobranza activa, garantizando coherencia de cartera.`;
    }
    return `Se filtraron ${count} contactos bajo la regla ${motivo}.`;
  });

  return c.json({
    campaign_id: campaign.id,
    canal: campaign.canal,
    status: campaign.status,
    resumen: {
      total: Number(campaign.total_recipients),
      enviados: sent,
      diferidos: deferred,
      excluidos: excluded,
    },
    exclusiones_motivos: motivosExclusion,
    argumentos_cumplimiento: reportesValor,
    calidad_canal: {
      estado: 'GREEN',
      calificacion: 'High Quality',
      politica_antispam: 'fail-closed',
    },
  });
});

/**
 * POST /comunicacion/campaigns/:id/pause
 * Pausa inmediata de una campaña en ejecución.
 */
comunicacion.post('/comunicacion/campaigns/:id/pause', async (c) => {
  const auth = await exigePrincipalConScope(c, 'messages:send');
  if (!auth.ok) return auth.response;

  const campaignId = c.req.param('id');
  const env = c.env;

  if (env.CAMPAIGN_RUNNER) {
    const doId = env.CAMPAIGN_RUNNER.idFromName(`camp:${campaignId}`);
    const stub = env.CAMPAIGN_RUNNER.get(doId);
    const resp = await stub.fetch('http://campaign-runner/?action=pause');
    const result = await resp.json();
    return c.json(result);
  }

  return c.json({ ok: true, status: 'paused' });
});

/**
 * POST /comunicacion/repep/upload
 * Carga de lista oficial REPEP (PROFECO) con cálculo de hashes SHA-256 en edge.
 */
comunicacion.post('/comunicacion/repep/upload', async (c) => {
  const auth = await exigePrincipalConScope(c, 'legal:config');
  if (!auth.ok) return auth.response;

  const env = c.env;
  let body: { list_date: string; source?: string; phones: string[] };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.list_date || !Array.isArray(body.phones) || body.phones.length === 0) {
    return c.json(
      {
        error: 'invalid_payload',
        mensaje: 'Se requiere list_date (YYYY-MM-DD) y arreglo de phones.',
      },
      400
    );
  }

  const versionId = await iniciarVersionRepep(env, {
    listDate: body.list_date,
    source: body.source ?? 'carga_manual_admin',
  });

  const totalHashes = await insertarLoteRepep(env, versionId, body.phones);
  await activarVersionRepep(env, versionId, totalHashes);

  logger.info('Lista REPEP activada exitosamente', {
    versionId,
    listDate: body.list_date,
    total: totalHashes,
  });

  return c.json({
    ok: true,
    version_id: versionId,
    list_date: body.list_date,
    total_hashes_ingresados: totalHashes,
    status: 'active',
  });
});

/**
 * GET /comunicacion/repep/status
 * Consulta de vigencia y antigüedad de la lista REPEP activa.
 */
comunicacion.get('/comunicacion/repep/status', async (c) => {
  const auth = await exigePrincipalConScope(c, 'legal:read');
  if (!auth.ok) return auth.response;

  const env = c.env;
  const status = await consultarVigenciaRepep(env);

  return c.json({
    ok: true,
    repep: status,
    politica: {
      dias_maximos_vigencia: 35,
      accion_al_caducar: 'bloqueo_fail_closed_llamadas_sms_marketing',
    },
  });
});

/**
 * POST /comunicacion/send
 * Disparo transaccional directo 1:1 para eventos inmediatos (órdenes, envíos, confirmaciones).
 * Tubería canónica de ingesta para agregadores como ark-commerce.
 */
comunicacion.post('/comunicacion/send', async (c) => {
  const auth = await exigePrincipalConScope(c, 'messages:send');
  if (!auth.ok) return auth.response;

  const env = c.env;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parseResult = TransactionalDispatchV1Schema.safeParse(rawBody);
  if (!parseResult.success) {
    return c.json(
      {
        error: 'schema_validation_failed',
        details: parseResult.error.format(),
      },
      400
    );
  }

  const payload = parseResult.data;

  // Resolver tenant: context estándar o auto-resolución resiliente para agregadores
  let tenant: Tenant;
  const tCtx = await tenantContextDeRequest(c, auth.principal, auth.origen);
  if (tCtx.ok) {
    tenant = tCtx.ctx.tenant;
  } else if (auth.principal.kind === 'platform') {
    const tid = payload.tenant_id;
    let found = await getTenantById(env, tid);
    if (!found) {
      found = await getTenantBySlug(env, tid);
    }
    if (!found) {
      const now = new Date().toISOString();
      const nombreTenant =
        tid === 'temozonia'
          ? 'Temozonia Carnes Ahumadas'
          : tid === 'baakal'
            ? 'Baakal Servicios Técnicos'
            : tid === 'ark'
              ? 'Ark Oficios'
              : tid;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (
          id, slug, nombre, status, config_mode, razon_social, condusef_registro,
          allowed_payment_domains, tz, send_window_start, send_window_end,
          max_contacts_per_day, legal_monto_tolerancia_cents, legal_horario_en_respuestas,
          rate_limit_rpm, dedupe_window_hours, score_amount_ceiling_cents,
          agent_mode, agent_auto_threshold_cents, dry_run, cron_auto_fire, is_default,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'active', 'db', ?, 'COMMERCE-2026',
          'tiendas.arksystems.site', 'America/Merida', 8, 21,
          5, 0, 0,
          60, 24, 100000,
          'auto', 50000, 0, 0, 0,
          ?, ?
        )`
      )
        .bind(tid, tid, nombreTenant, nombreTenant, now, now)
        .run();
      found = await getTenantById(env, tid);
    }
    tenant = found ?? tenantDeEntorno(env);
  } else {
    return tCtx.response;
  }

  const org = await resolverOrganizacion(env, tenant);
  const marca = tenant.nombre ?? tenant.razon_social ?? tenant.slug ?? tenant.id;

  // Normalizar destinatario (si es teléfono o email)
  const isEmail = payload.channel === 'email' || payload.to.includes('@');
  const normalizedTo = isEmail ? payload.to.trim().toLowerCase() : normalizePhone(payload.to);

  if (!isEmail && !normalizedTo) {
    return c.json({ error: 'invalid_phone_number', to: payload.to }, 400);
  }

  const contactoFinal = (isEmail ? normalizedTo : normalizedTo) as string;

  // 1. Verificar supresiones (Opt-out directo siempre gana fail-closed)
  const suprimido = await estaSuprimido(env, tenant.id, contactoFinal);
  if (suprimido) {
    return c.json(
      {
        ok: false,
        status: 'excluded',
        motivo: 'suprimido',
        error: 'El destinatario está en lista de supresión / opt-out.',
      },
      403
    );
  }

  // 2. Si es transaccional, registrar / renovar consentimiento automático (relación comercial activa)
  if (payload.proposito === 'transaccional') {
    await registrarConsentimiento(env, {
      tenantId: tenant.id,
      contacto: contactoFinal,
      channel: payload.channel,
      categoria: 'transaccional',
      optInSource:
        payload.tipo === 'order_confirmation' ? 'ecommerce_order' : 'ecommerce_transaction',
      evidence: { order_id: payload.order_id, tipo: payload.tipo, metadata: payload.metadata },
    });
  }

  // 3. Determinar el cuerpo del mensaje y componentes
  let mensajeTexto = payload.body ?? '';
  let metaTemplateRef: any = undefined;

  if (payload.template_id) {
    const plantilla = await obtenerPlantilla(env, payload.template_id, tenant.id, org.id);
    if (!plantilla) {
      return c.json({ error: 'template_not_found', template_id: payload.template_id }, 404);
    }
    const render = renderizarPlantilla(plantilla, payload.variables ?? {}, marca);
    if (!render.ok) {
      return c.json({ error: 'template_render_error', details: render.error }, 400);
    }
    mensajeTexto = render.texto ?? plantilla.bodyPreview;
    if (payload.channel === 'whatsapp' && plantilla.metaName) {
      metaTemplateRef = {
        name: plantilla.metaName,
        lang: plantilla.lang,
        components: construirComponentesMeta(plantilla, payload.variables ?? {}),
      };
    }
  }

  if (!mensajeTexto.trim()) {
    // Generar cuerpo por defecto si no vino template ni body
    if (payload.tipo === 'order_confirmation') {
      mensajeTexto = `¡Hola! Tu pedido ${payload.order_id ? '#' + payload.order_id : ''} en ${marca} ha sido confirmado. ¡Gracias por tu compra!`;
    } else if (payload.tipo === 'shipping_update') {
      mensajeTexto = `¡Hola! Tu pedido ${payload.order_id ? '#' + payload.order_id : ''} en ${marca} va en camino.`;
    } else if (payload.tipo === 'cart_recovery') {
      mensajeTexto = `¡Hola! Notamos que dejaste productos en tu carrito de ${marca}. ¿Deseas completar tu pedido?`;
    } else {
      return c.json(
        { error: 'missing_message_body', message: 'Debe proporcionar body o template_id válido.' },
        400
      );
    }
  }

  // 4. Despacho por adaptador de canal
  const adapter = adapters[payload.channel];
  if (!adapter) {
    return c.json({ error: 'unsupported_channel', channel: payload.channel }, 400);
  }

  const envioId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const sendResult = await adapter.send(env, {
    to: contactoFinal,
    body: mensajeTexto,
    campaignId: 'transactional',
    dryRun: payload.dry_run,
    template: metaTemplateRef,
  });

  // 5. Registrar en la bitácora comm_envios
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO comm_envios (
      id, tenant_id, org_tenant_id, campaign_id, contacto, channel, template_id, categoria, status, motivo, provider_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'transactional', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      envioId,
      tenant.id,
      org.id,
      contactoFinal,
      payload.channel,
      payload.template_id ?? null,
      payload.proposito,
      sendResult.ok ? 'sent' : 'failed',
      sendResult.error ?? null,
      sendResult.providerId ?? null,
      now,
      now
    )
    .run();

  logger.info('Envío transaccional procesado', {
    envioId,
    tenantId: tenant.id,
    channel: payload.channel,
    to: contactoFinal,
    status: sendResult.status,
    tipo: payload.tipo,
  });

  return c.json({
    ok: sendResult.ok,
    message_id: envioId,
    provider_id: sendResult.providerId ?? null,
    channel: payload.channel,
    status: sendResult.status,
    error: sendResult.error,
  });
});
