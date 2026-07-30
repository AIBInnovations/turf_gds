import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type { FinancialCloseService } from './financial-close.service.js';

export interface OwnerFinanceRoutesOptions {
  service: FinancialCloseService;
  ownerAccessService: OwnerAccessService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;

const ownerFinanceRoutes: FastifyPluginAsync<OwnerFinanceRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );

    fastify.get<{
      Params: { venueId: string };
      Querystring: Omit<Parameters<
        FinancialCloseService['listOwnerSettlements']
      >[0], 'actorOwnerId' | 'venueId'>;
    }>(
      '/:venueId/finance/settlements',
      {
        preHandler: authenticate,
        schema: {
          params: venueParams(),
          querystring: listQuery([
            'DRAFT', 'PENDING_FUNDS', 'RECONCILING', 'RECONCILED',
            'COMPLETED', 'FAILED', 'REVERSED',
          ]),
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.listOwnerSettlements({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          ...request.query,
        });
      },
    );

    fastify.get<{
      Params: { venueId: string; settlementId: string };
    }>(
      '/:venueId/finance/settlements/:settlementId',
      {
        preHandler: authenticate,
        schema: { params: financeParams('settlementId') },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getOwnerSettlement({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          settlementId: request.params.settlementId,
        });
      },
    );

    fastify.get<{
      Params: { venueId: string };
      Querystring: Omit<Parameters<
        FinancialCloseService['listOwnerPayouts']
      >[0], 'actorOwnerId' | 'venueId'>;
    }>(
      '/:venueId/finance/payouts',
      {
        preHandler: authenticate,
        schema: {
          params: venueParams(),
          querystring: listQuery([
            'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED',
          ]),
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.listOwnerPayouts({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          ...request.query,
        });
      },
    );

    fastify.get<{ Params: { venueId: string; payoutId: string } }>(
      '/:venueId/finance/payouts/:payoutId',
      {
        preHandler: authenticate,
        schema: { params: financeParams('payoutId') },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getOwnerPayout({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          payoutId: request.params.payoutId,
        });
      },
    );
  };

function venueParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId'],
    properties: { venueId: objectId },
  } as const;
}

function financeParams(resource: 'settlementId' | 'payoutId') {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId', resource],
    properties: { venueId: objectId, [resource]: objectId },
  } as const;
}

function listQuery(statuses: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { enum: statuses },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  } as const;
}

export default ownerFinanceRoutes;
