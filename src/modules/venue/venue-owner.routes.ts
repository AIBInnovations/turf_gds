import type { FastifyPluginAsync } from 'fastify';

import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import type {
  UpdateVenueProfileInput,
  VenueOwnerService,
} from './venue-owner.service.js';

export interface VenueOwnerRoutesOptions {
  service: VenueOwnerService;
  ownerAccessService: OwnerAccessService;
}

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['venueId'],
  properties: {
    venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
  },
} as const;

const venueOwnerRoutes: FastifyPluginAsync<VenueOwnerRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );

    fastify.get<{ Params: { venueId: string } }>(
      '/:venueId',
      {
        preHandler: authenticate,
        schema: { params: idParamsSchema },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getProfile({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
        });
      },
    );

    fastify.patch<{
      Params: { venueId: string };
      Body: Omit<
        UpdateVenueProfileInput,
        'actorOwnerId' | 'venueId' | 'correlationId' | 'expectedVersion'
      > & { version: number };
    }>(
      '/:venueId',
      {
        preHandler: authenticate,
        schema: {
          params: idParamsSchema,
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 2,
            required: ['version'],
            properties: {
              version: { type: 'integer', minimum: 1 },
              legalName: { type: 'string', minLength: 2, maxLength: 200 },
              displayName: {
                type: 'string',
                minLength: 2,
                maxLength: 200,
              },
              timezone: { type: 'string', minLength: 3, maxLength: 100 },
              address: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'line1',
                  'city',
                  'state',
                  'postalCode',
                  'country',
                ],
                properties: {
                  line1: { type: 'string', minLength: 2, maxLength: 200 },
                  line2: { type: 'string', maxLength: 200 },
                  city: { type: 'string', minLength: 2, maxLength: 100 },
                  state: { type: 'string', minLength: 2, maxLength: 100 },
                  postalCode: {
                    type: 'string',
                    minLength: 3,
                    maxLength: 20,
                  },
                  country: {
                    type: 'string',
                    minLength: 2,
                    maxLength: 2,
                  },
                },
              },
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: {
                type: 'number',
                minimum: -180,
                maximum: 180,
              },
              currency: { type: 'string', enum: ['INR'] },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        const { version, ...changes } = request.body;
        return options.service.updateProfile({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          correlationId: request.id,
          expectedVersion: version,
          ...changes,
        });
      },
    );

    fastify.post<{
      Params: { venueId: string };
      Querystring: { version: number };
    }>(
      '/:venueId/media',
      {
        preHandler: authenticate,
        schema: {
          params: idParamsSchema,
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
              code: 'VENUE_MEDIA_FILE_REQUIRED',
              message: 'A multipart media file is required',
              requestId: request.id,
            },
          });
        }

        const result = await options.service.addMedia({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          correlationId: request.id,
          expectedVersion: request.query.version,
          filename: part.filename,
          mimeType: part.mimetype,
          buffer: await part.toBuffer(),
        });
        return reply.status(201).send(result);
      },
    );
  };

export default venueOwnerRoutes;
