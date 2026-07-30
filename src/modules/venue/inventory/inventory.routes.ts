import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../../identity/shared/auth-context.js';
import type { InventoryService } from './inventory.service.js';

export interface InventoryRoutesOptions {
  service: InventoryService;
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

const inventoryRoutes: FastifyPluginAsync<
  InventoryRoutesOptions
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
      active?: boolean;
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
            active: { type: 'boolean' },
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

};

interface PricingBody {
  name: string;
  dayOfWeek?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  priceMinor: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  priority: number;
}

function pricingBodySchema(required: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required
      ? {
          required: [
            'name',
            'priceMinor',
            'currency',
            'effectiveFrom',
            'priority',
          ],
        }
      : {}),
    properties: {
      name: text(2, 120),
      dayOfWeek: {
        anyOf: [
          { type: 'integer', minimum: 1, maximum: 7 },
          { type: 'null' },
        ],
      },
      startTime: { anyOf: [timeSchema(), { type: 'null' }] },
      endTime: { anyOf: [timeSchema(), { type: 'null' }] },
      priceMinor: {
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

export default inventoryRoutes;
