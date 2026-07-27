import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config/env.js';
import cloudinaryPlugin from './plugins/cloudinary.js';
import healthRoutes from './routes/health.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
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

  await app.register(cloudinaryPlugin, { config: config.cloudinary });
  await app.register(healthRoutes);

  return app;
}
