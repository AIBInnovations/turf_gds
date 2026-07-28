import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type { VenueOperationsService } from './venue-operations.service.js';

export interface VenueOperationsRoutesOptions {
  service: VenueOperationsService;
  ownerAccessService: OwnerAccessService;
}

const objectId = {
  type: 'string',
  pattern: '^[a-fA-F0-9]{24}$',
} as const;

const dateTime = {
  type: 'string',
  format: 'date-time',
} as const;

const venueOperationsRoutes: FastifyPluginAsync<
  VenueOperationsRoutesOptions
> = async (fastify, options) => {
  const authenticate = createOwnerAuthenticationHook(
    options.ownerAccessService,
  );

  fastify.post<{
    Params: { venueId: string; courtId: string };
    Body: PricingBody;
  }>(
    '/:venueId/courts/:courtId/pricing-rules',
    {
      preHandler: authenticate,
      schema: {
        params: courtParams(),
        body: pricingBodySchema(true),
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.createPricingRule({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        ...request.body,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.get<{ Params: { venueId: string; courtId: string } }>(
    '/:venueId/courts/:courtId/pricing-rules',
    {
      preHandler: authenticate,
      schema: { params: courtParams() },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listPricingRules({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
      });
    },
  );

  fastify.patch<{
    Params: {
      venueId: string;
      courtId: string;
      pricingRuleId: string;
    };
    Body: Partial<PricingBody> & {
      effectiveTo?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
    };
  }>(
    '/:venueId/courts/:courtId/pricing-rules/:pricingRuleId',
    {
      preHandler: authenticate,
      schema: {
        params: pricingParams(),
        body: {
          ...pricingBodySchema(false),
          minProperties: 1,
          properties: {
            ...pricingBodySchema(false).properties,
            effectiveTo: {
              anyOf: [dateTime, { type: 'null' }],
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE'],
            },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.updatePricingRule({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        pricingRuleId: request.params.pricingRuleId,
        ...request.body,
      });
    },
  );

  fastify.post<{
    Params: { venueId: string; courtId: string };
    Body: { dateFrom: string; dateTo: string };
  }>(
    '/:venueId/courts/:courtId/slots/generate',
    {
      preHandler: authenticate,
      schema: {
        params: courtParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['dateFrom', 'dateTo'],
          properties: {
            dateFrom: { type: 'string', format: 'date' },
            dateTo: { type: 'string', format: 'date' },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.generateFixedSlots({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        dateFrom: request.body.dateFrom,
        dateTo: request.body.dateTo,
        correlationId: request.id,
      });
    },
  );

  fastify.get<{
    Params: { venueId: string; courtId: string };
    Querystring: { from: string; to: string };
  }>(
    '/:venueId/courts/:courtId/inventory',
    {
      preHandler: authenticate,
      schema: {
        params: courtParams(),
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: dateTime, to: dateTime },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listInventory({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        from: request.query.from,
        to: request.query.to,
      });
    },
  );

  fastify.post<{
    Params: { venueId: string; courtId: string };
    Body: {
      reason: string;
      slotId?: string;
      slotVersion?: number;
      courtVersion?: number;
      startsAt?: string;
      endsAt?: string;
    };
  }>(
    '/:venueId/courts/:courtId/inventory/block',
    {
      preHandler: authenticate,
      schema: {
        params: courtParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            slotId: objectId,
            slotVersion: { type: 'integer', minimum: 1 },
            courtVersion: { type: 'integer', minimum: 1 },
            startsAt: dateTime,
            endsAt: dateTime,
          },
          oneOf: [
            { required: ['slotId', 'slotVersion'] },
            { required: ['courtVersion', 'startsAt', 'endsAt'] },
          ],
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.blockAvailability({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        correlationId: request.id,
        ...request.body,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post<{
    Params: { venueId: string; courtId: string; slotId: string };
    Body: { version: number; reason: string };
  }>(
    '/:venueId/courts/:courtId/inventory/:slotId/release',
    {
      preHandler: authenticate,
      schema: {
        params: slotParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version', 'reason'],
          properties: {
            version: { type: 'integer', minimum: 1 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.releaseAvailability({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        courtId: request.params.courtId,
        slotId: request.params.slotId,
        expectedVersion: request.body.version,
        reason: request.body.reason,
        correlationId: request.id,
      });
      return result
        ? reply.send(result)
        : reply.status(204).send();
    },
  );

  fastify.get<{ Params: { venueId: string } }>(
    '/:venueId/content',
    {
      preHandler: authenticate,
      schema: { params: venueParams() },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.getContent({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
      });
    },
  );

  fastify.put<{
    Params: { venueId: string };
    Body: { version?: number; content: Record<string, unknown> };
  }>(
    '/:venueId/content',
    {
      preHandler: authenticate,
      schema: {
        params: venueParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['content'],
          properties: {
            version: { type: 'integer', minimum: 1 },
            content: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.saveContent({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        ...(request.body.version !== undefined
          ? { expectedVersion: request.body.version }
          : {}),
        content: request.body.content,
      });
    },
  );

  fastify.post<{
    Params: { venueId: string };
    Body: PayoutBody;
  }>(
    '/:venueId/payout-accounts',
    {
      preHandler: authenticate,
      schema: {
        params: venueParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'accountHolderName',
            'vaultProvider',
            'vaultAccountToken',
            'accountLast4',
            'bankName',
            'ifscCode',
          ],
          properties: {
            accountHolderName: text(2, 160),
            vaultProvider: text(2, 80),
            vaultAccountToken: text(12, 500),
            accountLast4: {
              type: 'string',
              pattern: '^[0-9]{4}$',
            },
            bankName: text(2, 160),
            ifscCode: {
              type: 'string',
              pattern: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.addPayoutAccount({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        ...request.body,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.get<{ Params: { venueId: string } }>(
    '/:venueId/payout-accounts',
    {
      preHandler: authenticate,
      schema: { params: venueParams() },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listPayoutAccounts({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
      });
    },
  );
};

interface PricingBody {
  name: string;
  daysOfWeek: number[];
  startsTime: string;
  endsTime: string;
  amountMinor: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  priority: number;
}

interface PayoutBody {
  accountHolderName: string;
  vaultProvider: string;
  vaultAccountToken: string;
  accountLast4: string;
  bankName: string;
  ifscCode: string;
}

function pricingBodySchema(required: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required
      ? {
          required: [
            'name',
            'daysOfWeek',
            'startsTime',
            'endsTime',
            'amountMinor',
            'currency',
            'effectiveFrom',
            'priority',
          ],
        }
      : {}),
    properties: {
      name: text(2, 120),
      daysOfWeek: {
        type: 'array',
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1, maximum: 7 },
      },
      startsTime: timeSchema(),
      endsTime: timeSchema(),
      amountMinor: {
        type: 'integer',
        minimum: 0,
        maximum: 100_000_000,
      },
      currency: { type: 'string', enum: ['INR'] },
      effectiveFrom: dateTime,
      effectiveTo: dateTime,
      priority: {
        type: 'integer',
        minimum: -1000,
        maximum: 1000,
      },
    },
  } as const;
}

function venueParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId'],
    properties: { venueId: objectId },
  } as const;
}

function courtParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId', 'courtId'],
    properties: { venueId: objectId, courtId: objectId },
  } as const;
}

function pricingParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId', 'courtId', 'pricingRuleId'],
    properties: {
      venueId: objectId,
      courtId: objectId,
      pricingRuleId: objectId,
    },
  } as const;
}

function slotParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId', 'courtId', 'slotId'],
    properties: {
      venueId: objectId,
      courtId: objectId,
      slotId: objectId,
    },
  } as const;
}

function timeSchema() {
  return {
    type: 'string',
    pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
  } as const;
}

function text(minLength: number, maxLength: number) {
  return { type: 'string', minLength, maxLength } as const;
}

export default venueOperationsRoutes;
