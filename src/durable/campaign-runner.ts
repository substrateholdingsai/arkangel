/**
 * CampaignRunnerDO: Orquestador con pacing y alarmas para campañas de comunicación.
 *
 * Sigue el patrón estándar de Arkangel (clase con fetch y constructor ctx/env,
 * sin heredar de DurableObject para permitir pruebas en vitest sin runtime de Workerd).
 */

import type { Env } from '../types/env';
import type { CampaignDispatchV1 } from '../comunicacion/contrato';
import {
  obtenerHechoConsentimiento,
  estaSuprimido,
  checkFrequencyCap,
  obtenerPlantilla,
  tieneCobranzaActiva,
} from '../services/comunicacion';
import { evaluarEnvio } from '../comunicacion/motorMarketing';
import { normalizePhone } from '../lib/phone';
import { getTenantById } from '../tenancy/repository';
import { resolverOrganizacion, canalesEfectivos } from '../tenancy/jerarquia';
import { mergeChannelCredentials } from '../tenancy/channels';
import { sendWhatsApp } from '../channels/whatsapp';
import { sendTelnyxSms } from '../channels/telnyx';
import { sendResendEmail } from '../channels/resend';
import { construirComponentesMeta } from '../comunicacion/plantillas';
import { consultarVigenciaRepep, estaEnRepep } from '../services/repep';

export interface CampaignState {
  campaignId: string;
  status: 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  total: number;
  cursor: number;
  sent: number;
  deferred: number;
  excluded: number;
  failed: number;
}

export class CampaignRunnerDO {
  private state: CampaignState = {
    campaignId: '',
    status: 'scheduled',
    total: 0,
    cursor: 0,
    sent: 0,
    deferred: 0,
    excluded: 0,
    failed: 0,
  };

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'status';

    await this.loadState();

