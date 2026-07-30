import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../../identity/shared/auth-context.js';
import type { PayoutAccountService } from './payout-account.service.js';

export interface PayoutAccountOwnerRoutesOptions {
  service: PayoutAccountService;
  ownerAccessService: OwnerAccessService;
}

const payoutAccountOwnerRoutes: FastifyPluginAsync<
  PayoutAccountOwnerRoutesOptions
> = async (fastify, options) => {
  const authenticate = createOwnerAuthenticationHook(
    options.ownerAccessService,
  );
  fastify.post<{
    Params: { venueId: string };
    Body: {
      accountHolderName: string;
      vaultProvider: string;
      vaultAccountToken: string;
      accountLast4: string;
      bankName: string;
      ifscCode: string;
    };
  }>(
    '/:venueId/payout-accounts',
    {
      preHandler: authenticate,
      schema: {
        params: venueParams(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'accountHolderName',
            'vaultProvider',
            'vaultAccountToken',
            'accountLast4',
            'bankName',
            'ifscCode',
          ],
          properties: {
            accountHolderName: text(2, 160),
            vaultProvider: text(2, 80),
            vaultAccountToken: text(12, 500),
            accountLast4: { type: 'string', pattern: '^[0-9]{4}$' },
            bankName: text(2, 160),
            ifscCode: {
              type: 'string',
              pattern: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      return reply.status(201).send(await options.service.add({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        ...request.body,
      }));
    },
  );
  fastify.get<{ Params: { venueId: string } }>(
    '/:venueId/payout-accounts',
    {
      preHandler: authenticate,
      schema: { params: venueParams() },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.list({
        actorOwnerId: owner.ownerId,
        venueId: request.params.venueId,
      });
    },
  );
};

function venueParams() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['venueId'],
    properties: {
      venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
    },
  } as const;
}

function text(minLength: number, maxLength: number) {
  return { type: 'string', minLength, maxLength } as const;
}

export default payoutAccountOwnerRoutes;
