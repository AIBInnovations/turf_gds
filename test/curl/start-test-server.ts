import { createHash } from 'node:crypto';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { initializeIdentityPersistence } from '../../src/modules/identity/persistence.js';
import { createAdminAuthRepository } from '../../src/modules/identity/platform/auth.repository.js';
import { createAdminAuthService } from '../../src/modules/identity/platform/auth.service.js';
import { initializeVenuePersistence } from '../../src/modules/venue/venue.persistence.js';
import { MongoDatabaseConnection } from '../../src/shared/database/database-connection.js';
import type { MediaStorage } from '../../src/shared/media/cloudinary-media-storage.js';

const baseConfig = loadConfig();
const port = Number(process.env.CURL_TEST_PORT ?? '3317');
const databaseName =
  process.env.CURL_TEST_DATABASE ??
  `turf_gds_curl_${process.pid}_${Date.now()}`;
const config = {
  ...baseConfig,
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port,
  logLevel: 'error' as const,
  readinessCacheTtlMs: 0,
  mongodb: {
    ...baseConfig.mongodb,
    database: databaseName,
    maxPoolSize: 4,
  },
};
const database = new MongoDatabaseConnection(config.mongodb);
let uploadSequence = 0;
const mediaStorage: MediaStorage = {
  async ping() {},
  async uploadBuffer(buffer, options = {}) {
    const checksum = createHash('sha256').update(buffer).digest('hex');
    uploadSequence += 1;
    const publicId =
      options.publicId ??
      `curl-test/${uploadSequence}-${checksum.slice(0, 16)}`;
    const resourceType =
      options.resourceType === 'auto' || !options.resourceType
        ? 'image'
        : options.resourceType;
    return {
      publicId,
      resourceType,
      deliveryType:
        options.access === 'authenticated' ? 'authenticated' : 'upload',
      format: resourceType === 'raw' ? 'pdf' : 'png',
      bytes: buffer.byteLength,
      width: resourceType === 'image' ? 640 : undefined,
      height: resourceType === 'image' ? 480 : undefined,
      url: `http://media.invalid/${publicId}`,
      secureUrl: `https://media.invalid/${publicId}`,
      version: 1,
      checksum,
    };
  },
  async delete() {},
};

await database.connect();
await initializeIdentityPersistence(database.db);
await initializeVenuePersistence(database.db);
await createAdminAuthService({
  repository: createAdminAuthRepository(database),
  authConfig: config.auth,
}).bootstrapAdmin({
  email: 'curl-admin@example.com',
  password: 'CurlAdminPassword123!',
  displayName: 'Curl Test Admin',
  role: 'ADMIN',
});

const app = await buildApp({
  config,
  database,
  mediaStorage,
  logger: true,
});
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await database.db.dropDatabase().catch(() => undefined);
  await app.close().catch(() => undefined);
}

app.post('/__curl-test/shutdown', async (_request, reply) => {
  await reply.status(204).send();
  setTimeout(() => {
    void shutdown().finally(() => process.exit(0));
  }, 25);
});

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({ host: config.host, port: config.port });
process.stdout.write(
  `CURL_TEST_READY ${JSON.stringify({
    baseUrl: `http://${config.host}:${config.port}`,
    database: databaseName,
    adminEmail: 'curl-admin@example.com',
  })}\n`,
);
