import assert from 'node:assert/strict';
import { test } from 'node:test';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import venueOwnerRoutes from '../src/modules/venue/venue-owner.routes.js';
import type { VenueOwnerService } from '../src/modules/venue/venue-owner.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000070';
const venueId = '687f00000000000000000071';

function venueProfile(version = 3) {
  return {
    id: venueId,
    legalName: 'Green Arena Private Limited',
    displayName: 'Green Arena',
    environment: 'PRODUCTION' as const,
    timezone: 'Asia/Kolkata',
    address: {
      line1: 'MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      country: 'IN',
    },
    latitude: 12.9716,
    longitude: 77.5946,
    currency: 'INR' as const,
    media: [],
    status: 'ACTIVE' as const,
    version,
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  };
}

function createFixture() {
  const calls: {
    get?: Parameters<VenueOwnerService['getProfile']>[0];
    update?: Parameters<VenueOwnerService['updateProfile']>[0];
    media?: Omit<
      Parameters<VenueOwnerService['addMedia']>[0],
      'buffer'
    > & { bufferText: string };
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
      return {
        membershipId: '687f00000000000000000072',
        role: 'OWNER',
      };
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };
  const service: VenueOwnerService = {
    async getProfile(input) {
      calls.get = input;
      return venueProfile();
    },
    async updateProfile(input) {
      calls.update = input;
      return venueProfile(input.expectedVersion + 1);
    },
    async addMedia(input) {
      const { buffer, ...metadata } = input;
      calls.media = {
        ...metadata,
        bufferText: buffer.toString('utf8'),
      };
      return venueProfile(input.expectedVersion + 1);
    },
  };
  return { calls, ownerAccessService, service };
}

async function buildRouteTestApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(venueOwnerRoutes, {
    service: fixture.service,
    ownerAccessService: fixture.ownerAccessService,
  });
  return app;
}

test('venue owner profile routes require authentication', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject(`/${venueId}`);

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('GET venue profile derives the actor from the session', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'GET',
    url: `/${venueId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.get, {
    actorOwnerId: ownerId,
    venueId,
  });
  await app.close();
});

test('PATCH venue profile forwards version and correlation context', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'PATCH',
    url: `/${venueId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: {
      version: 3,
      displayName: 'Green Arena Central',
      currency: 'INR',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.update?.actorOwnerId, ownerId);
  assert.equal(fixture.calls.update?.venueId, venueId);
  assert.equal(fixture.calls.update?.expectedVersion, 3);
  assert.equal(fixture.calls.update?.displayName, 'Green Arena Central');
  assert.equal(typeof fixture.calls.update?.correlationId, 'string');
  await app.close();
});

test('PATCH venue profile rejects unsupported currency and empty changes', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const currencyResponse = await app.inject({
    method: 'PATCH',
    url: `/${venueId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: { version: 3, displayName: 'Green Arena', currency: 'USD' },
  });
  const emptyResponse = await app.inject({
    method: 'PATCH',
    url: `/${venueId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: { version: 3 },
  });

  assert.equal(currencyResponse.statusCode, 400);
  assert.equal(currencyResponse.json().error.code, 'VALIDATION_ERROR');
  assert.equal(emptyResponse.statusCode, 400);
  assert.equal(emptyResponse.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});

test('POST venue media forwards multipart bytes and expected version', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);
  const boundary = 'venue-media-test-boundary';
  const payload = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="hero.jpg"\r\n' +
      'Content-Type: image/jpeg\r\n\r\n' +
      'image-bytes\r\n' +
      `--${boundary}--\r\n`,
  );

  const response = await app.inject({
    method: 'POST',
    url: `/${venueId}/media?version=3`,
    headers: {
      authorization: 'Bearer valid-owner-token',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });

  assert.equal(response.statusCode, 201);
  assert.equal(fixture.calls.media?.actorOwnerId, ownerId);
  assert.equal(fixture.calls.media?.expectedVersion, 3);
  assert.equal(fixture.calls.media?.filename, 'hero.jpg');
  assert.equal(fixture.calls.media?.mimeType, 'image/jpeg');
  assert.equal(fixture.calls.media?.bufferText, 'image-bytes');
  await app.close();
});
