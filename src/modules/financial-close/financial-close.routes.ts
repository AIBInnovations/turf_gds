import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors/app-error.js';
import type { AdminAuthService } from '../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminContext,
} from '../identity/shared/auth-context.js';
import type {
  FinancialCloseService,
  GenerateSettlementInput,
  RecordReconciliationInput,
} from './financial-close.service.js';

export interface FinancialCloseRoutesOptions {
  service: FinancialCloseService;
  adminAuthService: AdminAuthService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const settlementParams = {
  type: 'object',
  additionalProperties: false,
  required: ['settlementId'],
  properties: { settlementId: objectId },
} as const;

const financialCloseRoutes: FastifyPluginAsync<
  FinancialCloseRoutesOptions
> = async (fastify, options) => {
  const authenticate = createAdminAuthenticationHook(
    options.adminAuthService,
  );

  fastify.post<{
    Body: Omit<GenerateSettlementInput, 'adminId' | 'correlationId'>;
  }>(
    '/settlements',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['partnerId', 'environment', 'periodStart', 'periodEnd'],
          properties: {
            partnerId: objectId,
            environment: { enum: ['SANDBOX', 'PRODUCTION'] },
            periodStart: { type: 'string', format: 'date-time' },
            periodEnd: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireFinancialAdmin(request);
      return reply.status(201).send(await options.service.generate({
        adminId: admin.adminId,
        correlationId: request.id,
        ...request.body,
      }));
    },
  );

  fastify.get<{
    Querystring: Parameters<FinancialCloseService['list']>[0];
  }>(
    '/settlements',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            partnerId: objectId,
            environment: { enum: ['SANDBOX', 'PRODUCTION'] },
            status: {
              enum: [
                'DRAFT', 'PENDING_FUNDS', 'RECONCILING', 'RECONCILED',
                'COMPLETED', 'FAILED', 'REVERSED',
              ],
            },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.list(request.query);
    },
  );

  fastify.get<{ Params: { settlementId: string } }>(
    '/settlements/:settlementId',
    { preHandler: authenticate, schema: { params: settlementParams } },
    async (request) => {
      requireAdminContext(request);
      return options.service.get(request.params.settlementId);
    },
  );

  fastify.post<{ Params: { settlementId: string } }>(
    '/settlements/:settlementId/submit',
    { preHandler: authenticate, schema: { params: settlementParams } },
    async (request) => {
      const admin = requireFinancialAdmin(request);
      return options.service.submit({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
      });
    },
  );

