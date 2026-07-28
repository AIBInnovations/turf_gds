import type { FastifyPluginAsync } from 'fastify';

import {
  createAdminAuthenticationHook,
  requireAdminContext,
} from '../shared/auth-context.js';
import type { AdminAuthService } from './auth.service.js';

export interface AdminAuthRoutesOptions {
  service: AdminAuthService;
}

const adminAuthRoutes: FastifyPluginAsync<AdminAuthRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.post<{
    Body: { email: string; password: string };
  }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request) => options.service.login(request.body),
  );

  fastify.get(
    '/me',
    { preHandler: createAdminAuthenticationHook(options.service) },
    async (request) => {
      const admin = requireAdminContext(request);
      return {
        id: admin.adminId,
        role: admin.role,
      };
    },
  );
};

export default adminAuthRoutes;
