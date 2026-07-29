import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import bookingLifecycleRoutes from '../src/modules/booking/booking-lifecycle.routes.js';
import type { BookingLifecycleService } from '../src/modules/booking/booking-lifecycle.service.js';
import type { PartnerAccessService } from '../src/modules/identity/partner/partner-access.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const partnerId = '687f00000000000000000901';
const bookingId = '687f00000000000000000902';
const slotId = '687f00000000000000000903';

function fixture(scopes = ['bookings:write']) {
  const calls: Record<string, unknown> = {};
  const service = {
    async hold(input) {
      calls.hold = input;
      return {
        holdId: 'hold-1',
        slotId,
        venueId: '687f00000000000000000904',
        courtId: '687f00000000000000000905',
        bookingType: input.bookingType,
        startsAt: '2026-08-03T04:30:00.000Z',
        endsAt: '2026-08-03T05:30:00.000Z',
        priceMinor: 1000,
        currency: 'INR',
        expiresAt: '2026-08-03T03:00:00.000Z',
      };
    },
    async confirm(input) {
      calls.confirm = input;
      return { bookingId, status: 'CONFIRMED' };
    },
    async cancel(input) {
      calls.cancel = input;
      return { bookingId, status: 'CANCELLED' };
    },
    async recoverExpiredHolds() {
      return { fixedReleased: 0, openReleased: 0 };
    },
    async getAudit(input) {
      calls.getAudit = input;
      return { bookingId: input.bookingId, auditHistory: [] };
    },
  } satisfies BookingLifecycleService;
  const partnerAccessService = {
    async authenticateRequest() {
      return {
        actorType: 'PARTNER',
        partnerId,
        keyId: '687f00000000000000000906',
        environment: 'PRODUCTION',
        scopes,
      };
    },
    async recordApiUsage(
      input: Parameters<PartnerAccessService['recordApiUsage']>[0],
    ) {
      calls.usage = input;
    },
  } as unknown as PartnerAccessService;
  const adminAuthService = {
    async authenticate() {
      return {
        actorType: 'ADMIN',
        adminId: '687f00000000000000000907',
        role: 'ADMIN',
      };
    },
  } as unknown as AdminAuthService;
  return { calls, service, partnerAccessService, adminAuthService };
}

async function appFor(value: ReturnType<typeof fixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(bookingLifecycleRoutes, value);
  return app;
}

const partnerHeaders = {
  'x-api-key': 'key',
  'x-signature': 'signature',
  'x-timestamp': '1770000000',
};

test('Booking lifecycle routes require Partner authentication and scope', async () => {
  const value = fixture([]);
  const app = await appFor(value);
  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/hold',
    payload: { bookingType: 'FIXED_SLOT', slotId },
  });
  const forbidden = await app.inject({
    method: 'POST',
    url: '/hold',
    headers: partnerHeaders,
    payload: { bookingType: 'FIXED_SLOT', slotId },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});

test('hold route requires a complete fixed or open-time request shape', async () => {
  const value = fixture();
  const app = await appFor(value);
  const invalid = await app.inject({
    method: 'POST',
    url: '/hold',
    headers: partnerHeaders,
    payload: {
      bookingType: 'FIXED_SLOT',
    },
  });
  const valid = await app.inject({
    method: 'POST',
    url: '/hold',
    headers: partnerHeaders,
    payload: { bookingType: 'FIXED_SLOT', slotId },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(valid.statusCode, 201);
  const call = value.calls.hold as Record<string, unknown>;
  assert.equal(call.partnerId, partnerId);
  assert.equal(call.environment, 'PRODUCTION');
  assert.equal(call.slotId, slotId);
  await app.close();
});

test('confirm and cancel require and forward Idempotency-Key', async () => {
  const value = fixture();
  const app = await appFor(value);
  const missing = await app.inject({
    method: 'POST',
    url: '/confirm',
    headers: partnerHeaders,
    payload: {
      holdId: 'hold-1',
      externalBookingReference: 'external-1',
    },
  });
  const confirmed = await app.inject({
    method: 'POST',
    url: '/confirm',
    headers: { ...partnerHeaders, 'idempotency-key': 'confirm-key' },
    payload: {
      holdId: 'hold-1',
      externalBookingReference: 'external-1',
    },
  });
  const cancelled = await app.inject({
    method: 'POST',
    url: `/${bookingId}/cancel`,
    headers: { ...partnerHeaders, 'idempotency-key': 'cancel-key' },
    payload: { reasonCode: 'CUSTOMER_REQUEST' },
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(confirmed.statusCode, 201);
  assert.equal(cancelled.statusCode, 201);
  assert.equal(
    (value.calls.confirm as Record<string, unknown>).idempotencyKey,
    'confirm-key',
  );
  assert.equal(
    (value.calls.cancel as Record<string, unknown>).idempotencyKey,
    'cancel-key',
  );
  await app.close();
});

test('Admin audit route authenticates and scopes the Booking identifier', async () => {
  const value = fixture();
  const app = await appFor(value);
  const unauthenticated = await app.inject({
    method: 'GET',
    url: `/admin/${bookingId}/audit`,
  });
  const response = await app.inject({
    method: 'GET',
    url: `/admin/${bookingId}/audit`,
    headers: { authorization: 'Bearer admin-token' },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(value.calls.getAudit, { bookingId });
  await app.close();
});
