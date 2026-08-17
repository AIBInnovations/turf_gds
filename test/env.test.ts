import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config/env.js';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DATABASE: 'turf_gds_test',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-api-key',
    CLOUDINARY_API_SECRET: 'test-api-secret',
    ADMIN_ACCESS_TOKEN_SECRET: 'test-admin-secret-with-at-least-32-chars',
    PARTNER_CREDENTIAL_MASTER_SECRET: 'test-partner-secret-with-at-least-32-chars',
    ...overrides,
  };
}

test('loadConfig rejects an admin secret that reuses the partner credential master secret', () => {
  const sharedSecret = 'shared-secret-value-with-at-least-32-characters';
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          ADMIN_ACCESS_TOKEN_SECRET: sharedSecret,
          PARTNER_CREDENTIAL_MASTER_SECRET: sharedSecret,
        }),
      ),
    /must not be equal/,
  );
});

test('loadConfig succeeds with distinct admin and partner secrets', () => {
  const config = loadConfig(baseEnv());
  assert.notEqual(
    config.auth.adminAccessTokenSecret,
    config.auth.partnerCredentialMasterSecret,
  );
});
