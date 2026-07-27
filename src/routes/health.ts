import type { FastifyPluginAsync } from 'fastify';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'turf-gds-api',
    timestamp: new Date().toISOString(),
  }));
};

export default healthRoutes;
