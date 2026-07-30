import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { AdminAuthService } from '../../modules/identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminContext,
} from '../../modules/identity/shared/auth-context.js';
import { AppError } from '../errors/app-error.js';
import type { CommunicationsService } from './communications.service.js';

export interface AdminCommunicationsRoutesOptions {
  service: CommunicationsService;
  adminAuthService: AdminAuthService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;

const adminCommunicationsRoutes: FastifyPluginAsync<
  AdminCommunicationsRoutesOptions
> = async (fastify, options) => {
  const authenticate = createAdminAuthenticationHook(
    options.adminAuthService,
  );

  fastify.get<{
    Querystring: Parameters<CommunicationsService['listDeliveries']>[0];
  }>(
    '/deliveries',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            partnerId: objectId,
            endpointId: objectId,
            environment: { enum: ['SANDBOX', 'PRODUCTION'] },
            eventType: { type: 'string', minLength: 1, maxLength: 100 },
            status: {
              enum: ['PENDING', 'RETRYING', 'DELIVERED', 'FAILED'],
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
      return options.service.listDeliveries(request.query);
    },
  );

  fastify.get<{ Params: { eventId: string } }>(
    '/events/:eventId',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['eventId'],
          properties: { eventId: objectId },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.getEvent(request.params.eventId);
    },
  );

  fastify.post<{
    Params: { eventId: string; endpointId: string };
  }>(
    '/events/:eventId/endpoints/:endpointId/retry',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['eventId', 'endpointId'],
          properties: { eventId: objectId, endpointId: objectId },
        },
      },
    },
    async (request, reply) => {
      requireCommunicationsOperator(request);
      await options.service.retryDelivery(request.params);
      return reply.status(204).send();
    },
  );
};

function requireCommunicationsOperator(request: FastifyRequest): void {
  const admin = requireAdminContext(request);
  if (admin.role === 'SUPPORT') {
    throw new AppError({
      code: 'COMMUNICATIONS_OPERATOR_REQUIRED',
      message: 'ADMIN or OPS role is required to retry deliveries',
      statusCode: 403,
    });
  }
}

export default adminCommunicationsRoutes;
