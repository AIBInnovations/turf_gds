import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import adminEpic08Routes from '../src/modules/admin/epic08/admin-epic08.routes.js';
import type { AdminEpic08Service } from '../src/modules/admin/epic08/admin-epic08.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const venueId = '68b000000000000000000011';
const ownerId = '68b000000000000000000012';

test('Epic 08 permits staff reads but reserves mutations and exports for ADMIN', async () => {
  let creates = 0;
  const service = {
    venues: {
      async listVenues() { return { items: [], page: 1, limit: 20, total: 0 }; },
      async createVenue() { creates += 1; return { venueId }; },
    },
    async bookingReport() { return { items: [], totals: {}, page: 1, limit: 20, total: 0 }; },
    async exportReport() { return 'id\r\n'; },
  } as unknown as AdminEpic08Service;
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(adminEpic08Routes, {
    prefix: '/api/v1/admin',
    service,
    adminAuthService: auth(),
  });
  const range = 'environment=PRODUCTION&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z';
  const supportRead = await app.inject({
    method: 'GET', url: `/api/v1/admin/reports/bookings?${range}`,
    headers: { authorization: 'Bearer support' },
  });
  assert.equal(supportRead.statusCode, 200);
  const supportExport = await app.inject({
    method: 'GET', url: `/api/v1/admin/reports/bookings/export?${range}`,
    headers: { authorization: 'Bearer support' },
  });
  assert.equal(supportExport.statusCode, 403);
  const supportCreate = await app.inject({
    method: 'POST', url: '/api/v1/admin/venues',
    headers: { authorization: 'Bearer support' },
    payload: venuePayload(),
  });
  assert.equal(supportCreate.statusCode, 403);
  const adminCreate = await app.inject({
    method: 'POST', url: '/api/v1/admin/venues',
    headers: { authorization: 'Bearer admin' },
    payload: venuePayload(),
  });
  assert.equal(adminCreate.statusCode, 201);
  assert.equal(creates, 1);
  await app.close();
});

test('Epic 08 validates report windows and identifiers at the route boundary', async () => {
  const service = {
    venues: { async listVenues() { return { items: [], page: 1, limit: 20, total: 0 }; } },
    async bookingReport() { return {}; },
  } as unknown as AdminEpic08Service;
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(adminEpic08Routes, {
    prefix: '/api/v1/admin', service, adminAuthService: auth(),
  });
  const missingDates = await app.inject({
    method: 'GET', url: '/api/v1/admin/reports/bookings?environment=PRODUCTION',
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(missingDates.statusCode, 400);
  const invalidId = await app.inject({
    method: 'GET', url: '/api/v1/admin/venues/not-an-id',
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(invalidId.statusCode, 400);
  await app.close();
});

function auth(): AdminAuthService {
  return {
    async authenticate(token: string) {
      return {
        actorType: 'ADMIN',
        adminId: '68b000000000000000000013',
        role: token === 'support' ? 'SUPPORT' : token === 'ops' ? 'OPS' : 'ADMIN',
      };
    },
  } as AdminAuthService;
}

function venuePayload() {
  return {
    ownerId, environment: 'PRODUCTION', legalName: 'Admin Venue Pvt Ltd',
    displayName: 'Admin Venue', timezone: 'Asia/Kolkata',
    address: { line1: '1 Main Road', city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
    latitude: 18.52, longitude: 73.85,
  };
}
