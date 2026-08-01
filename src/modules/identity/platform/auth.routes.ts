import type { FastifyPluginAsync } from 'fastify';

import {
  createAdminAuthenticationHook,
  requireAdminContext,
  getBearerToken,
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
  fastify.post('/logout',{preHandler:createAdminAuthenticationHook(options.service)},async(request,reply)=>{if(!options.service.logout)return reply.status(503).send({error:{code:'ADMIN_LOGOUT_UNAVAILABLE',message:'Admin logout is unavailable',requestId:request.id}});await options.service.logout(getBearerToken(request));return reply.status(204).send();});
};

export default adminAuthRoutes;
