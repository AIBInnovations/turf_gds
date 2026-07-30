import { createHash } from 'node:crypto';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { initializeIdentityPersistence } from '../../src/modules/identity/persistence.js';
import { createAdminAuthRepository } from '../../src/modules/identity/platform/auth.repository.js';
import { createAdminAuthService } from '../../src/modules/identity/platform/auth.service.js';
import { initializeVenuePersistence } from '../../src/modules/venue/profile/venue.persistence.js';
import { initializeContractPersistence } from '../../src/modules/contracts/contract.persistence.js';
import { initializeBookingPersistence } from '../../src/modules/booking/booking.persistence.js';
import { initializeLedgerPersistence } from '../../src/modules/ledger/ledger.persistence.js';
import { initializeFinancialClosePersistence } from '../../src/modules/financial-close/financial-close.persistence.js';
import { initializeOutboxPersistence } from '../../src/shared/communications/outbox.persistence.js';
import { createCommunicationsRepository } from '../../src/shared/communications/communications.repository.js';
import { createCommunicationsService } from '../../src/shared/communications/communications.service.js';
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
await initializeContractPersistence(database.db);
await initializeBookingPersistence(database.db);
await initializeLedgerPersistence(database.db);
await initializeFinancialClosePersistence(database.db);
await initializeOutboxPersistence(database.db);
const adminAuthService = createAdminAuthService({
  repository: createAdminAuthRepository(database),
  authConfig: config.auth,
});
await adminAuthService.bootstrapAdmin({
  email: 'curl-admin@example.com',
  password: 'CurlAdminPassword123!',
  displayName: 'Curl Test Admin',
  role: 'ADMIN',
});
await adminAuthService.bootstrapAdmin({
  email: 'curl-ops@example.com',
  password: 'CurlOpsPassword123!',
  displayName: 'Curl Test Operations',
  role: 'OPS',
});
await adminAuthService.bootstrapAdmin({
  email: 'curl-support@example.com',
  password: 'CurlSupportPassword123!',
  displayName: 'Curl Test Support',
  role: 'SUPPORT',
});
const deliveredWebhooks: Array<Record<string, unknown>> = [];
const communicationsService = createCommunicationsService({
  repository: createCommunicationsRepository(database),
  webhookTransport: {
    async deliver(input) {
      deliveredWebhooks.push({
        eventId: input.eventId,
        eventType: input.eventType,
        body: JSON.parse(input.body) as Record<string, unknown>,
      });
      return {
        delivered: true,
        retryable: false,
        attempt: {
          attempted_at: input.now,
          request_payload: input.body,
          redacted_headers: {
            'x-turf-signature': '[REDACTED]',
          },
          response_code: 204,
          response_payload: '',
          error: null,
          completed_at: input.now,
        },
      };
    },
  },
  pushDelivery: {
    async send() {
      return { invalidTokens: [] };
    },
  },
  authConfig: config.auth,
  config: config.communications,
});

const app = await buildApp({
  config,
  database,
  mediaStorage,
  logger: true,
  communicationsService,
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
app.post('/__curl-test/communications/drain', async () => ({
  processed: await communicationsService.drain('curl-test-worker', 100),
}));
app.get('/__curl-test/communications/webhooks', async () => ({
  items: deliveredWebhooks,
}));

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
