import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  createCanonicalRequest,
  createPartnerApiKey,
  deriveSigningSecret,
  extractKeyPrefix,
  hashCredential,
  verifyHmacSignature,
} from '../src/shared/auth/partner-signature.js';
import {
  createAdminJwt,
  verifyAdminJwt,
} from '../src/shared/auth/admin-jwt.js';

test('admin JWTs are standards-shaped and reject tampering or expiry', () => {
  const secret = 'test-admin-secret-with-at-least-32-characters';
  const token = createAdminJwt(
    {
      sub: '687f00000000000000000001',
      actor: 'ADMIN',
      role: 'ADMIN',
      iat: 1_000,
      exp: 2_000,
    },
    secret,
  );

  assert.equal(token.split('.').length, 3);
  assert.deepEqual(
    JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
    ),
    { alg: 'HS256', typ: 'JWT' },
  );
  assert.equal(verifyAdminJwt(token, secret, 1_500)?.role, 'ADMIN');
  assert.equal(verifyAdminJwt(`${token}x`, secret, 1_500), undefined);
  assert.equal(verifyAdminJwt(token, secret, 2_000), undefined);
});

test('partner credentials expose a prefix without storing raw secrets', () => {
  const generated = createPartnerApiKey('SANDBOX');

  assert.equal(extractKeyPrefix(generated.apiKey), generated.prefix);
  assert.notEqual(hashCredential(generated.apiKey), generated.apiKey);
  assert.equal(generated.apiKey.includes('gds_sbx_'), true);
});

test('partner HMAC signatures cover timestamp, method, path, and body', () => {
  const signingSecret = deriveSigningSecret(
    'test-partner-master-secret-with-at-least-32-chars',
    'partner-key:test',
  );
  const canonical = createCanonicalRequest({
    timestamp: '1785225600',
    method: 'POST',
    path: '/api/v1/bookings',
    body: Buffer.from('{"slotId":"123"}'),
  });
  const signature = createHmac('sha256', signingSecret)
    .update(canonical)
    .digest('hex');

  assert.equal(
    verifyHmacSignature(canonical, signingSecret, `sha256=${signature}`),
    true,
  );
  assert.equal(
    verifyHmacSignature(
      `${canonical}tampered`,
      signingSecret,
      signature,
    ),
    false,
  );
});
