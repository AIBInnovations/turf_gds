import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { AppConfig } from '../config/env.js';
import {
  type DatabaseConnection,
  MongoDatabaseConnection,
} from '../shared/database/database-connection.js';

declare module 'fastify' {
  interface FastifyInstance {
    database: DatabaseConnection;
  }
}

export interface MongodbPluginOptions {
  config: AppConfig['mongodb'];
  connection?: DatabaseConnection;
}

const mongodbPlugin: FastifyPluginAsync<MongodbPluginOptions> = async (
  fastify,
  options,
) => {
  const database =
    options.connection ?? new MongoDatabaseConnection(options.config);

  await database.connect();
  fastify.decorate('database', database);

  fastify.addHook('onClose', async () => {
    await database.close();
  });
};

export default fp(mongodbPlugin, {
  name: 'mongodb',
  fastify: '5.x',
});
