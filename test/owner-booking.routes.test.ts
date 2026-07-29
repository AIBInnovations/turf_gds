import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import ownerBookingRoutes from '../src/modules/booking/owner-booking.routes.js';
import type { OwnerBookingService } from '../src/modules/booking/owner-booking.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000110';
const venueId = '687f00000000000000000111';
const courtId = '687f00000000000000000112';
const bookingId = '687f00000000000000000113';

function createFixture() {
  const calls: {
    list?: Parameters<OwnerBookingService['list']>[0];
    detail?: Parameters<OwnerBookingService['getDetail']>[0];
  } = {};
  const ownerAccessService: OwnerAccessService = {
    async authenticateOwner() {
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
    async logout() {},
    async getProfile() {
      throw new Error('not used');
    },
    async requirePermission() {},
    async requireVenueMembership() {
      throw new Error('not used');
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };
  const item = {
    id: bookingId,
    partnerId: '687f00000000000000000114',
    venueId,
    courtId,
    slotId: '687f00000000000000000115',
    contractId: '687f00000000000000000116',
    environment: 'PRODUCTION' as const,
    externalBookingReference: 'PARTNER-42',
    bookingType: 'FIXED_SLOT' as const,
    startsAt: '2026-08-01T10:00:00.000Z',
    endsAt: '2026-08-01T11:00:00.000Z',
    status: 'CONFIRMED' as const,
    grossAmountMinor: 125_000,
    commissionAmountMinor: 12_500,
    taxAmountMinor: 2_250,
    venueNetAmountMinor: 110_250,
    currency: 'INR' as const,
    version: 1,
    confirmedAt: '2026-07-29T08:00:00.000Z',
    createdAt: '2026-07-29T08:00:00.000Z',
    updatedAt: '2026-07-29T08:00:00.000Z',
  };
  const service: OwnerBookingService = {
    async list(input) {
      calls.list = input;
      return {
        items: [item],
        pagination: { page: 1, limit: 50, total: 1, pages: 1 },
      };
    },
    async getDetail(input) {
      calls.detail = input;
      return { ...item, cancellation: null };
    },
  };

  return { calls, ownerAccessService, service };
}

async function buildTestApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ownerBookingRoutes, {
    service: fixture.service,
    ownerAccessService: fixture.ownerAccessService,
  });
  return app;
}

test('owner booking routes require an authenticated owner session', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject(`/${venueId}/bookings`);

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('owner booking list derives actor scope and validates filters', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject({
    method: 'GET',
    url:
      `/${venueId}/bookings?courtId=${courtId}` +
      '&status=CONFIRMED&from=2026-08-01T00%3A00%3A00.000Z' +
      '&to=2026-08-02T00%3A00%3A00.000Z&page=1&limit=25',
    headers: { authorization: 'Bearer owner-session' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.list, {
    actorOwnerId: ownerId,
    venueId,
    courtId,
    status: 'CONFIRMED',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-02T00:00:00.000Z',
    page: 1,
    limit: 25,
  });
  await app.close();
});

test('owner booking detail derives venue and booking scope', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const response = await app.inject({
    method: 'GET',
    url: `/${venueId}/bookings/${bookingId}`,
    headers: { authorization: 'Bearer owner-session' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().externalBookingReference, 'PARTNER-42');
  assert.deepEqual(fixture.calls.detail, {
    actorOwnerId: ownerId,
    venueId,
    bookingId,
  });
  await app.close();
});

test('owner booking routes reject invalid filters and expose no creation path', async () => {
  const fixture = createFixture();
  const app = await buildTestApp(fixture);

  const invalid = await app.inject({
    method: 'GET',
    url: `/${venueId}/bookings?status=PENDING&limit=101`,
    headers: { authorization: 'Bearer owner-session' },
  });
  const creation = await app.inject({
    method: 'POST',
    url: `/${venueId}/bookings`,
    headers: { authorization: 'Bearer owner-session' },
    payload: {},
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'VALIDATION_ERROR');
  assert.equal(creation.statusCode, 404);
  assert.equal(fixture.calls.list, undefined);
  await app.close();
});
