import assert from 'node:assert/strict';
import { test } from 'node:test';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import courtOwnerRoutes from '../src/modules/venue/court-owner.routes.js';
import type { CourtOwnerService } from '../src/modules/venue/court-owner.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000090';
const venueId = '687f00000000000000000091';
const courtId = '687f00000000000000000092';

function courtView(version = 1) {
  return {
    id: courtId,
    venueId,
    name: 'Court One',
    sportType: 'FOOTBALL' as const,
      surfaceType: 'ARTIFICIAL_TURF',
      capacity: 10,
    bookingMode: 'BOTH' as const,
    minBookingMinutes: 60,
    bookingIncrementMinutes: 30,
    operatingHours: [],
    fixedSlotDurationMinutes: null,
    fixedSlotAnchorMinutes: null,
    media: [],
    status: 'AVAILABLE' as const,
    version,
    createdAt: '2026-07-28T11:00:00.000Z',
    updatedAt: '2026-07-28T11:00:00.000Z',
  };
}

function createFixture() {
  const calls: Record<string, unknown> = {};
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
        membershipId: '687f00000000000000000093',
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
  const service: CourtOwnerService = {
    async create(input) {
      calls.create = input;
      return courtView();
    },
    async list(input) {
      calls.list = input;
      return [courtView()];
    },
    async get(input) {
      calls.get = input;
      return courtView();
    },
    async update(input) {
      calls.update = input;
      return courtView(input.expectedVersion + 1);
    },
    async addMedia(input) {
      calls.media = {
        ...input,
        buffer: input.buffer.toString('utf8'),
      };
      return courtView(input.expectedVersion + 1);
    },
    async setOperatingHours(input) {
      calls.operatingHours = input;
      return courtView(input.expectedVersion + 1);
    },
  };
  return { calls, ownerAccessService, service };
}

async function buildApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(multipart);
  await app.register(courtOwnerRoutes, {
    service: fixture.service,
    ownerAccessService: fixture.ownerAccessService,
  });
  return app;
}

test('Court routes require a Venue Owner session', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const response = await app.inject(`/${venueId}/courts`);

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('POST Court derives owner, venue, and correlation context', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const response = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: {
      name: 'Court One',
      sportType: 'FOOTBALL',
      surfaceType: 'ARTIFICIAL_TURF',
      capacity: 10,
      bookingMode: 'BOTH',
      minBookingMinutes: 60,
      bookingIncrementMinutes: 30,
    },
  });

  assert.equal(response.statusCode, 201);
  const call = fixture.calls.create as Record<string, unknown>;
  assert.equal(call.actorOwnerId, ownerId);
  assert.equal(call.venueId, venueId);
  assert.equal(typeof call.correlationId, 'string');
  await app.close();
});

test('PUT operating hours forwards owner scope and optimistic version', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const response = await app.inject({
    method: 'PUT',
    url: `/${venueId}/courts/${courtId}/operating-hours`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: {
      version: 1,
      operatingHours: [
        { dayOfWeek: 1, opensAt: '06:00', closesAt: '22:00' },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  const call = fixture.calls.operatingHours as Record<string, unknown>;
  assert.equal(call.actorOwnerId, ownerId);
  assert.equal(call.venueId, venueId);
  assert.equal(call.courtId, courtId);
  assert.equal(call.expectedVersion, 1);
  await app.close();
});

test('Court list and detail remain venue-scoped', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const headers = { authorization: 'Bearer valid-owner-token' };

  const list = await app.inject({
    method: 'GET',
    url: `/${venueId}/courts`,
    headers,
  });
  const detail = await app.inject({
    method: 'GET',
    url: `/${venueId}/courts/${courtId}`,
    headers,
  });

  assert.equal(list.statusCode, 200);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(fixture.calls.get, {
    actorOwnerId: ownerId,
    venueId,
    courtId,
  });
  await app.close();
});

test('PATCH Court validates booking mode and version', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const response = await app.inject({
    method: 'PATCH',
    url: `/${venueId}/courts/${courtId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: { version: 1, bookingMode: 'INVALID' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});

test('POST Court media forwards multipart bytes and version', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const boundary = 'court-media-boundary';
  const payload = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="court.jpg"\r\n' +
      'Content-Type: image/jpeg\r\n\r\n' +
      'court-image\r\n' +
      `--${boundary}--\r\n`,
  );
  const response = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts/${courtId}/media?version=1`,
    headers: {
      authorization: 'Bearer valid-owner-token',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });

  assert.equal(response.statusCode, 201);
  const call = fixture.calls.media as Record<string, unknown>;
  assert.equal(call.expectedVersion, 1);
  assert.equal(call.filename, 'court.jpg');
  assert.equal(call.buffer, 'court-image');
  await app.close();
});
