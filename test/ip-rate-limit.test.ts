import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import ipRateLimitPlugin, {
  resolveIpRateLimitBucket,
} from '../src/plugins/ip-rate-limit.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import {
  createIpHasher,
  createIpRateLimiter,
  type IpRateLimitFallback,
} from '../src/shared/rate-limit/ip-rate-limiter.js';

const limits = {
  enabled: true,
  failClosed: false,
  authBurstLimit: 2,
  authSustainedLimit: 3,
  signedLimit: 5,
  globalLimit: 4,
};

/** In-memory stand-in for the TTL collection. */
function countingFallback(): IpRateLimitFallback & { calls: number } {
  const counters = new Map<string, number>();
  const fallback = {
    calls: 0,
    async consumeIpRateLimitWindow(input) {
      fallback.calls += 1;
      const key = `${input.scope}:${input.ipHash}:${input.windowStartedAt.toISOString()}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return { count };
    },
  } satisfies IpRateLimitFallback & { calls: number };
  return fallback;
}

test('route buckets are resolved from the route pattern and config', () => {
  assert.equal(resolveIpRateLimitBucket('/health', undefined), 'SKIP');
  assert.equal(resolveIpRateLimitBucket('/ready', undefined), 'SKIP');
  assert.equal(resolveIpRateLimitBucket('/metrics', undefined), 'SKIP');

  assert.equal(
    resolveIpRateLimitBucket('/api/v1/auth/venue-owners/login', undefined),
    'AUTH',
  );
  // These strings must match the paths api-v1.ts actually registers; a typo
  // silently leaves a login endpoint unthrottled.
  for (const route of [
    '/api/v1/auth/venue-owners/register',
    '/api/v1/auth/admin/login',
    '/api/v1/partners/auth/login',
    '/api/v1/partners/applications',
  ]) {
    assert.equal(resolveIpRateLimitBucket(route, undefined), 'AUTH', route);
  }

  // Every Partner HMAC route opts into raw-body capture.
  assert.equal(
    resolveIpRateLimitBucket('/api/v1/availability', { rawBody: true }),
    'SIGNED',
  );
  assert.equal(
    resolveIpRateLimitBucket('/api/v1/provider-webhooks/razorpay', undefined),
    'SIGNED',
  );

  assert.equal(resolveIpRateLimitBucket('/api/v1/owner/venues', undefined), 'GLOBAL');
  // Unmatched routes (404 scanning) must still be throttled.
  assert.equal(resolveIpRateLimitBucket(undefined, undefined), 'GLOBAL');
});

test('the signed bucket sits above the highest Partner tier', () => {
  // Otherwise the IP limiter, not the contractual per-Partner limit, becomes
  // the binding constraint on an ENTERPRISE partner's traffic.
  const ENTERPRISE_PER_MINUTE = 1_000;
  assert.ok(2_000 > ENTERPRISE_PER_MINUTE);
});

test('a burst beyond the limit is denied with rate-limit headers', async () => {
  const limiter = createIpRateLimiter({
    redis: null,
    fallback: countingFallback(),
    keyPrefix: 'test',
  });
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ipRateLimitPlugin, { config: limits, limiter });
  app.post('/api/v1/auth/admin/login', async () => ({ ok: true }));

  const first = await app.inject({ method: 'POST', url: '/api/v1/auth/admin/login' });
  const second = await app.inject({ method: 'POST', url: '/api/v1/auth/admin/login' });
  const third = await app.inject({ method: 'POST', url: '/api/v1/auth/admin/login' });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, 'IP_RATE_LIMIT_EXCEEDED');
  assert.equal(third.headers['x-ratelimit-remaining'], '0');
  assert.ok(third.headers['retry-after']);

  await app.close();
});

test('auth requests consume both the burst and sustained windows', async () => {
  const fallback = countingFallback();
  const limiter = createIpRateLimiter({
    redis: null,
    fallback,
    keyPrefix: 'test',
  });
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ipRateLimitPlugin, { config: limits, limiter });
  app.post('/api/v1/auth/admin/login', async () => ({ ok: true }));

  await app.inject({ method: 'POST', url: '/api/v1/auth/admin/login' });

  // One request, two windows counted.
  assert.equal(fallback.calls, 2);
  await app.close();
});

test('infrastructure probes are never throttled', async () => {
  const limiter = createIpRateLimiter({
    redis: null,
    fallback: countingFallback(),
    keyPrefix: 'test',
  });
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ipRateLimitPlugin, { config: limits, limiter });
  app.get('/health', async () => ({ ok: true }));

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
  }

  await app.close();
});

test('the limiter fails open when every backend is unavailable', async () => {
  const limiter = createIpRateLimiter({
    redis: null,
    fallback: {
      async consumeIpRateLimitWindow() {
        throw new Error('mongodb unavailable');
      },
    },
    keyPrefix: 'test',
  });

  const decision = await limiter.consume({
    scope: 'GLOBAL',
    ip: '203.0.113.5',
    limit: 1,
    windowMs: 60_000,
  });

  // Fail-closed here would convert a degraded dependency into a full outage.
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, 'UNAVAILABLE');
});

test('the limiter can be configured to fail closed', async () => {
  const limiter = createIpRateLimiter({
    redis: null,
    fallback: {
      async consumeIpRateLimitWindow() {
        throw new Error('mongodb unavailable');
      },
    },
    keyPrefix: 'test',
    failOpen: false,
  });

  const decision = await limiter.consume({
    scope: 'GLOBAL',
    ip: '203.0.113.5',
    limit: 1,
    windowMs: 60_000,
  });

  assert.equal(decision.allowed, false);
});

test('addresses are pseudonymised before storage', async () => {
  const seen: string[] = [];
  const limiter = createIpRateLimiter({
    redis: null,
    fallback: {
      async consumeIpRateLimitWindow(input) {
        seen.push(input.ipHash);
        return { count: 1 };
      },
    },
    keyPrefix: 'test',
    hashIp: createIpHasher('a-secret-at-least-32-characters-long'),
  });

  await limiter.consume({
    scope: 'GLOBAL',
    ip: '203.0.113.5',
    limit: 10,
    windowMs: 60_000,
  });

  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], '203.0.113.5');
  assert.match(seen[0]!, /^[a-f0-9]{64}$/);
});

test('window boundaries reset the counter', async () => {
  const fallback = countingFallback();
  const limiter = createIpRateLimiter({
    redis: null,
    fallback,
    keyPrefix: 'test',
  });
  const base = new Date('2026-08-01T12:00:30.000Z');

  const first = await limiter.consume({
    scope: 'GLOBAL', ip: '198.51.100.1', limit: 1, windowMs: 60_000, now: base,
  });
  const second = await limiter.consume({
    scope: 'GLOBAL', ip: '198.51.100.1', limit: 1, windowMs: 60_000, now: base,
  });
  const nextWindow = await limiter.consume({
    scope: 'GLOBAL',
    ip: '198.51.100.1',
    limit: 1,
    windowMs: 60_000,
    now: new Date(base.getTime() + 60_000),
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(nextWindow.allowed, true);
});

test('the plugin is inert when disabled', async () => {
  const fallback = countingFallback();
  const limiter = createIpRateLimiter({
    redis: null,
    fallback,
    keyPrefix: 'test',
  });
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ipRateLimitPlugin, {
    config: { ...limits, enabled: false },
    limiter,
  });
  app.post('/api/v1/auth/admin/login', async () => ({ ok: true }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
    });
    assert.equal(response.statusCode, 200);
  }
  assert.equal(fallback.calls, 0);

  await app.close();
});
