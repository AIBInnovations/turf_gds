import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../../modules/identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../../modules/identity/shared/auth-context.js';
import type { CommunicationsService } from './communications.service.js';

export interface OwnerCommunicationsRoutesOptions {
  service: CommunicationsService;
  ownerAccessService: OwnerAccessService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const notificationTypes = [
  'BOOKING_CONFIRMED',
  'BOOKING_CANCELLED',
  'PAYOUT_COMPLETED',
] as const;

const ownerCommunicationsRoutes: FastifyPluginAsync<
  OwnerCommunicationsRoutesOptions
> = async (fastify, options) => {
  const authenticate = createOwnerAuthenticationHook(
    options.ownerAccessService,
  );

  fastify.get<{
    Querystring: {
      venueId?: string;
      type?: (typeof notificationTypes)[number];
      unreadOnly?: boolean;
      page?: number;
      limit?: number;
    };
  }>(
    '/notifications',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            venueId: objectId,
            type: { enum: [...notificationTypes] },
            unreadOnly: { type: 'boolean' },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listNotifications({
        ownerId: owner.ownerId,
        ...request.query,
      });
    },
  );

  fastify.patch<{
    Body: {
      notificationType: (typeof notificationTypes)[number];
      aggregateType: 'BOOKING' | 'PAYOUT';
      aggregateId: string;
    };
  }>(
    '/notifications/read',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['notificationType', 'aggregateType', 'aggregateId'],
          properties: {
            notificationType: { enum: [...notificationTypes] },
            aggregateType: { enum: ['BOOKING', 'PAYOUT'] },
            aggregateId: objectId,
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      await options.service.markNotificationRead({
        ownerId: owner.ownerId,
        ...request.body,
      });
      return reply.status(204).send();
    },
  );
};

export default ownerCommunicationsRoutes;
