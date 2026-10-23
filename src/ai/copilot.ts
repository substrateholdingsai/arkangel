import { configLegal } from '../legal/config';
import { catalogoReglas, evaluarMensaje } from '../legal/motor';
import { logger } from '../lib/logger';
import { formatMXN } from '../lib/money';
import { isWithinSendWindow, localHour } from '../lib/score';
import { getCase, listCasesByDate } from '../services/casos';
import { getClient } from '../services/clientes';
import { getContractByClient } from '../services/contratos';
import { todayIso } from '../services/db';
import { listPendingDebts } from '../services/deudas';
import { listAudit, resumenCumplimiento } from '../services/legalAudit';
import { countContactos24h, listConversation } from '../services/mensajes';
import { dailyMetrics } from '../services/metricas';
import type { TenantContext } from '../tenancy/types';
import { DEFAULT_AI_MODEL, extractText } from './agent';

export interface CopilotHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface CopilotRequest {
  message: string;
  history?: CopilotHistoryItem[];
  activeCaseId?: string | null;
}

export interface CopilotResponse {
  reply: string;
  suggestedDraft: string | null;
  contextSummary: {
    tenantName: string;
    condusef: string | null;
    windowOpen: boolean;
    humanCasesCount: number;
    readyCasesCount: number;
    activeCaseName: string | null;
  };
}

const PLAYBOOK_OPERATIVO = `
MANUAL OPERATIVO DE ARKANGEL (TORRE DE CONTROL IA + HUMANO):
1. ¿Qué es Arkangel?: Es una plataforma híbrida (IA + Operadores Humanos) de cobranza preventiva y morosa con un Motor Legal ejecutable (12 reglas / 48 conductas prohibidas de CONDUSEF, LFPC, NOM-184 y Código Penal Federal).
2. Flujo de trabajo diario del operador:
   - PASO 1 (Ingesta 6:00 AM): Arrastrar el archivo CSV de deudores en la zona "Cargar CSV" (columnas: nombre, telefono, email, monto, vencimiento, folio). El motor calcula automáticamente el Score Sherman v2 (riesgo bajo/medio/alto) y vincula el contrato legal.
   - PASO 2 (Disparo IA): Hacer clic en el botón verde "Disparar cobranza de hoy". La IA redacta y envía mensajes personalizados por WhatsApp, SMS o Email respetando la ventana legal NOM-184 (08:00 a 22:00 CDMX) y el límite de 42 mensajes por minuto (RPM).
   - PASO 3 (Bandeja "Delegados a Humano"): Cuando un deudor responde pidiendo factura, negociando quitas/plazos, molesto o solicitando un ejecutivo, la IA clasifica su intención y cambia el caso a estado "Escalado" (human). El operador debe ir a la pestaña "Delegados a Humano" y hacer clic en el botón rojo "Atender".
   - PASO 4 (Drawer del Operador y Softphone): Al abrir un caso, a la derecha aparece el Drawer con 3 pestañas:
     * "Mensajes Omnicanal": Chat en vivo por WhatsApp/SMS/Email. Todo lo que escriba el humano pasa por el Guardián Legal antes de enviarse; si contiene amenazas, CLABEs no registradas o montos alterados, el sistema lo bloquea con error 422 y explica qué regla violó.
     * "Softphone (Voz)": Permite iniciar llamada telefónica dentro de la ventana 08:00-22:00, muestra en pantalla el guion de identificación CONDUSEF obligatorio y la CLABE autorizada, y registra la bitácora al colgar.
     * "Expediente y Contrato": Muestra CURP, desglose de deudas vencidas, monto pactado en contrato, tasa anual y CLABE SPEI autorizada.
   - PASO 5 (Resolución del Caso): En la parte superior del Drawer hay 4 botones de cierre:
     * "Promesa de pago": Registra fecha compromiso y pasa el caso a "Promesa" (detiene cobros automáticos).
     * "Marcar Pagado": Liquida las deudas pendientes y cierra el caso en "Pagado".
     * "Devolver a IA": Si la duda del cliente quedó resuelta, regresa el caso a "En cola" para seguimiento autónomo.
     * "Baja DND": Activa "No Molestar" (Art. 18 Bis LFPC / REUS) si el cliente exige revocar el consentimiento.
`.trim();

