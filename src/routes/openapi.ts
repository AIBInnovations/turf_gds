import type { FastifyPluginAsync } from 'fastify';

import { buildOpenApiSpec } from '../shared/openapi/build-spec.js';

/**
 * Serves the machine-readable API description that Partners integrate against.
 *
 * Generated from the JSON Schemas already attached to every route rather than
 * hand-maintained, so a route can never be added without appearing here.
 * `?partner=true` narrows it to the Partner-facing surface.
 */
const openapiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { partner?: string } }>(
    '/openapi.json',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { partner: { enum: ['true', 'false'] } },
        },
      },
    },
    async (request) =>
      buildOpenApiSpec({
        title: 'Turf GDS B2B API',
        version: '1.0.0',
        description:
          'Backend APIs for Venue Owners, Booking Partners, inventory ' +
          'distribution and financial close.',
        serverUrl: '/api/v1',
        routes: fastify.collectedRoutes ?? [],
        partnerOnly: request.query.partner === 'true',
      }),
  );
};

export default openapiRoutes;
