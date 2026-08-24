import type { FastifyPluginAsync } from 'fastify';

import {
  createAdminAuthenticationHook,
  requireAdminContext,
  getBearerToken,
} from '../shared/auth-context.js';
import { maskPhone } from '../owner/msg91-otp.provider.js';
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

  fastify.post<{
    Body: { phoneE164: string; accessToken: string };
  }>(
    '/otp/verify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['phoneE164', 'accessToken'],
          properties: {
            phoneE164: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
            accessToken: { type: 'string', minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request) => {
      const phone = maskPhone(request.body.phoneE164);
      request.log.info({ phone }, 'Admin OTP sign-in attempt');
      try {
        const result = await options.service.otpLogin(request.body);
        request.log.info(
          { phone, adminId: result.admin.id, role: result.admin.role },
          'Admin OTP sign-in succeeded',
        );
        return result;
      } catch (error) {
        request.log.warn(
          { phone, code: (error as { code?: string }).code ?? 'UNKNOWN' },
          'Admin OTP sign-in failed',
        );
        throw error;
      }
    },
  );

  /**
   * Self-service: an already-authenticated admin attaches a verified phone number to their own
   * account. This is the backfill path for every admin bootstrapped before phone+OTP login
   * existed — there is no self-registration screen for admins, so this is the only way in.
   */
  fastify.post<{
    Body: { phoneE164: string; accessToken: string };
  }>(
    '/me/phone',
    {
      preHandler: createAdminAuthenticationHook(options.service),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['phoneE164', 'accessToken'],
          properties: {
            phoneE164: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
            accessToken: { type: 'string', minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireAdminContext(request);
      const phone = maskPhone(request.body.phoneE164);
      request.log.info({ phone, adminId: admin.adminId }, 'Admin phone enrolment attempt');
      try {
        await options.service.setPhone({ adminId: admin.adminId, ...request.body });
        request.log.info(
          { phone, adminId: admin.adminId },
          'Admin phone enrolled — OTP sign-in now available for this account',
        );
        return reply.status(204).send();
      } catch (error) {
        request.log.warn(
          {
            phone,
            adminId: admin.adminId,
            code: (error as { code?: string }).code ?? 'UNKNOWN',
          },
          'Admin phone enrolment failed',
        );
        throw error;
      }
    },
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
  fastify.post(
    '/logout',
    { preHandler: createAdminAuthenticationHook(options.service) },
    async (request, reply) => {
      if (!options.service.logout)
        return reply
          .status(503)
          .send({
            error: {
              code: 'ADMIN_LOGOUT_UNAVAILABLE',
              message: 'Admin logout is unavailable',
              requestId: request.id,
            },
          });
      await options.service.logout(getBearerToken(request));
      return reply.status(204).send();
    },
  );
};

export default adminAuthRoutes;
