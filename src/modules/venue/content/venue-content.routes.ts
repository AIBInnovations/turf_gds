import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { createOwnerAuthenticationHook, requireOwnerContext } from '../../identity/shared/auth-context.js';
import type { VenueContentService } from './venue-content.service.js';

export interface VenueContentRoutesOptions { service: VenueContentService; ownerAccessService: OwnerAccessService }
const params = { type: 'object', additionalProperties: false, required: ['venueId'], properties: { venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } } as const;
const query = { type: 'object', additionalProperties: false, properties: { locale: { type: 'string', minLength: 2, maxLength: 35 } } } as const;

const routes: FastifyPluginAsync<VenueContentRoutesOptions> = async (fastify, options) => {
  const auth = createOwnerAuthenticationHook(options.ownerAccessService);
  fastify.get<{ Params: { venueId: string }; Querystring: { locale?: string } }>('/:venueId/content', { preHandler: auth, schema: { params, querystring: query } }, async (request) => {
    const owner = requireOwnerContext(request);
    return options.service.get({ actorOwnerId: owner.ownerId, venueId: request.params.venueId, ...request.query });
  });
  fastify.put<{ Params: { venueId: string }; Querystring: { locale?: string }; Body: { version?: number; content: Record<string, unknown> } }>('/:venueId/content', { preHandler: auth, schema: { params, querystring: query, body: {
    type: 'object', additionalProperties: false, required: ['content'], properties: {
      version: { type: 'integer', minimum: 0 }, content: { type: 'object', additionalProperties: true },
    },
  } } }, async (request) => {
    const owner = requireOwnerContext(request);
    return options.service.put({ actorOwnerId: owner.ownerId, venueId: request.params.venueId, correlationId: request.id, ...request.query, ...request.body });
  });
};
export default routes;