  fastify.post<{
    Params: { settlementId: string };
    Body: Omit<
      RecordReconciliationInput,
      'adminId' | 'settlementId' | 'correlationId'
    >;
  }>(
    '/settlements/:settlementId/reconciliation',
    {
      preHandler: authenticate,
      schema: {
        params: settlementParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reportedAmountMinor', 'bankReference'],
          properties: {
            reportedAmountMinor: { type: 'integer', minimum: 0 },
            bankReference: { type: 'string', minLength: 1, maxLength: 200 },
            evidenceUri: { type: 'string', minLength: 1, maxLength: 2_048 },
            notes: { type: 'string', minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireFinancialAdmin(request);
      return reply.status(201).send(await options.service.reconcile({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
        ...request.body,
      }));
    },
  );

  fastify.post<{
    Params: { settlementId: string };
    Body: { evidenceUri: string; notes: string };
  }>(
    '/settlements/:settlementId/reconciliation/resolve',
    {
      preHandler: authenticate,
      schema: {
        params: settlementParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['evidenceUri', 'notes'],
          properties: {
            evidenceUri: { type: 'string', minLength: 1, maxLength: 2_048 },
            notes: { type: 'string', minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request) => {
      const admin = requireFinancialAdmin(request);
      return options.service.resolve({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
        ...request.body,
      });
    },
  );

  fastify.post<{ Params: { settlementId: string } }>(
    '/settlements/:settlementId/complete',
    { preHandler: authenticate, schema: { params: settlementParams } },
    async (request) => {
      const admin = requireFinancialAdmin(request);
      return options.service.complete({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
      });
    },
  );

  fastify.post<{
    Params: { settlementId: string; venueId: string };
    Body: { payoutAccountId: string; idempotencyKey: string };
  }>(
    '/settlements/:settlementId/venues/:venueId/payouts',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['settlementId', 'venueId'],
          properties: { settlementId: objectId, venueId: objectId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['payoutAccountId', 'idempotencyKey'],
          properties: {
            payoutAccountId: objectId,
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireFinancialAdmin(request);
      return reply.status(201).send(await options.service.initiatePayout({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        venueId: request.params.venueId,
        correlationId: request.id,
        ...request.body,
      }));
    },
  );

  fastify.post<{
    Params: { payoutId: string };
    Body: {
      status: 'PAID' | 'FAILED';
      bankReference?: string;
      failureReason?: string;
    };
  }>(
    '/payouts/:payoutId/result',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['payoutId'],
          properties: { payoutId: objectId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: { enum: ['PAID', 'FAILED'] },
            bankReference: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
            failureReason: {
              type: 'string',
              minLength: 1,
              maxLength: 1_000,
            },
          },
        },
      },
    },
    async (request) => {
      const admin = requireFinancialAdmin(request);
      return options.service.recordPayoutResult({
        adminId: admin.adminId,
        payoutId: request.params.payoutId,
        correlationId: request.id,
        ...request.body,
      });
    },
  );

  fastify.post<{
    Params: { settlementId: string };
    Body: {
      bookingId: string;
      lines: Array<{
        direction: 'DEBIT' | 'CREDIT';
        amountMinor: number;
        component: 'GROSS' | 'COMMISSION' | 'TAX' | 'VENUE_NET';
      }>;
      reason: string;
      evidenceUri: string;
      effectiveAt?: string;
    };
  }>(
    '/settlements/:settlementId/adjustments',
    {
      preHandler: authenticate,
      schema: {
        params: settlementParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['bookingId', 'lines', 'reason', 'evidenceUri'],
          properties: {
            bookingId: objectId,
            lines: {
              type: 'array',
              minItems: 2,
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['direction', 'amountMinor', 'component'],
                properties: {
                  direction: { enum: ['DEBIT', 'CREDIT'] },
                  amountMinor: {
                    type: 'integer',
                    minimum: 1,
                    maximum: Number.MAX_SAFE_INTEGER,
                  },
                  component: {
                    enum: ['GROSS', 'COMMISSION', 'TAX', 'VENUE_NET'],
                  },
                },
              },
            },
            reason: { type: 'string', minLength: 1, maxLength: 1_000 },
            evidenceUri: {
              type: 'string',
              format: 'uri',
              minLength: 1,
              maxLength: 2_048,
            },
            effectiveAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireFinancialAdmin(request);
      return reply.status(201).send(await options.service.recordAdjustment!({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
        ...request.body,
      }));
    },
  );

  fastify.post<{ Params: { settlementId: string } }>(
    '/settlements/:settlementId/invoices',
    {
      preHandler: authenticate,
      schema: { params: settlementParams },
    },
    async (request, reply) => {
      const admin = requireFinancialAdmin(request);
      return reply.status(201).send(await options.service.createInvoice!({
        adminId: admin.adminId,
        settlementId: request.params.settlementId,
        correlationId: request.id,
      }));
    },
  );

  fastify.get<{
    Querystring: {
      settlementId?: string;
      environment?: 'SANDBOX' | 'PRODUCTION';
      status?: 'DRAFT' | 'ISSUED' | 'VOID';
      page?: number;
      limit?: number;
    };
  }>(
    '/invoices',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            settlementId: objectId,
            environment: { enum: ['SANDBOX', 'PRODUCTION'] },
            status: { enum: ['DRAFT', 'ISSUED', 'VOID'] },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.listInvoices!(request.query);
    },
  );

  fastify.get<{ Params: { invoiceId: string } }>(
    '/invoices/:invoiceId',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['invoiceId'],
          properties: { invoiceId: objectId },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.getInvoice!(request.params.invoiceId);
    },
  );

  for (const action of ['issue', 'void'] as const) {
    fastify.post<{ Params: { invoiceId: string } }>(
      `/invoices/:invoiceId/${action}`,
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['invoiceId'],
            properties: { invoiceId: objectId },
          },
        },
      },
      async (request) => {
        const admin = requireFinancialAdmin(request);
        const input = {
          adminId: admin.adminId,
          invoiceId: request.params.invoiceId,
          correlationId: request.id,
        };
        return action === 'issue'
          ? options.service.issueInvoice!(input)
          : options.service.voidInvoice!(input);
      },
    );
  }
};

function requireFinancialAdmin(request: FastifyRequest): { adminId: string } {
  const admin = requireAdminContext(request);
  if (admin.role !== 'ADMIN') {
    throw new AppError({
      code: 'ADMIN_ROLE_REQUIRED',
      message: 'The ADMIN role is required for Financial Close mutations',
      statusCode: 403,
    });
  }
  return admin;
}

export default financialCloseRoutes;
