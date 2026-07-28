import type { FastifyPluginAsync } from 'fastify';

export interface HealthRoutesOptions {
  cacheTtlMs: number;
}

type DependencyStatus = 'up' | 'down';

interface ReadinessResult {
  status: 'ready' | 'degraded';
  service: 'turf-gds-api';
  dependencies: {
    mongodb: DependencyStatus;
    cloudinary: DependencyStatus;
  };
  timestamp: string;
}

const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  fastify,
  options,
) => {
  let cached:
    | {
        expiresAt: number;
        result: ReadinessResult;
      }
    | undefined;

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'turf-gds-api',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/ready', async (_request, reply) => {
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return reply
        .status(cached.result.status === 'ready' ? 200 : 503)
        .send(cached.result);
    }

    const [mongodb, cloudinary] = await Promise.allSettled([
      fastify.database.ping(),
      fastify.mediaStorage.ping(),
    ]);

    const result: ReadinessResult = {
      status:
        mongodb.status === 'fulfilled' &&
        cloudinary.status === 'fulfilled'
          ? 'ready'
          : 'degraded',
      service: 'turf-gds-api',
      dependencies: {
        mongodb: mongodb.status === 'fulfilled' ? 'up' : 'down',
        cloudinary: cloudinary.status === 'fulfilled' ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    };

    cached = {
      expiresAt: now + options.cacheTtlMs,
      result,
    };

    return reply
      .status(result.status === 'ready' ? 200 : 503)
      .send(result);
  });
};

export default healthRoutes;
