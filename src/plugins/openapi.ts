import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { CollectedRoute } from '../shared/openapi/build-spec.js';

declare module 'fastify' {
  interface FastifyInstance {
    collectedRoutes: CollectedRoute[];
  }
}

/**
 * Records every route registered after this plugin.
 *
 * `onRoute` on the root instance fires for routes declared inside encapsulated
 * plugins too, and supplies the fully-prefixed URL — which is exactly what the
 * spec needs and what hand-maintaining a path list always gets wrong.
 * Register before the route plugins.
 */
const openapiCollectorPlugin: FastifyPluginAsync = async (fastify) => {
  const collected: CollectedRoute[] = [];
  fastify.decorate('collectedRoutes', collected);

  fastify.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      collected.push({
        method,
        url: routeOptions.url,
        schema: routeOptions.schema as Record<string, unknown> | undefined,
        docs: (
          routeOptions.config as { docs?: CollectedRoute['docs'] } | undefined
        )?.docs,
      });
    }
  });
};

export default fp(openapiCollectorPlugin, {
  name: 'openapi-collector',
  fastify: '5.x',
});
