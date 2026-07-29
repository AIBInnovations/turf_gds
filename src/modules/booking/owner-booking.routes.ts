import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type { BookingStatus } from './booking.types.js';
import type { OwnerBookingService } from './owner-booking.service.js';

export interface OwnerBookingRoutesOptions {
  service: OwnerBookingService;
  ownerAccessService: OwnerAccessService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const statuses = [
  'CONFIRMED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
  'DISPUTED',
] as const;

const ownerBookingRoutes: FastifyPluginAsync<OwnerBookingRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );

    fastify.get<{
      Params: { venueId: string };
      Querystring: {
        courtId?: string;
        status?: BookingStatus;
        from?: string;
        to?: string;
        page?: number;
        limit?: number;
      };
    }>(
      '/:venueId/bookings',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId'],
            properties: { venueId: objectId },
          },
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              courtId: objectId,
              status: { type: 'string', enum: statuses },
              from: dateTime,
              to: dateTime,
              page: { type: 'integer', minimum: 1, default: 1 },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 50,
              },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.list({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          ...request.query,
        });
      },
    );

    fastify.get<{
      Params: { venueId: string; bookingId: string };
    }>(
      '/:venueId/bookings/:bookingId',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId', 'bookingId'],
            properties: {
              venueId: objectId,
              bookingId: objectId,
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getDetail({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          bookingId: request.params.bookingId,
        });
      },
    );
  };

export default ownerBookingRoutes;
