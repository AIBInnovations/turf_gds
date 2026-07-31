import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createClient, type RedisClientType } from 'redis';

import type { AppConfig } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType | null;
  }
}

export interface RedisPluginOptions {
  config: NonNullable<AppConfig['redis']>;
  client?: RedisClientType | null;
}

const redisPlugin: FastifyPluginAsync<RedisPluginOptions> = async (
  fastify,
  options,
) => {
  const client = options.client ??
    (options.config.url
      ? createClient({
          url: options.config.url,
          socket: { connectTimeout: options.config.connectTimeoutMs },
        })
      : null);

  if (client && !client.isOpen) {
    client.on('error', (error) => {
      fastify.log.warn({ err: error }, 'Redis rate-limit client unavailable');
    });
    try {
      await client.connect();
    } catch (error) {
      fastify.log.warn(
        { err: error },
        'Redis unavailable; Partner limits will use MongoDB',
      );
    }
  }

  fastify.decorate('redis', client);
  fastify.addHook('onClose', async () => {
    if (client?.isOpen) await client.quit();
  });
};

export default fp(redisPlugin, {
  name: 'redis',
  fastify: '5.x',
});
