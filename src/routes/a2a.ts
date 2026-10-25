import { Hono } from 'hono';
import { logger } from '../lib/logger';
import { resolveTenantContextDeRequest } from '../tenancy/context';
import {
  verifyDebtorIdentity,
  getA2ASettlementTerms,
  evaluateA2AOffer,
  getA2AAgreement,
} from '../services/a2a';
import type { A2AAuthChallenge, A2AOfferRequest } from '../types/a2a';
import type { Env } from '../types/env';
import type { AuthVars } from '../auth/middleware';

export const a2a = new Hono<{ Bindings: Env; Variables: AuthVars }>();

/**
 * POST /api/v1/a2a/auth
 * Autentica al deudor a través de su agente externo (RFC / PIN)
 * Blindaje CONDUSEF 4.1 y 4.2 contra divulgación a terceros.
 */
a2a.post('/auth', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const body = await c.req.json<A2AAuthChallenge>();

    if (!body.caseId) {
      return c.json(
        { error: 'caseId_required', message: 'Se requiere el identificador de caso (caseId).' },
        400
      );
    }

    const result = await verifyDebtorIdentity(ctx, {
      caseId: body.caseId,
      phone: body.phone,
      rfcLast4: body.rfcLast4,
      pin: body.pin,
    });

    if (!result.verified) {
      if (result.error === 'case_not_found') {
        return c.json(
          { verified: false, error: 'case_not_found', message: 'El caso no fue localizado.' },
          404
        );
      }
      if (result.error === 'account_closed') {
        return c.json(
          { verified: false, error: 'account_closed', message: 'Esta cuenta ya está liquidada.' },
          410
        );
      }
      return c.json(
        {
          verified: false,
          error: 'auth_failed',
          message: 'Factor de autenticación inválido (RFC o PIN incorrecto).',
        },
        401
      );
    }

    return c.json({
      verified: true,
      sessionToken: result.sessionToken,
      debtorSummary: result.debtorSummary,
    });
  } catch (error: any) {
    logger.error('Error en /a2a/auth', { error: error?.message });
    return c.json({ error: 'internal_error', message: error?.message }, 500);
  }
});

/**
 * GET /api/v1/a2a/terms/:caseId
 * Consulta los términos de deuda, quita máxima y ofertas estándar.
 */
a2a.get('/terms/:caseId', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const caseId = c.req.param('caseId');

    const terms = await getA2ASettlementTerms(ctx, caseId);
    return c.json(terms);
  } catch (error: any) {
    logger.error('Error en /a2a/terms', { error: error?.message });
    return c.json({ error: 'terms_lookup_failed', message: error?.message }, 404);
  }
});

/**
 * POST /api/v1/a2a/negotiate
 * Recibe una propuesta económica del agente externo y evalúa quita matemáticamente.
 */
a2a.post('/negotiate', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const body = await c.req.json<A2AOfferRequest>();

    if (!body.caseId || typeof body.proposedAmountCents !== 'number') {
      return c.json(
        { error: 'invalid_payload', message: 'Se requiere caseId y proposedAmountCents numérico.' },
        400
      );
    }

    const result = await evaluateA2AOffer(ctx, {
      caseId: body.caseId,
      proposedAmountCents: body.proposedAmountCents,
      installments: body.installments ?? 1,
      promiseDate: body.promiseDate,
      agentId: body.agentId ?? 'external_agent',
      notes: body.notes,
    });

    return c.json(result);
  } catch (error: any) {
    logger.error('Error en /a2a/negotiate', { error: error?.message });
    return c.json({ error: 'negotiation_failed', message: error?.message }, 500);
  }
});

/**
 * GET /api/v1/a2a/agreement/:id
 * Consulta un convenio pactado entre agentes y su CLABE de liquidación.
 */
a2a.get('/agreement/:id', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const agreementId = c.req.param('id');

    const agreement = await getA2AAgreement(ctx, agreementId);
    if (!agreement) {
      return c.json({ error: 'agreement_not_found', message: 'Convenio no encontrado.' }, 404);
    }

    return c.json(agreement);
  } catch (error: any) {
    logger.error('Error en /a2a/agreement', { error: error?.message });
    return c.json({ error: 'agreement_lookup_failed', message: error?.message }, 500);
  }
});

/**
 * POST /api/v1/a2a/mcp
 * Endpoint JSON-RPC 2.0 compatible con el estándar Model Context Protocol (MCP).
 * Permite que clientes de IA (Claude, OpenAI, bots personalizados) usen tools nativos.
 */
