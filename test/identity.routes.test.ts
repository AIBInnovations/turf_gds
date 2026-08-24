import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import identityRoutes from '../src/modules/identity/owner/owner-auth.routes.js';
import type { IdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

function createRouteTestService(): IdentityService {
  return {
    async registerVenueOwner() {
      return {
        ownerId: '687f00000000000000000001',
        venueId: '687f00000000000000000002',
        membershipId: '687f00000000000000000003',
        ownerStatus: 'ACTIVE',
        venueStatus: 'PENDING',
      };
    },

    async loginVenueOwner(input) {
      return {
        sessionToken: 'raw-session-token',
        expiresAt: '2026-08-04T08:00:00.000Z',
        owner: {
          id: '687f00000000000000000001',
          legalName: 'Turf Owner Private Limited',
          email: input.email,
          status: 'ACTIVE',
        },
      };
    },

    async loginVenueOwnerWithOtp() {
      return {
        sessionToken: 'raw-otp-session-token',
        expiresAt: '2026-08-04T08:00:00.000Z',
        owner: {
          id: '687f00000000000000000001',
          legalName: 'Turf Owner Private Limited',
          email: 'owner@example.com',
          status: 'ACTIVE',
        },
      };
    },

    async validateOwnerSession() {
      return {
        ownerId: '687f00000000000000000001',
        ownerStatus: 'ACTIVE',
        membership: null,
      };
    },

    async approveVenueOwner() {},
  };
}

async function buildRouteTestApp() {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(identityRoutes, {
    service: createRouteTestService(),
  });
  return app;
}

test('registration rejects malformed input with the standard error', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/register',
    payload: {
      email: 'not-an-email',
      password: 'short',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  assert.equal(typeof response.json().error.requestId, 'string');

  await app.close();
});

test('login route returns the session result', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/login',
    payload: {
      email: 'owner@example.com',
      password: 'correct-horse-battery',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().sessionToken, 'raw-session-token');
  assert.equal(response.json().owner.email, 'owner@example.com');

  await app.close();
});

test('otp/verify route returns the session result', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/otp/verify',
    payload: {
      phoneE164: '+919876543210',
      accessToken: 'a-verified-msg91-access-token',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().sessionToken, 'raw-otp-session-token');

  await app.close();
});

test('otp/verify route rejects a malformed phone number', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/otp/verify',
    payload: {
      phoneE164: 'not-a-phone-number',
      accessToken: 'a-verified-msg91-access-token',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');

  await app.close();
});

test('registration rejects a body carrying neither password nor accessToken', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/register',
    payload: {
      legalName: 'Turf Owner Private Limited',
      email: 'owner@example.com',
      phoneE164: '+919876543210',
      venue: {
        legalName: 'Green Arena Private Limited',
        displayName: 'Green Arena',
        timezone: 'Asia/Kolkata',
        address: {
          line1: 'MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
          country: 'in',
        },
        latitude: 12.9716,
        longitude: 77.5946,
      },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');

  await app.close();
});

test('registration accepts an accessToken in place of a password', async () => {
  const app = await buildRouteTestApp();

  const response = await app.inject({
    method: 'POST',
    url: '/register',
    payload: {
      legalName: 'Turf Owner Private Limited',
      email: 'owner@example.com',
      phoneE164: '+919876543210',
      accessToken: 'a-verified-msg91-access-token',
      venue: {
        legalName: 'Green Arena Private Limited',
        displayName: 'Green Arena',
        timezone: 'Asia/Kolkata',
        address: {
          line1: 'MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
          country: 'in',
        },
        latitude: 12.9716,
        longitude: 77.5946,
      },
    },
  });

  assert.equal(response.statusCode, 201);

  await app.close();
});
