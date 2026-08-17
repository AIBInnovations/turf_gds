import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import partnerPortalRoutes from '../src/modules/identity/partner/partner-portal.routes.js';
import type { PartnerAccessService } from '../src/modules/identity/partner/partner-access.service.js';
import type { PartnerPortalService } from '../src/modules/identity/partner/partner-portal.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const partnerId = '687f00000000000000000901';
const headers = {
  'x-api-key': 'key',
  'x-signature': 'signature',
  'x-timestamp': '1770000000',
};

function fixture(scopes: string[]) {
  const calls: Record<string, unknown> = {};
  const partnerAccessService = {
    async authenticateRequest() {
      return {
        actorType: 'PARTNER',
        partnerId,
        keyId: '687f00000000000000000902',
        environment: 'SANDBOX',
        scopes,
      };
    },
    async consumeRateLimit() {
      return {
        allowed: true,
        limit: 100,
        remaining: 99,
        resetAt: new Date('2026-08-01T12:35:00.000Z'),
        source: 'MONGODB',
      };
    },
    async recordApiUsage(input: unknown) {
      calls.usage = input;
    },
  } as unknown as PartnerAccessService;
  const empty = async (input: unknown) => {
    calls.last = input;
    return { items: [], nextCursor: null, truncated: false };
  };
  const truncatedPage = async (input: unknown) => {
    calls.last = input;
    return { items: [], nextCursor: 'next', truncated: true };
  };
  const service = {
    searchAvailability: empty,
    listUsage: empty,
    listBookings: empty,
    listSettlements: empty,
    getSettlement: empty,
    listInvoices: empty,
    getInvoice: empty,
    getBooking: empty,
    searchVenues: empty,
    getVenueAvailability: truncatedPage,
    listSettlementAllocations: empty,
  } as unknown as PartnerPortalService;
  return { calls, service, partnerAccessService };
}

async function appFor(value: ReturnType<typeof fixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(partnerPortalRoutes, value);
  return app;
}

test('Partner portal enforces scopes, environment context, and rate headers', async () => {
  const value = fixture(['availability:read', 'reports:read', 'finance:read']);
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(partnerPortalRoutes, value);
  const response = await app.inject({
    method: 'GET',
    url:
      '/availability?latitude=12.97&longitude=77.59&radiusMeters=5000' +
      '&sportType=FOOTBALL&startsAt=2026-08-03T04:30:00.000Z' +
      '&endsAt=2026-08-03T05:30:00.000Z',
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-ratelimit-limit'], '100');
  assert.equal(
    (value.calls.last as { partnerId: string }).partnerId,
    partnerId,
  );
  assert.equal(
    (value.calls.last as { environment: string }).environment,
    'SANDBOX',
  );

  const deniedValue = fixture([]);
  const deniedApp = await appFor(deniedValue);
  const denied = await deniedApp.inject({
    method: 'GET',
    url: '/partners/me/invoices',
    headers,
  });
  assert.equal(denied.statusCode, 403);

  await app.close();
  await deniedApp.close();
});

test('availability responses surface scan truncation to the caller', async () => {
  const value = fixture(['availability:read']);
  const app = await appFor(value);

  const response = await app.inject({
    method: 'GET',
    url:
      '/venues/687f00000000000000000801/availability' +
      '?startsAt=2026-08-03T04:30:00.000Z&endsAt=2026-08-03T05:30:00.000Z',
    headers,
  });

  assert.equal(response.statusCode, 200);
  // No response schema is attached to these routes, so the additive field has
  // to survive serialization untouched.
  const body = response.json<{ truncated: boolean; nextCursor: string | null }>();
  assert.equal(body.truncated, true);
  assert.equal(body.nextCursor, 'next');

  await app.close();
});

test('settlement allocations are paginated and scope-guarded', async () => {
  const value = fixture(['finance:read']);
  const app = await appFor(value);

  const response = await app.inject({
    method: 'GET',
    url:
      '/partners/me/settlements/687f00000000000000000701/allocations' +
      '?limit=10',
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(
    (value.calls.last as { settlementId: string }).settlementId,
    '687f00000000000000000701',
  );
  assert.equal((value.calls.last as { limit: number }).limit, 10);

  const denied = await appFor(fixture([]));
  const forbidden = await denied.inject({
    method: 'GET',
    url: '/partners/me/settlements/687f00000000000000000701/allocations',
    headers,
  });
  assert.equal(forbidden.statusCode, 403);

  await app.close();
  await denied.close();
});

test('settlement detail forwards allocation paging to the service', async () => {
  const value = fixture(['finance:read']);
  const app = await appFor(value);

  const response = await app.inject({
    method: 'GET',
    url:
      '/partners/me/settlements/687f00000000000000000701' +
      '?allocationCursor=abc&allocationLimit=10',
    headers,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    (value.calls.last as { allocationCursor: string }).allocationCursor,
    'abc',
  );
  assert.equal(
    (value.calls.last as { allocationLimit: number }).allocationLimit,
    10,
  );

  await app.close();
});

test('pagination bounds are rejected at the route schema', async () => {
  const value = fixture(['availability:read']);
  const app = await appFor(value);
  const base =
    '/availability?latitude=12.97&longitude=77.59&radiusMeters=5000' +
    '&sportType=FOOTBALL&startsAt=2026-08-03T04:30:00.000Z' +
    '&endsAt=2026-08-03T05:30:00.000Z';

  for (const limit of ['0', '101']) {
    const response = await app.inject({
      method: 'GET',
      url: `${base}&limit=${limit}`,
      headers,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }

  await app.close();
});
