import type { FastifyPluginAsync } from 'fastify';

import { BACKGROUND_JOB_EXPECTATIONS } from '../shared/scheduler/job-names.js';
import {
  readJobHealth,
  type JobHealth,
} from '../shared/scheduler/scheduler.persistence.js';

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
    backgroundJobs: JobHealth;
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

    const [mongodb, cloudinary, jobs] = await Promise.allSettled([
      fastify.database.ping(),
      fastify.mediaStorage.ping(),
      // The worker runs the recurring jobs now, so a dead worker would
      // otherwise be silent: holds stop expiring and inventory leaks while
      // /ready stays green.
      readJobHealth(
        fastify.database.db,
        BACKGROUND_JOB_EXPECTATIONS,
        new Date(),
      ),
    ]);

    const backgroundJobs: JobHealth =
      jobs.status === 'fulfilled' ? jobs.value : 'down';
    // Reported but deliberately not part of `status`. A dead worker is a real
    // incident, but failing readiness would pull the API out of the load
    // balancer too — the API itself is serving fine. Alert on this field.
    const result: ReadinessResult = {
      status:
        mongodb.status === 'fulfilled' && cloudinary.status === 'fulfilled'
          ? 'ready'
          : 'degraded',
      service: 'turf-gds-api',
      dependencies: {
        mongodb: mongodb.status === 'fulfilled' ? 'up' : 'down',
        cloudinary: cloudinary.status === 'fulfilled' ? 'up' : 'down',
        backgroundJobs,
      },
      timestamp: new Date().toISOString(),
    };

    cached = {
      expiresAt: now + options.cacheTtlMs,
      result,
    };

    return reply.status(result.status === 'ready' ? 200 : 503).send(result);
  });
};

export default healthRoutes;
