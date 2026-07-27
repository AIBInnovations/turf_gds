import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  cloudinary: {
    cloudName: 'test-cloud',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    folder: 'turf-gds/test',
  },
};

test('GET /health reports service health', async () => {
  const app = await buildApp({ config: testConfig, logger: false });

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
