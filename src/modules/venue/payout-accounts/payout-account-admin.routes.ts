import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminRole,
} from '../../identity/shared/auth-context.js';
import type { PayoutAccountService } from './payout-account.service.js';

export interface PayoutAccountAdminRoutesOptions {
  service: PayoutAccountService;
  adminAuthService: AdminAuthService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;

const payoutAccountAdminRoutes: FastifyPluginAsync<
  PayoutAccountAdminRoutesOptions
> = async (fastify, options) => {
  fastify.post<{
    Params: { venueId: string; accountId: string };
    Body: {
      outcome: 'VERIFIED' | 'FAILED';
      verificationMethod: 'PENNY_DROP' | 'MANUAL';
      failureReason?: string;
    };
  }>(
    '/:venueId/payout-accounts/:accountId/verification',
    {
      preHandler: createAdminAuthenticationHook(options.adminAuthService),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['venueId', 'accountId'],
          properties: { venueId: objectId, accountId: objectId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['outcome', 'verificationMethod'],
          properties: {
            outcome: { enum: ['VERIFIED', 'FAILED'] },
            verificationMethod: { enum: ['PENNY_DROP', 'MANUAL'] },
            failureReason: {
              type: 'string',
              minLength: 1,
              maxLength: 1_000,
            },
          },
        },
      },
    },
    async (request) => {
      const admin = requireAdminRole(request);
      return options.service.verify({
        adminId: admin.adminId,
        venueId: request.params.venueId,
        accountId: request.params.accountId,
        correlationId: request.id,
        ...request.body,
      });
    },
  );
};

export default payoutAccountAdminRoutes;
