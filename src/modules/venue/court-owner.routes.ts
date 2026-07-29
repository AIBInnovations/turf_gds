import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type {
  CourtOwnerService,
  CreateCourtInput,
  UpdateCourtInput,
} from './court-owner.service.js';

export interface CourtOwnerRoutesOptions {
  service: CourtOwnerService;
  ownerAccessService: OwnerAccessService;
}

const objectIdSchema = {
  type: 'string',
  pattern: '^[a-fA-F0-9]{24}$',
} as const;

const bookingModeSchema = {
  type: 'string',
  enum: ['OPEN_TIME', 'FIXED_SLOT', 'BOTH'],
} as const;

const courtProperties = {
  name: { type: 'string', minLength: 2, maxLength: 120 },
  sportType: {
    type: 'string',
    enum: [
      'FOOTBALL', 'CRICKET', 'BADMINTON', 'TENNIS', 'PICKLEBALL',
      'MULTI_SPORT', 'OTHER',
    ],
  },
  surfaceType: { type: 'string', minLength: 1, maxLength: 100 },
  capacity: { type: 'integer', minimum: 1, maximum: 100000 },
  bookingMode: bookingModeSchema,
  minBookingMinutes: {
    type: 'integer',
    minimum: 60,
    maximum: 1440,
  },
  bookingIncrementMinutes: {
    type: 'integer',
    minimum: 5,
    maximum: 1440,
  },
  fixedSlotDurationMinutes: {
    anyOf: [{ type: 'integer', minimum: 5 }, { type: 'null' }],
  },
  fixedSlotAnchorMinutes: {
    anyOf: [
      { type: 'integer', minimum: 0, maximum: 1439 },
      { type: 'null' },
    ],
  },
} as const;

const courtOwnerRoutes: FastifyPluginAsync<CourtOwnerRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );

    fastify.post<{
      Params: { venueId: string };
      Body: Omit<
        CreateCourtInput,
        'actorOwnerId' | 'venueId' | 'correlationId'
      >;
    }>(
      '/:venueId/courts',
      {
        preHandler: authenticate,
        schema: {
          params: venueParamsSchema(),
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name',
              'sportType',
              'surfaceType',
              'capacity',
              'bookingMode',
              'minBookingMinutes',
              'bookingIncrementMinutes',
            ],
            properties: courtProperties,
          },
        },
      },
      async (request, reply) => {
        const owner = requireOwnerContext(request);
        const result = await options.service.create({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          correlationId: request.id,
          ...request.body,
        });
        return reply.status(201).send(result);
      },
    );

    fastify.get<{ Params: { venueId: string } }>(
      '/:venueId/courts',
      {
        preHandler: authenticate,
        schema: { params: venueParamsSchema() },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.list({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
        });
      },
    );

    fastify.get<{
      Params: { venueId: string; courtId: string };
    }>(
      '/:venueId/courts/:courtId',
      {
        preHandler: authenticate,
        schema: { params: courtParamsSchema() },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.get({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          courtId: request.params.courtId,
        });
      },
    );

    fastify.patch<{
      Params: { venueId: string; courtId: string };
      Body: Omit<
        UpdateCourtInput,
        | 'actorOwnerId'
        | 'venueId'
        | 'courtId'
        | 'correlationId'
        | 'expectedVersion'
      > & { version: number };
    }>(
      '/:venueId/courts/:courtId',
      {
        preHandler: authenticate,
        schema: {
          params: courtParamsSchema(),
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 2,
            required: ['version'],
            properties: {
              version: { type: 'integer', minimum: 1 },
              ...courtProperties,
              status: {
                type: 'string',
                enum: ['AVAILABLE', 'UNAVAILABLE'],
              },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        const { version, ...changes } = request.body;
        return options.service.update({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          courtId: request.params.courtId,
          correlationId: request.id,
          expectedVersion: version,
          ...changes,
        });
      },
    );

    fastify.post<{
      Params: { venueId: string; courtId: string };
      Querystring: { version: number };
    }>(
      '/:venueId/courts/:courtId/media',
      {
        preHandler: authenticate,
        schema: {
          params: courtParamsSchema(),
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['version'],
            properties: {
              version: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (request, reply) => {
        const owner = requireOwnerContext(request);
        const part = await request.file();

        if (!part) {
          return reply.status(400).send({
            error: {
              code: 'COURT_MEDIA_FILE_REQUIRED',
              message: 'A multipart media file is required',
              requestId: request.id,
            },
          });
        }

        const result = await options.service.addMedia({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          courtId: request.params.courtId,
          correlationId: request.id,
          expectedVersion: request.query.version,
          filename: part.filename,
          mimeType: part.mimetype,
          buffer: await part.toBuffer(),
        });
        return reply.status(201).send(result);
      },
    );

    fastify.put<{
      Params: { venueId: string; courtId: string };
      Body: {
        version: number;
        operatingHours: Array<{
          dayOfWeek: number;
          opensAt: string;
          closesAt: string;
        }>;
      };
    }>(
      '/:venueId/courts/:courtId/operating-hours',
      {
        preHandler: authenticate,
        schema: {
          params: courtParamsSchema(),
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'operatingHours'],
            properties: {
              version: { type: 'integer', minimum: 1 },
              operatingHours: {
                type: 'array',
                maxItems: 7,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['dayOfWeek', 'opensAt', 'closesAt'],
                  properties: {
                    dayOfWeek: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 7,
                    },
                    opensAt: {
                      type: 'string',
                      pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
                    },
                    closesAt: {
                      type: 'string',
                      pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.setOperatingHours({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          courtId: request.params.courtId,
          correlationId: request.id,
          expectedVersion: request.body.version,
          operatingHours: request.body.operatingHours,
        });
      },
    );
  };

function venueParamsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId'],
    properties: { venueId: objectIdSchema },
  } as const;
}

function courtParamsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId', 'courtId'],
    properties: {
      venueId: objectIdSchema,
      courtId: objectIdSchema,
    },
  } as const;
}

export default courtOwnerRoutes;
