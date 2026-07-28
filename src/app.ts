import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config/env.js';
import cloudinaryPlugin from './plugins/cloudinary.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import mongodbPlugin from './plugins/mongodb.js';
import apiV1Routes from './routes/api-v1.js';
import healthRoutes from './routes/health.js';
import type { DatabaseConnection } from './shared/database/database-connection.js';
import type { MediaStorage } from './shared/media/cloudinary-media-storage.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  database?: DatabaseConnection;
  mediaStorage?: MediaStorage;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
          },
  });

  await app.register(errorHandlerPlugin);
  await app.register(cloudinaryPlugin, {
    config: config.cloudinary,
    ...(options.mediaStorage
      ? { storage: options.mediaStorage }
      : {}),
  });
  await app.register(mongodbPlugin, {
    config: config.mongodb,
    ...(options.database ? { connection: options.database } : {}),
  });
  await app.register(healthRoutes, {
    cacheTtlMs: config.readinessCacheTtlMs,
  });
  await app.register(apiV1Routes, { prefix: '/api/v1' });

  return app;
}
