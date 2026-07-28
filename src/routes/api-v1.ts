import type { FastifyPluginAsync } from 'fastify';

const apiV1Routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => ({
    service: 'turf-gds-api',
    apiVersion: 'v1',
  }));
};

export default apiV1Routes;
