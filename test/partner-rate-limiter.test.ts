import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPartnerRateLimiter } from '../src/shared/rate-limit/partner-rate-limiter.js';

test('Partner limiter uses the atomic Mongo fallback and enforces tier quota', async () => {
  let count = 0;
  const limiter = createPartnerRateLimiter({
    redis: null,
    keyPrefix: 'test',
    limits: { STARTER: 2, STANDARD: 3, ENTERPRISE: 4 },
    fallback: {
      async consumeRateLimitWindow() {
        count += 1;
        return { count };
      },
    },
  });
  const input = {
    partnerId: '687f00000000000000000901',
    environment: 'PRODUCTION' as const,
    tier: 'STARTER' as const,
    now: new Date('2026-08-01T12:34:05.000Z'),
  };
  const first = await limiter.consume(input);
  const second = await limiter.consume(input);
  const third = await limiter.consume(input);
  assert.equal(first.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.source, 'MONGODB');
  assert.equal(third.resetAt.toISOString(), '2026-08-01T12:35:00.000Z');
});
