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
    return { items: [], nextCursor: null };
  };
  const service = {
    searchAvailability: empty,
    listUsage: empty,
    listBookings: empty,
    listSettlements: empty,
    getSettlement: empty,
    listInvoices: empty,
    getInvoice: empty,
  } as unknown as PartnerPortalService;
  return { calls, service, partnerAccessService };
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
  const deniedApp = Fastify({ logger: false });
  await deniedApp.register(errorHandlerPlugin);
  await deniedApp.register(partnerPortalRoutes, deniedValue);
  const denied = await deniedApp.inject({
    method: 'GET',
    url: '/partners/me/invoices',
    headers,
  });
  assert.equal(denied.statusCode, 403);
});
