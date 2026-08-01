import type { FastifyPluginAsync } from 'fastify';
import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { createOwnerAuthenticationHook, requireOwnerContext } from '../../identity/shared/auth-context.js';
import type { OwnerDashboardService } from './owner-dashboard.service.js';

export interface OwnerDashboardRoutesOptions { service: OwnerDashboardService; ownerAccessService: OwnerAccessService }
const routes: FastifyPluginAsync<OwnerDashboardRoutesOptions> = async (fastify, options) => {
  const auth = createOwnerAuthenticationHook(options.ownerAccessService);
  fastify.get<{ Params: { venueId: string }; Querystring: { from?: string; to?: string } }>('/:venueId/dashboard', { preHandler: auth, schema: {
    params: { type: 'object', additionalProperties: false, required: ['venueId'], properties: { venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } },
  } }, async (request) => {
    const owner = requireOwnerContext(request);
    return options.service.get({ actorOwnerId: owner.ownerId, venueId: request.params.venueId, ...request.query });
  });
};
export default routes;