a2a.post('/mcp', async (c) => {
  try {
    const ctx = await resolveTenantContextDeRequest(c.env, c.req.raw);
    const body = await c.req.json<any>();
    const { jsonrpc, method, params, id } = body || {};

    if (jsonrpc !== '2.0') {
      return c.json(
        {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32600, message: 'Invalid Request: jsonrpc must be 2.0' },
        },
        400
      );
    }

    // Listado de tools disponibles para el agente
    if (method === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'arkangel_a2a_auth',
              description:
                'Verifica la identidad del deudor (mediante RFC o PIN) para acceder a los datos y opciones de liquidación protegidas por secreto financiero CONDUSEF.',
              inputSchema: {
                type: 'object',
                properties: {
                  caseId: {
                    type: 'string',
                    description: 'Identificador del caso o folio de cobranza',
                  },
                  rfcLast4: {
                    type: 'string',
                    description: 'Últimos 4 caracteres del RFC con homoclave',
                  },
                  pin: { type: 'string', description: 'PIN de autenticación de 4 dígitos' },
                  phone: { type: 'string', description: 'Teléfono registrado del deudor' },
                },
                required: ['caseId'],
              },
            },
            {
              name: 'arkangel_a2a_get_terms',
              description:
                'Obtiene el desglose de adeudo, quita máxima autorizada y opciones estándar de pago para un caso ya autenticado.',
              inputSchema: {
                type: 'object',
                properties: {
                  caseId: { type: 'string', description: 'Identificador del caso de cobranza' },
                },
                required: ['caseId'],
              },
            },
            {
              name: 'arkangel_a2a_submit_offer',
              description:
                'Envía una oferta económica formal para liquidar la deuda. Si está dentro del margen autorizado, genera un convenio legal con CLABE SPEI; si no, devuelve la mejor contraoferta disponible.',
              inputSchema: {
                type: 'object',
                properties: {
                  caseId: { type: 'string', description: 'Identificador del caso de cobranza' },
                  proposedAmountCents: {
                    type: 'number',
                    description: 'Monto ofrecido en centavos MXN (ej: 750000 para $7,500.00 MXN)',
                  },
                  installments: {
                    type: 'number',
                    description: 'Número de parcialidades deseadas (1 = pago único)',
                  },
                  agentId: {
                    type: 'string',
                    description: 'Identificador del agente emisor de la oferta',
                  },
                },
                required: ['caseId', 'proposedAmountCents'],
              },
            },
            {
              name: 'arkangel_a2a_get_agreement',
              description:
                'Consulta los detalles y la CLABE SPEI de un convenio acordado previamente.',
              inputSchema: {
                type: 'object',
                properties: {
                  agreementId: {
                    type: 'string',
                    description: 'Identificador del convenio (agr_...)',
                  },
                },
                required: ['agreementId'],
              },
            },
          ],
        },
      });
    }

    // Ejecución de tools por el agente
    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'arkangel_a2a_auth') {
        const res = await verifyDebtorIdentity(ctx, {
          caseId: args.caseId,
          rfcLast4: args.rfcLast4,
          pin: args.pin,
          phone: args.phone,
        });
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          },
        });
      }

      if (toolName === 'arkangel_a2a_get_terms') {
        const terms = await getA2ASettlementTerms(ctx, args.caseId);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(terms, null, 2) }],
          },
        });
      }

      if (toolName === 'arkangel_a2a_submit_offer') {
        const offerResult = await evaluateA2AOffer(ctx, {
          caseId: args.caseId,
          proposedAmountCents: Number(args.proposedAmountCents),
          installments: args.installments ? Number(args.installments) : 1,
          agentId: args.agentId ?? 'mcp_client_agent',
        });
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(offerResult, null, 2) }],
          },
        });
      }

      if (toolName === 'arkangel_a2a_get_agreement') {
        const agr = await getA2AAgreement(ctx, args.agreementId);
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(agr, null, 2) }],
          },
        });
      }

      return c.json(
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Tool no encontrada: ${toolName}` },
        },
        404
      );
    }

    return c.json(
      {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Método MCP no soportado: ${method}` },
      },
      404
    );
  } catch (error: any) {
    logger.error('Error en /a2a/mcp', { error: error?.message });
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: error?.message || 'Internal MCP error' },
      },
      500
    );
  }
});
