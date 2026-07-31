import type { FastifyPluginAsync } from 'fastify';

import {
  createPartnerAuthenticationHook,
  requirePartnerScope,
} from '../shared/auth-context.js';
import type { PartnerAccessService } from './partner-access.service.js';
import type { PartnerPortalService } from './partner-portal.service.js';

export interface PartnerPortalRoutesOptions {
  service: PartnerPortalService;
  partnerAccessService: PartnerAccessService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const cursorPaging = {
  cursor: { type: 'string', minLength: 1, maxLength: 500 },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
} as const;
const dateFilters = {
  from: { type: 'string', format: 'date-time' },
  to: { type: 'string', format: 'date-time' },
} as const;

const partnerPortalRoutes: FastifyPluginAsync<PartnerPortalRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createPartnerAuthenticationHook(
      options.partnerAccessService,
    );
    const startedAt = new WeakMap<object, number>();
    fastify.addHook('onRequest', async (request) => {
      startedAt.set(request, performance.now());
    });
    fastify.addHook('onResponse', async (request, reply) => {
      const identity = request.identity;
      if (identity?.actorType !== 'PARTNER') return;
      await options.partnerAccessService.recordApiUsage({
        partnerId: identity.partnerId,
        environment: identity.environment,
        statusCode: reply.statusCode,
        latencyMs: performance.now() - (startedAt.get(request) ?? 0),
        rateLimited: reply.statusCode === 429,
      }).catch((error: unknown) => {
        request.log.error({ err: error }, 'Failed to record API usage');
      });
    });

    fastify.get<{
      Querystring: {
        latitude: number;
        longitude: number;
        radiusMeters: number;
        sportType:
          | 'FOOTBALL' | 'CRICKET' | 'BADMINTON' | 'TENNIS'
          | 'PICKLEBALL' | 'MULTI_SPORT' | 'OTHER';
        startsAt: string;
        endsAt: string;
        bookingType?: 'OPEN_TIME' | 'FIXED_SLOT';
        cursor?: string;
        limit?: number;
      };
    }>(
      '/availability',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: [
              'latitude', 'longitude', 'radiusMeters', 'sportType',
              'startsAt', 'endsAt',
            ],
            properties: {
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              radiusMeters: {
                type: 'integer',
                minimum: 100,
                maximum: 100_000,
              },
              sportType: {
                enum: [
                  'FOOTBALL', 'CRICKET', 'BADMINTON', 'TENNIS',
                  'PICKLEBALL', 'MULTI_SPORT', 'OTHER',
                ],
              },
              startsAt: { type: 'string', format: 'date-time' },
              endsAt: { type: 'string', format: 'date-time' },
              bookingType: { enum: ['OPEN_TIME', 'FIXED_SLOT'] },
              ...cursorPaging,
            },
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'availability:read');
        return options.service.searchAvailability({
          ...request.query,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{
      Querystring: {
        from?: string; to?: string; cursor?: string; limit?: number;
      };
    }>(
      '/partners/me/usage',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: { ...dateFilters, ...cursorPaging },
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'reports:read');
        return options.service.listUsage({
          ...request.query,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{
      Querystring: {
        from?: string; to?: string;
        status?: 'CONFIRMED' | 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED' |
          'DISPUTED';
        cursor?: string; limit?: number;
      };
    }>(
      '/partners/me/bookings',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...dateFilters,
              status: {
                enum: [
                  'CONFIRMED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED',
                  'DISPUTED',
                ],
              },
              ...cursorPaging,
            },
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'reports:read');
        return options.service.listBookings({
          ...request.query,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{
      Querystring: {
        from?: string; to?: string;
        status?: 'DRAFT' | 'PENDING_FUNDS' | 'RECONCILING' | 'RECONCILED' |
          'COMPLETED' | 'FAILED' | 'REVERSED';
        cursor?: string; limit?: number;
      };
    }>(
      '/partners/me/settlements',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...dateFilters,
              status: {
                enum: [
                  'DRAFT', 'PENDING_FUNDS', 'RECONCILING', 'RECONCILED',
                  'COMPLETED', 'FAILED', 'REVERSED',
                ],
              },
              ...cursorPaging,
            },
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'finance:read');
        return options.service.listSettlements({
          ...request.query,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{ Params: { settlementId: string } }>(
      '/partners/me/settlements/:settlementId',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['settlementId'],
            properties: { settlementId: objectId },
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'finance:read');
        return options.service.getSettlement({
          settlementId: request.params.settlementId,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{
      Querystring: { cursor?: string; limit?: number };
    }>(
      '/partners/me/invoices',
      {
        config: { rawBody: true },
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: cursorPaging,
          },
        },
      },
      async (request) => {
        const partner = requirePartnerScope(request, 'finance:read');
        return options.service.listInvoices({
          ...request.query,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );

    fastify.get<{ Params: { invoiceId: string } }>(
      '/partners/me/invoices/:invoiceId',
      {
        config: { rawBody: true },
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
        const partner = requirePartnerScope(request, 'finance:read');
        return options.service.getInvoice({
          invoiceId: request.params.invoiceId,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
      },
    );
  };

export default partnerPortalRoutes;
