import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';
import type {
  DatabaseConnection,
  TransactionContext,
} from '../src/shared/database/database-connection.js';
import type {
  MediaMetadata,
  MediaStorage,
  UploadMediaOptions,
} from '../src/shared/media/cloudinary-media-storage.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  readinessCacheTtlMs: 0,
  mongodb: {
    uri: 'mongodb://127.0.0.1:27017',
    database: 'turf_gds_test',
    serverSelectionTimeoutMs: 100,
    maxPoolSize: 1,
  },
  auth: {
    sessionTtlHours: 168,
    maxSessions: 5,
    maxLoginAttempts: 5,
    lockMinutes: 15,
    adminAccessTokenSecret: 'test-admin-secret-with-at-least-32-chars',
    adminAccessTokenTtlMinutes: 60,
    partnerCredentialMasterSecret:
      'test-partner-secret-with-at-least-32-chars',
    partnerHmacMaxSkewSeconds: 300,
  },
  kyc: {
    maxFileBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  },
  cloudinary: {
    cloudName: 'test-cloud',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    folder: 'turf-gds/test',
  },
  communications: {
    pollIntervalMs: 1_000,
    batchSize: 20,
    leaseSeconds: 60,
    requestTimeoutMs: 10_000,
    maxWebhookAttempts: 8,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
  },
  fcm: { enabled: false },
};

class FakeDatabase implements DatabaseConnection {
  public readonly db = undefined as never;
  public available = true;

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}

  public async ping(): Promise<void> {
    if (!this.available) {
      throw new Error('MongoDB unavailable');
    }
  }

  public async withTransaction<T>(
    _operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T> {
    throw new Error('Not implemented by readiness test fake');
  }
}

class FakeMediaStorage implements MediaStorage {
  public available = true;

  public async ping(): Promise<void> {
    if (!this.available) {
      throw new Error('Cloudinary unavailable');
    }
  }

  public async uploadBuffer(
    _buffer: Buffer,
    _options?: UploadMediaOptions,
  ): Promise<MediaMetadata> {
    throw new Error('Not implemented by readiness test fake');
  }

  public async delete(): Promise<void> {
    throw new Error('Not implemented by readiness test fake');
  }
}

function createAppDependencies(): {
  database: FakeDatabase;
  mediaStorage: FakeMediaStorage;
} {
  return {
    database: new FakeDatabase(),
    mediaStorage: new FakeMediaStorage(),
  };
}

test('GET /health reports service health', async () => {
  const dependencies = createAppDependencies();
  const app = await buildApp({
    config: testConfig,
    logger: false,
    ...dependencies,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/health',
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    status: string;
    service: string;
    timestamp: string;
  }>();

  assert.deepEqual(
    { ...body, timestamp: '<dynamic>' },
    {
      status: 'ok',
      service: 'turf-gds-api',
      timestamp: '<dynamic>',
    },
  );

  await app.close();
});

test('GET /ready reports ready dependencies', async () => {
  const dependencies = createAppDependencies();
  const app = await buildApp({
    config: testConfig,
    logger: false,
    ...dependencies,
  });

  const response = await app.inject('/ready');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().dependencies, {
    mongodb: 'up',
    cloudinary: 'up',
  });

  await app.close();
});

test('GET /ready returns 503 when a dependency is unavailable', async () => {
  const dependencies = createAppDependencies();
  dependencies.database.available = false;
  const app = await buildApp({
    config: testConfig,
    logger: false,
    ...dependencies,
  });

  const response = await app.inject('/ready');

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'degraded');
  assert.deepEqual(response.json().dependencies, {
    mongodb: 'down',
    cloudinary: 'up',
  });

  await app.close();
});

test('unknown routes use the standard error envelope', async () => {
  const dependencies = createAppDependencies();
  const app = await buildApp({
    config: testConfig,
    logger: false,
    ...dependencies,
  });

  const response = await app.inject('/missing');

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'ROUTE_NOT_FOUND');
  assert.equal(typeof response.json().error.requestId, 'string');

  await app.close();
});

test('GET /api/v1 exposes the API version', async () => {
  const dependencies = createAppDependencies();
  const app = await buildApp({
    config: testConfig,
    logger: false,
    ...dependencies,
  });

  const response = await app.inject('/api/v1');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: 'turf-gds-api',
    apiVersion: 'v1',
  });

  await app.close();
});
