import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import ownerFinanceRoutes from '../src/modules/financial-close/owner-finance.routes.js';
import type { FinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000b01';
const venueId = '687f00000000000000000b02';
const payoutId = '687f00000000000000000b03';

async function appFor() {
  const calls: Record<string, unknown> = {};
  const service = {
    async listOwnerSettlements(input: unknown) {
      calls.listOwnerSettlements = input;
      return {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    },
    async getOwnerSettlement(input: unknown) {
      calls.getOwnerSettlement = input;
      return { settlementId: payoutId };
    },
    async listOwnerPayouts(input: unknown) {
      calls.listOwnerPayouts = input;
      return {
        items: [],
        pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
      };
    },
    async getOwnerPayout(input: unknown) {
      calls.getOwnerPayout = input;
      return { payoutId };
    },
  } as unknown as FinancialCloseService;
  const ownerAccessService = {
    async authenticateOwner() {
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
  } as unknown as OwnerAccessService;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ownerFinanceRoutes, { service, ownerAccessService });
  return { app, calls };
}

test('owner finance routes authenticate and derive venue scope', async () => {
  const { app, calls } = await appFor();
  const unauthorized = await app.inject({
    method: 'GET',
    url: `/${venueId}/finance/payouts`,
  });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({
    method: 'GET',
    url: `/${venueId}/finance/payouts?status=PAID&page=2&limit=10`,
    headers: { authorization: 'Bearer owner-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.listOwnerPayouts, {
    actorOwnerId: ownerId,
    venueId,
    status: 'PAID',
    page: 2,
    limit: 10,
  });
  await app.close();
});

test('owner finance detail routes forward both venue and resource identifiers', async () => {
  const { app, calls } = await appFor();
  const response = await app.inject({
    method: 'GET',
    url: `/${venueId}/finance/payouts/${payoutId}`,
    headers: { authorization: 'Bearer owner-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.getOwnerPayout, {
    actorOwnerId: ownerId,
    venueId,
    payoutId,
  });
  await app.close();
});

test('owner finance routes validate filters and bounded pagination', async () => {
  const { app, calls } = await appFor();
  for (const query of [
    'status=COMPLETED',
    'page=0',
    'limit=101',
    'from=not-a-date',
  ]) {
    const response = await app.inject({
      method: 'GET',
      url: `/${venueId}/finance/payouts?${query}`,
      headers: { authorization: 'Bearer owner-token' },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.listOwnerPayouts, undefined);
  await app.close();
});
