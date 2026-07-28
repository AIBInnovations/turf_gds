import type { FastifyPluginAsync } from 'fastify';

import {
  createOwnerAuthenticationHook,
  getBearerToken,
  requireOwnerContext,
} from '../shared/auth-context.js';
import type { OwnerAccessService } from './owner-access.service.js';

export interface OwnerAccessRoutesOptions {
  service: OwnerAccessService;
}

const ownerAccessRoutes: FastifyPluginAsync<OwnerAccessRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(options.service);

    fastify.get(
      '/me',
      { preHandler: authenticate },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getProfile(owner.ownerId);
      },
    );

    fastify.post(
      '/logout',
      { preHandler: authenticate },
      async (request, reply) => {
        const owner = requireOwnerContext(request);
        await options.service.logout(
          owner.ownerId,
          getBearerToken(request),
        );
        return reply.status(204).send();
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
        return options.service.listMembers(
          owner.ownerId,
          request.params.venueId,
        );
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
