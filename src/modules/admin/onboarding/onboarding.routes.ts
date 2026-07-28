import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminContext,
} from '../../identity/shared/auth-context.js';
import type { AdminOnboardingService } from './onboarding.service.js';

export interface AdminOnboardingRoutesOptions {
  service: AdminOnboardingService;
  adminAuthService: AdminAuthService;
}

const adminOnboardingRoutes: FastifyPluginAsync<
  AdminOnboardingRoutesOptions
> = async (fastify, options) => {
  fastify.post<{
    Params: { venueId: string };
    Body: { ownerId: string };
  }>(
    '/venues/:venueId/approve',
    {
      preHandler: createAdminAuthenticationHook(options.adminAuthService),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ownerId'],
          properties: {
            ownerId: { type: 'string', minLength: 24, maxLength: 24 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireAdminContext(request);

      await options.service.approveVenueOnboarding({
        ownerId: request.body.ownerId,
        venueId: request.params.venueId,
        adminId: admin.adminId,
        correlationId: request.id,
      });

      return reply.status(204).send();
    },
  );
};

export default adminOnboardingRoutes;
