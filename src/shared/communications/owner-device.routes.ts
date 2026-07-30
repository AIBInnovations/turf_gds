import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../../modules/identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../../modules/identity/shared/auth-context.js';
import type { CommunicationsService } from './communications.service.js';

export interface OwnerDeviceRoutesOptions {
  service: CommunicationsService;
  ownerAccessService: OwnerAccessService;
}

const ownerDeviceRoutes: FastifyPluginAsync<OwnerDeviceRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );
    const params = {
      type: 'object',
      additionalProperties: false,
      required: ['deviceId'],
      properties: {
        deviceId: { type: 'string', minLength: 1, maxLength: 200 },
      },
    } as const;

    fastify.put<{
      Params: { deviceId: string };
      Body: { token: string; platform: 'ANDROID' | 'IOS' | 'WEB' };
    }>(
      '/devices/:deviceId',
      {
        preHandler: authenticate,
        schema: {
          params,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['token', 'platform'],
            properties: {
              token: { type: 'string', minLength: 20, maxLength: 4_096 },
              platform: { enum: ['ANDROID', 'IOS', 'WEB'] },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.registerDevice({
          ownerId: owner.ownerId,
          deviceId: request.params.deviceId,
          ...request.body,
        });
      },
    );

    fastify.delete<{ Params: { deviceId: string } }>(
      '/devices/:deviceId',
      { preHandler: authenticate, schema: { params } },
      async (request, reply) => {
        const owner = requireOwnerContext(request);
        await options.service.removeDevice({
          ownerId: owner.ownerId,
          deviceId: request.params.deviceId,
        });
        return reply.status(204).send();
      },
    );
  };

export default ownerDeviceRoutes;