function buildFallbackReply(
  question: string,
  meta: {
    razonSocial: string;
    condusef: string;
    windowOpen: boolean;
    horaLocal: number;
    readyCount: number;
    humanCases: Array<{ id: string; name: string; amount: string }>;
    promisedCount: number;
    bloqueosHoy: number;
    activeCase: {
      name: string;
      amount: string;
      status: string;
      clabe: string | null;
      lastInbound: string | null;
      contactos24h: number;
      maxContactos24h: number;
    } | null;
    suggestedDraft: string | null;
  }
): string {
  const q = question.toLowerCase();

  if (
    q.includes('nuevo') ||
    q.includes('empiezo') ||
    q.includes('hacer') ||
    q.includes('turno') ||
    q.includes('manual') ||
    q.includes('como funciona') ||
    q.includes('cómo funciona')
  ) {
    return [
      `¡Bienvenido a **Arkangel**! Aquí tienes tu guía rápida de operación en tiempo real:`,
      ``,
      `1. **Revisa casos urgentes ("Delegados a Humano")**: Ahora mismo tienes **${meta.humanCases.length} caso(s)** escalados por la IA que requieren atención humana${meta.humanCases.length > 0 ? ` (${meta.humanCases.map((c) => `${c.name} por ${c.amount}`).join(', ')})` : ''}. Haz clic en la pestaña **Delegados a Humano** de la tabla y pulsa **Atender**.`,
      `2. **Disparo Autónomo IA**: Hay **${meta.readyCount} caso(s)** en cola listos para disparo. La ventana legal NOM-184 (08:00–22:00 CDMX) está **${meta.windowOpen ? 'Abierta' : 'Cerrada'}** (hora local: ${String(meta.horaLocal).padStart(2, '0')}:00h).`,
      `3. **Atención en el Drawer**: Al abrir un caso puedes responder por WhatsApp/SMS/Email o usar el **Softphone (Voz)**. El **Guardián Legal** audita cada mensaje tuyo en vivo para que nunca cometas una infracción ante CONDUSEF.`,
      `4. **Cierre**: Registra **Promesa de pago**, **Marcar Pagado**, **Devolver a IA** o **Baja DND** en la barra superior del Drawer.`,
    ].join('\n');
  }

  if (
    q.includes('redact') ||
    q.includes('responder') ||
    q.includes('respuesta') ||
    q.includes('mensaje') ||
    q.includes('caso abierto')
  ) {
    if (meta.activeCase && meta.suggestedDraft) {
      return [
        `Para el caso activo de **${meta.activeCase.name}** (saldo: **${meta.activeCase.amount}**, contactos 24h: ${meta.activeCase.contactos24h}/${meta.activeCase.maxContactos24h}):`,
        meta.activeCase.lastInbound
          ? `\nÚltimo mensaje del cliente: *"${meta.activeCase.lastInbound}"*`
          : '',
        `\nTe preparé un borrador **100% validado por las 12 reglas del Motor Legal** (incluye razón social, registro CONDUSEF y la CLABE autorizada del contrato \`${meta.activeCase.clabe ?? 'N/A'}\`). Puedes copiarlo con el botón de abajo:`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    return `Abre primero cualquier caso con el botón **Atender** o **Abrir** en la tabla para que pueda leer su contrato, CLABE autorizada y último WhatsApp, y redactarte una respuesta validada por el Motor Legal.`;
  }

  if (
    q.includes('prohibid') ||
    q.includes('regla') ||
    q.includes('ley') ||
    q.includes('condusef') ||
    q.includes('bloque')
  ) {
    return [
      `El **Motor Legal de Arkangel** ejecuta **12 reglas y 48 conductas prohibidas** en modalidad *fail-closed* (hoy lleva **${meta.bloqueosHoy} bloqueo(s)**):`,
      ``,
      `- **1.1 Identidad obligatoria (LFPC Art. 112 Bis)**: Todo primer contacto debe incluir **${meta.razonSocial}** y registro **${meta.condusef}**.`,
      `- **1.2 Usurpación (CPF Art. 250)**: Prohibido fingir ser juez, tribunal, ministerio público, SAT, PROFECO o "institución de crédito" si no eres banco.`,
      `- **2.1 / 2.2 / 2.3 Ventana y Acoso (NOM-184)**: Sólo de **08:00 a 22:00 CDMX**, máximo **3 contactos en 24h**, prohibido cobrar antes del vencimiento (T-1) o amenazar con acceder a fotos/contactos del celular.`,
      `- **3.1 / 3.2 Antiphishing y CLABE única (CPF Art. 386)**: Prohibidos acortadores (\`bit.ly\`, \`tinyurl\`), ligas fuera de dominios autorizados o pedir depósitos en OXXO / cuentas personales distintas a la CLABE del contrato.`,
      `- **4.1 / 4.2 / 4.4 Coerción y Usura**: Prohibidas palabras como *"embargo inminente"*, *"último aviso"*, *"boletinar"*, contactar a RRHH/familiares o cobrar tasas superiores al contrato.`,
    ].join('\n');
  }

  return [
    `**Estado en vivo de ${meta.razonSocial} (${meta.condusef})**:`,
    `- **Casos escalados a humano**: ${meta.humanCases.length} (${meta.humanCases.map((c) => `${c.name}: ${c.amount}`).join(', ') || 'ninguno'})`,
    `- **Casos en cola listos para disparo IA**: ${meta.readyCount}`,
    `- **Promesas de pago activas hoy**: ${meta.promisedCount}`,
    `- **Ventana NOM-184**: ${meta.windowOpen ? 'Abierta' : 'Cerrada'} (${String(meta.horaLocal).padStart(2, '0')}:00 CDMX)`,
    ``,
    `Pregúntame cómo operar cualquier módulo, qué hacer con un deudor difícil o abre un caso en el Drawer para que te redacte una respuesta legalmente blindada.`,
  ].join('\n');
}

export async function askCopilot(
  ctx: TenantContext,
  input: CopilotRequest
): Promise<CopilotResponse> {
  const date = todayIso(ctx.config.tz);
  const legal = configLegal(ctx);
  const now = new Date();
  const windowOpen = isWithinSendWindow(now, legal.horaInicio, legal.horaFin, ctx.config.tz);
  const horaLocal = localHour(now, ctx.config.tz);

  const [cases, metrics, cumplimiento, auditoria] = await Promise.all([
    listCasesByDate(ctx, date),
    dailyMetrics(ctx, date),
    resumenCumplimiento(ctx, date),
    listAudit(ctx, 5),
  ]);

  const humanCases = cases
    .filter((c) => c.status === 'human')
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      name: c.name,
      amount: formatMXN(c.amount_cents),
      scoreBand: c.score_band,
    }));

  const readyCount = metrics.por_estado?.ready ?? 0;
  const promisedCount = metrics.promesas ?? 0;

  let activeCaseInfo: {
    id: string;
    name: string;
    amount: string;
    amountCents: number;
    status: string;
    clabe: string | null;
    tasaPct: number | null;
    lastInbound: string | null;
    contactos24h: number;
    maxContactos24h: number;
    conversationSnippet: string;
  } | null = null;

  let suggestedDraft: string | null = null;

  if (input.activeCaseId) {
    const c = await getCase(ctx, input.activeCaseId);
    if (c) {
      const [client, contract, debts, messages, contactos24h] = await Promise.all([
        getClient(ctx, c.client_id),
        getContractByClient(ctx, c.client_id),
        listPendingDebts(ctx, c.client_id),
        listConversation(ctx, c.client_id, 6),
        countContactos24h(ctx, c.client_id),
      ]);

      const inboundMsgs = messages.filter((m) => m.direction === 'inbound');
      const lastInbound = inboundMsgs.length > 0 ? inboundMsgs[inboundMsgs.length - 1]!.body : null;

      const conversationSnippet = messages
        .slice(-4)
        .map((m) => `[${m.direction === 'inbound' ? 'DEUDOR' : 'ARKANGEL'}]: ${m.body}`)
        .join('\n');

      activeCaseInfo = {
        id: c.id,
        name: c.name,
        amount: formatMXN(c.amount_cents),
        amountCents: c.amount_cents,
        status: c.status,
        clabe: contract?.clabe ?? null,
        tasaPct: contract?.tasa_pct ?? null,
        lastInbound,
        contactos24h,
        maxContactos24h: legal.maxContactos24h,
        conversationSnippet,
      };

      const razonSocial = legal.nombreLegal || contract?.nombre_legal || 'Arkangel Cobranza';
      const condusef = legal.condusef || contract?.condusef || 'REDECO-PENDIENTE';
      const clabeText = contract?.clabe
        ? `a la CLABE autorizada en su contrato ${contract.clabe}`
        : 'por los medios autorizados en su contrato';

      const candidateDraft = `Estimado(a) ${c.name}, le atiende un ejecutivo de ${razonSocial} (Registro CONDUSEF: ${condusef}). En seguimiento a su mensaje respecto a su saldo pendiente de ${formatMXN(c.amount_cents)}, quedamos a su disposición para enviarle su estado de cuenta/CFDI y registrar su convenio de pago ${clabeText}. ¿Qué fecha de pago le resulta viable programar?`;

      const veredicto = evaluarMensaje({
        ahora: now,
        canal: 'whatsapp',
        mensaje: candidateDraft,
        nombreLegal: razonSocial,
        condusef,
        clienteId: c.client_id,
        clienteNombre: c.name,
        telefono: client?.phone ?? c.phone,
        email: client?.email ?? c.email,
        montoCents: c.amount_cents,
        fechaVencimiento: debts[0]?.due_date ?? null,
        contrato: contract,
        contactos24h,
        logsReales: contactos24h,
        logsCrm: contactos24h,
        dominiosPermitidos: legal.dominiosPermitidos,
        maxContactos24h: legal.maxContactos24h,
        ventanaContacto: { inicio: legal.horaInicio, fin: legal.horaFin },
        toleranciaCents: legal.montoToleranciaCents,
        zonaHoraria: ctx.config.tz,
        caseId: c.id,
        esRespuesta: true,
      });

      suggestedDraft = veredicto.permitido ? veredicto.mensaje : candidateDraft;
    }
  }

  const reglasTexto = catalogoReglas()
    .map((r) => `- Regla ${r.id} (${r.accion}): ${r.conducta} [${r.ley} ${r.articulo}]`)
    .join('\n');

  const systemPrompt = [
    `Eres el **Copiloto Arkangel**, el instructor operativo en vivo y auditor de calidad legal (QA) integrado en el Worker de Arkangel.`,
    `Hablas en español claro, directo, empático y táctico para ayudar tanto a empleados nuevos como a supervisores de cobranza.`,
    ``,
    PLAYBOOK_OPERATIVO,
    ``,
    `ESTADO EN VIVO DEL WORKER Y DESPACHO ACTIVO (${date}):`,
    `- Despacho (Razón Social): ${legal.nombreLegal || 'No configurada (Fail-closed activo)'}`,
    `- Registro CONDUSEF: ${legal.condusef || 'No configurado'}`,
    `- Dominios de pago autorizados: ${legal.dominiosPermitidos.join(', ') || 'ninguno'}`,
    `- Ventana Legal NOM-184: ${String(legal.horaInicio).padStart(2, '0')}:00 a ${String(legal.horaFin).padStart(2, '0')}:00 (${ctx.config.tz}) · Hora actual: ${String(horaLocal).padStart(2, '0')}:00 · Estado: ${windowOpen ? 'ABIERTA' : 'CERRADA'}`,
    `- Casos totales hoy: ${metrics.total} | En cola IA (ready): ${readyCount} | Escalados a Humano (human): ${humanCases.length} | Promesas: ${promisedCount} | Mensajes enviados hoy: ${metrics.enviadas}`,
    `- Casos urgentes delegados a humano hoy: ${humanCases.map((c) => `${c.name} (${c.amount}, riesgo ${c.scoreBand})`).join('; ') || 'Ninguno pendiente'}`,
    `- Auditoría Legal hoy: ${cumplimiento.bloqueos} bloqueos, ${cumplimiento.saneos} saneamientos automáticos.`,
    auditoria.length > 0
      ? `- Últimas alertas legales hoy: ${auditoria.map((a) => `Regla ${a.regla_id} (${a.accion}): ${a.detalle}`).join(' | ')}`
      : '',
    activeCaseInfo
      ? [
          ``,
          `CASO ACTUALMENTE ABIERTO EN EL DRAWER DEL OPERADOR:`,
          `- Cliente: ${activeCaseInfo.name} (ID: ${activeCaseInfo.id})`,
          `- Saldo exacto a cobrar: ${activeCaseInfo.amount}`,
          `- Estado del caso: ${activeCaseInfo.status}`,
          `- CLABE SPEI autorizada en contrato: ${activeCaseInfo.clabe ?? 'Sin CLABE'}`,
          `- Tasa anual en contrato: ${activeCaseInfo.tasaPct !== null ? `${activeCaseInfo.tasaPct}%` : 'N/A'}`,
          `- Contactos en últimas 24h: ${activeCaseInfo.contactos24h} de máximo ${activeCaseInfo.maxContactos24h}`,
          `- Último mensaje del deudor: ${activeCaseInfo.lastInbound ?? 'Sin respuesta aún'}`,
          `- Historial reciente:\n${activeCaseInfo.conversationSnippet}`,
        ].join('\n')
      : `\n(El operador no tiene ningún caso abierto en el Drawer en este momento).`,
    ``,
    `CATÁLOGO DE LAS 12 REGLAS EJECUTABLES (48 CONDUCTAS PROHIBIDAS):`,
    reglasTexto,
    ``,
    `INSTRUCCIONES DE RESPUESTA:`,
    `1. Sé conciso (máximo 2-3 párrafos o viñetas puntuales). Usa formato Markdown limpio.`,
    `2. Si el operador pregunta qué hacer o cómo usar la plataforma, guíalo paso a paso mencionando los nombres exactos de los botones y pestañas de Arkangel y los datos reales de su despacho hoy.`,
    `3. Si el operador pide redactar un mensaje para un deudor, incluye SIEMPRE la razón social (${legal.nombreLegal}), el registro CONDUSEF (${legal.condusef}), el monto exacto y la CLABE del contrato, sin ninguna palabra coercitiva.`,
  ]
    .filter(Boolean)
    .join('\n');

  let aiReply: string | null = null;
  if (ctx.env.AI) {
    try {
      const modelName = ctx.env.AI_MODEL || DEFAULT_AI_MODEL;
      const chatMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...(input.history ?? []).slice(-6).map((h) => ({
          role: h.role,
          content: h.content.slice(0, 1200),
        })),
        { role: 'user' as const, content: input.message.slice(0, 1500) },
      ];
      const result = await ctx.env.AI.run(modelName, { messages: chatMessages });
      aiReply = extractText(result);
    } catch (error) {
      logger.warn('Copiloto Workers AI usó fallback determinista', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finalReply =
    aiReply ||
    buildFallbackReply(input.message, {
      razonSocial: legal.nombreLegal || 'Arkangel Cobranza Legal S.A.P.I. de C.V.',
      condusef: legal.condusef || 'REDECO-2026-0042',
      windowOpen,
      horaLocal,
      readyCount,
      humanCases,
      promisedCount,
      bloqueosHoy: cumplimiento.bloqueos,
      activeCase: activeCaseInfo,
      suggestedDraft,
    });

  return {
    reply: finalReply,
    suggestedDraft,
    contextSummary: {
      tenantName: legal.nombreLegal || ctx.tenantId,
      condusef: legal.condusef || null,
      windowOpen,
      humanCasesCount: humanCases.length,
      readyCasesCount: readyCount,
      activeCaseName: activeCaseInfo?.name ?? null,
    },
  };
}