    if (action === 'status') {
      return new Response(JSON.stringify(this.state), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action === 'pause') {
      this.state.status = 'paused';
      await this.saveState();
      return new Response(JSON.stringify({ ok: true, status: this.state.status }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action === 'start') {
      let payload: CampaignDispatchV1;
      try {
        payload = await request.json<CampaignDispatchV1>();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400 });
      }

      this.state.campaignId = payload.campaign_id;
      this.state.total = payload.audience.length;
      this.state.status = 'running';
      this.state.cursor = 0;
      await this.saveState();

      // Ejecutar lote de despacho de forma síncrona/asíncrona
      await this.ejecutarLote(payload);

      return new Response(JSON.stringify(this.state), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'invalid_action' }), { status: 400 });
  }

  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<CampaignState>('state');
    if (stored) {
      this.state = stored;
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

  private async ejecutarLote(payload: CampaignDispatchV1): Promise<void> {
    const env = this.env;
    const tenant = await getTenantById(env, payload.tenant_id);
    if (!tenant) return;

    const org = await resolverOrganizacion(env, tenant);
    const marca = (tenant.marca_comercial || tenant.nombre || '').trim();
    const plantilla = await obtenerPlantilla(env, payload.template_id, tenant.id, org.id);
    if (!plantilla) return;

    const canales = await canalesEfectivos(env, tenant, org);
    const credentials = mergeChannelCredentials(canales);

    const maxWeeklyPolicy = tenant.comm_max_por_semana ?? 2;
    const maxWeekly = payload.frequency_cap
      ? Math.min(payload.frequency_cap, maxWeeklyPolicy)
      : maxWeeklyPolicy;

    const ahora = new Date();
    const repepVigencia = await consultarVigenciaRepep(env);

    for (let i = this.state.cursor; i < payload.audience.length; i++) {
      if (this.state.status === 'paused') break;

      const item = payload.audience[i];
      if (!item) continue;
      const phone = normalizePhone(item.phone);

      if (!phone) {
        this.state.excluded++;
        this.state.cursor++;
        continue;
      }

      const [consent, supp, fcap, cobranzaActiva, enRepep] = await Promise.all([
        obtenerHechoConsentimiento(env, tenant.id, phone, payload.canal, plantilla.categoria),
        estaSuprimido(env, tenant.id, phone),
        checkFrequencyCap(env, tenant.id, phone, maxWeekly, false),
        tieneCobranzaActiva(env, tenant.id, phone),
        repepVigencia.versionActiva
          ? estaEnRepep(env, phone, repepVigencia.versionActiva)
          : Promise.resolve(false),
      ]);

      const vars: Record<string, string> = {
        ...(item.variables ?? {}),
        nombre: item.name ?? item.variables?.['nombre'] ?? '',
        marca,
      };

      const evalRes = evaluarEnvio({
        motor: payload.motor,
        modo: 'campana',
        canal: payload.canal,
        proposito: payload.proposito,
        marca,
        contacto: phone,
        ahora,
        tzContacto: item.tz ?? tenant.tz ?? null,
        consentimiento: consent,
        suprimido: supp,
        repep: {
          listaVigente: repepVigencia.listaVigente,
          registrado: enRepep,
        },
        frecuencia: { enviadosVentana: fcap.count, maximo: maxWeekly },
        plantilla,
        variables: vars,
        cobranzaActiva,
      });

      const envioId = `env_${payload.campaign_id}_${phone.replace(/\D/g, '')}`;

      if (evalRes.decision === 'excluir') {
        this.state.excluded++;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO comm_envios (
            id, tenant_id, org_tenant_id, campaign_id, contacto, channel, template_id, categoria, status, motivo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'excluded', ?)`
        )
          .bind(
            envioId,
            tenant.id,
            org.id,
            payload.campaign_id,
            phone,
            payload.canal,
            plantilla.id,
            plantilla.categoria,
            evalRes.motivos[0] ?? 'exclusion'
          )
          .run();
      } else if (evalRes.decision === 'diferir') {
        this.state.deferred++;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO comm_envios (
            id, tenant_id, org_tenant_id, campaign_id, contacto, channel, template_id, categoria, status, scheduled_for
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deferred', ?)`
        )
          .bind(
            envioId,
            tenant.id,
            org.id,
            payload.campaign_id,
            phone,
            payload.canal,
            plantilla.id,
            plantilla.categoria,
            evalRes.diferirHasta ?? null
          )
          .run();
      } else {
        // Enviar efectivamente
        await checkFrequencyCap(env, tenant.id, phone, maxWeekly, true);

        let providerId = `mock_${Date.now()}`;
        try {
          if (payload.canal === 'whatsapp') {
            const components = construirComponentesMeta(plantilla, vars);
            const sendRes = await sendWhatsApp(env, {
              to: phone,
              body: evalRes.textoRenderizado ?? plantilla.bodyPreview,
              campaignId: payload.campaign_id,
              credentials,
              template: {
                name: plantilla.metaName || plantilla.id,
                lang: plantilla.lang,
                components,
              },
            });
            if (sendRes.ok && sendRes.providerId) providerId = sendRes.providerId;
          } else if (payload.canal === 'sms') {
            const sendRes = await sendTelnyxSms(env, {
              to: phone,
              body: evalRes.textoRenderizado ?? plantilla.bodyPreview,
              caseId: payload.campaign_id,
              credentials,
            });
            if (sendRes.ok && sendRes.providerId) providerId = sendRes.providerId;
          } else if (payload.canal === 'email') {
            const sendRes = await sendResendEmail(env, {
              to: phone,
              body: evalRes.textoRenderizado ?? plantilla.bodyPreview,
              subject: plantilla.subject ?? `Mensaje de ${marca}`,
              caseId: payload.campaign_id,
              credentials,
            });
            if (sendRes.ok && sendRes.providerId) providerId = sendRes.providerId;
          }
        } catch {
          // Error controlado de envío de canal
        }

        this.state.sent++;

        await env.DB.prepare(
          `INSERT OR REPLACE INTO comm_envios (
            id, tenant_id, org_tenant_id, campaign_id, contacto, channel, template_id, categoria, status, provider_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`
        )
          .bind(
            envioId,
            tenant.id,
            org.id,
            payload.campaign_id,
            phone,
            payload.canal,
            plantilla.id,
            plantilla.categoria,
            providerId
          )
          .run();

        // Registrar evento de consumo (Minutos y Mensajes para bolsa de créditos)
        const unitCost = payload.canal === 'whatsapp' ? 95 : payload.canal === 'sms' ? 45 : 5;
        const eventId = `usg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await env.DB.prepare(
          `INSERT INTO usage_events (
            id, tenant_id, parent_tenant_id, campaign_id, channel, unit, qty, unit_cost_cents, total_cost_cents
          ) VALUES (?, ?, ?, ?, ?, 'message', 1, ?, ?)`
        )
          .bind(eventId, tenant.id, org.id, payload.campaign_id, payload.canal, unitCost, unitCost)
          .run();
      }

      this.state.cursor++;
    }

    if (this.state.cursor >= payload.audience.length) {
      this.state.status = 'completed';
    }
    await this.saveState();
  }
}
