import type { FastifyPluginAsync } from 'fastify';

import {
  createOwnerAuthenticationHook,
  getBearerToken,
  requireOwnerContext,
} from '../shared/auth-context.js';
import type { OwnerAccessService } from './owner-access.service.js';
import type { OwnerAccountClosureService } from './owner-account-closure.service.js';

export interface OwnerAccessRoutesOptions {
  service: OwnerAccessService;
  closureService: OwnerAccountClosureService;
}

const ownerAccessRoutes: FastifyPluginAsync<OwnerAccessRoutesOptions> = async (
  fastify,
  options,
) => {
  const authenticate = createOwnerAuthenticationHook(options.service);

  fastify.get('/me', { preHandler: authenticate }, async (request) => {
    const owner = requireOwnerContext(request);
    return options.service.getProfile(owner.ownerId);
  });

  fastify.post(
    '/logout',
    { preHandler: authenticate },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      await options.service.logout(owner.ownerId, getBearerToken(request));
      return reply.status(204).send();
    },
  );

  /** What would prevent this account from closing. Read-only, so the UI can warn before asking. */
  fastify.get(
    '/me/closure-blockers',
    { preHandler: authenticate },
    async (request) => {
      const owner = requireOwnerContext(request);
      const blockers = await options.closureService.checkBlockers(owner.ownerId);
      return { blockers, canClose: blockers.length === 0 };
    },
  );

  /**
   * Closes the account. `POST` rather than `DELETE`: nothing is deleted — the owner is suspended,
   * their sessions dropped and their contact details overwritten, while bookings and money
   * records stay for audit. The password is re-entered because a live session alone is a weak
   * gate for something irreversible.
   */
  fastify.post<{ Body: { password: string; reason?: string } }>(
    '/me/close',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 128 },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the same as
      // an absent key — the property is only spread in when the caller actually sent one.
      return options.closureService.closeAccount({
        ownerId: owner.ownerId,
        password: request.body.password,
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
      });
    },
  );

  fastify.post<{
    Params: { venueId: string };
    Body: {
      memberOwnerId: string;
      role: 'MANAGER' | 'STAFF';
    };
  }>(
    '/venues/:venueId/members',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          required: ['venueId'],
          properties: {
            venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['memberOwnerId', 'role'],
          properties: {
            memberOwnerId: {
              type: 'string',
              pattern: '^[a-fA-F0-9]{24}$',
            },
            role: { enum: ['MANAGER', 'STAFF'] },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.addMember({
        actingOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        memberOwnerId: request.body.memberOwnerId,
        role: request.body.role,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.get<{ Params: { venueId: string } }>(
    '/venues/:venueId/members',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['venueId'],
          properties: {
            venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listMembers(owner.ownerId, request.params.venueId);
    },
  );

  fastify.delete<{
    Params: { venueId: string; memberOwnerId: string };
  }>(
    '/venues/:venueId/members/:memberOwnerId',
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['venueId', 'memberOwnerId'],
          properties: {
            venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
            memberOwnerId: {
              type: 'string',
              pattern: '^[a-fA-F0-9]{24}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      await options.service.revokeMember({
        actingOwnerId: owner.ownerId,
        venueId: request.params.venueId,
        memberOwnerId: request.params.memberOwnerId,
      });
      return reply.status(204).send();
    },
  );
};

export default ownerAccessRoutes;
