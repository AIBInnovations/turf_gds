import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import contractRoutes from '../src/modules/contracts/contract.routes.js';
import type {
  ContractService,
  ContractView,
} from '../src/modules/contracts/contract.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const adminId = '687f00000000000000000210';
const partnerId = '687f00000000000000000211';
const venueId = '687f00000000000000000212';
const contractId = '687f00000000000000000213';

function contractView(): ContractView {
  return {
    id: contractId,
    partnerId,
    venueId,
    status: 'ACTIVE',
    commissionRateBps: 1_000,
    taxRateBps: 180,
    settlementCycle: 'WEEKLY',
    settlementLagDays: 2,
    allowedBookingModes: 'BOTH',
    cancellationTerms: {
      cancellationAllowed: true,
      defaultRefundBps: 0,
      releaseInventory: false,
    },
    refundRules: [],
    resaleCutoffMinutes: 60,
    termsVersion: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveTo: null,
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
  };
}

function createFixture(role: 'ADMIN' | 'OPS' | 'SUPPORT' = 'ADMIN') {
  const calls: {
    save?: Parameters<ContractService['saveVersion']>[0];
    list?: Parameters<ContractService['list']>[0];
    get?: string;
  } = {};
  const adminAuthService: AdminAuthService = {
    async login() {
      throw new Error('not used');
    },
    async authenticate() {
      return { actorType: 'ADMIN', adminId, role };
    },
    async bootstrapAdmin() {
      throw new Error('not used');
    },
  };
  const service: ContractService = {
    async saveVersion(input) {
      calls.save = input;
      return contractView();
    },
    async list(input) {
      calls.list = input;
      return [contractView()];
    },
    async get(id) {
      calls.get = id;
      return contractView();
    },
    async getActiveContract() {
      return contractView();
    },
    async getCancellationTerms() {
      throw new Error('not used');
    },
    async isBookingModeAllowed() {
      return true;
    },
  };
  return { calls, adminAuthService, service };
}

async function buildTestApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(contractRoutes, {
    service: fixture.service,
    adminAuthService: fixture.adminAuthService,
  });
  return app;
}

function validPayload() {
  return {
    partnerId,
    venueId,
    commissionRateBps: 1_000,
    taxRateBps: 180,
    settlementCycle: 'WEEKLY',
    settlementLagDays: 2,
    allowedBookingModes: 'BOTH',
    cancellationTerms: {
      cancellationAllowed: true,
      defaultRefundBps: 0,
      releaseInventory: false,
    },
    refundRules: [],
    resaleCutoffMinutes: 60,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
  };
}

test('contract routes require Admin authentication', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject('/');

  assert.equal(response.statusCode, 401);
  await app.close();
});

test('ADMIN can create an effective contract version', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject({
    method: 'POST',
    url: '/',
    headers: { authorization: 'Bearer admin-token' },
    payload: validPayload(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(fixture.calls.save?.adminId, adminId);
  assert.equal(fixture.calls.save?.partnerId, partnerId);
  await app.close();
});

test('non-ADMIN staff cannot mutate contracts but can read them', async () => {
  const fixture = createFixture('OPS');
  const app = await buildTestApp(fixture);

  const create = await app.inject({
    method: 'POST',
    url: '/',
    headers: { authorization: 'Bearer ops-token' },
    payload: validPayload(),
  });
  const list = await app.inject({
    method: 'GET',
    url: `/?partnerId=${partnerId}&venueId=${venueId}`,
    headers: { authorization: 'Bearer ops-token' },
  });

  assert.equal(create.statusCode, 403);
  assert.equal(create.json().error.code, 'ADMIN_ROLE_REQUIRED');
  assert.equal(list.statusCode, 200);
  assert.equal(fixture.calls.list?.partnerId, partnerId);
  assert.equal(fixture.calls.list?.venueId, venueId);
  await app.close();
});

test('contract detail is authenticated and identifier-scoped', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject({
    method: 'GET',
    url: `/${contractId}`,
    headers: { authorization: 'Bearer admin-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.get, contractId);
  await app.close();
});

test('contract route validation rejects out-of-range refund percentages', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);
  const payload = validPayload();
  payload.cancellationTerms.defaultRefundBps = 10_001;

  const response = await app.inject({
    method: 'POST',
    url: '/',
    headers: { authorization: 'Bearer admin-token' },
    payload,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  assert.equal(fixture.calls.save, undefined);
  await app.close();
});

test('Contracts exposes no Venue Owner mutation route', async () => {
  const fixture = createFixture();
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(contractRoutes, {
    prefix: '/api/v1/admin/contracts',
    service: fixture.service,
    adminAuthService: fixture.adminAuthService,
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/owner/venues/${venueId}/contracts`,
    headers: { authorization: 'Bearer owner-token' },
    payload: validPayload(),
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'ROUTE_NOT_FOUND');
  assert.equal(fixture.calls.save, undefined);
  await app.close();
});
