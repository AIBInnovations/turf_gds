import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import ownerAccessRoutes from '../src/modules/identity/owner/owner-access.routes.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000040';
const venueId = '687f00000000000000000041';
const memberOwnerId = '687f00000000000000000042';

function createFixture() {
  const calls: {
    logoutToken?: string;
    addMember?: Parameters<OwnerAccessService['addMember']>[0];
    listMembers?: { ownerId: string; venueId: string };
  } = {};

  const service: OwnerAccessService = {
    async authenticateOwner(token) {
      if (token !== 'valid-owner-token') {
        throw new Error('test received an unexpected token');
      }
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
    async logout(_ownerId, token) {
      calls.logoutToken = token;
    },
    async getProfile() {
      return {
        id: ownerId,
        legalName: 'Green Arena Owner',
        email: 'owner@example.com',
        phoneE164: '+919876543210',
        status: 'ACTIVE',
        emailVerifiedAt: null,
        memberships: [
          {
            id: '687f00000000000000000043',
            venueId,
            role: 'OWNER',
            permissions: ['MANAGE_MEMBERS'],
          },
        ],
      };
    },
    async requirePermission() {},
    async requireVenueMembership() {
      return {
        membershipId: '687f00000000000000000045',
        role: 'OWNER',
      };
    },
    async listMembers(actingOwnerId, requestedVenueId) {
      calls.listMembers = {
        ownerId: actingOwnerId,
        venueId: requestedVenueId,
      };
      return [
        {
          ownerId,
          legalName: 'Green Arena Owner',
          email: 'owner@example.com',
          role: 'OWNER',
          status: 'ACTIVE',
        },
      ];
    },
    async addMember(input) {
      calls.addMember = input;
      return {
        membershipId: '687f00000000000000000044',
        status: 'ACTIVE',
      };
    },
    async revokeMember() {},
  };

  return { service, calls };
}

async function buildRouteTestApp(service: OwnerAccessService) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(ownerAccessRoutes, { service });
  return app;
}

test('owner access routes require a Bearer session', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture.service);

  const response = await app.inject('/me');

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('GET /me returns the authenticated owner profile', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture.service);

  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().id, ownerId);
  assert.equal(response.json().memberships[0].venueId, venueId);
  await app.close();
});

test('logout revokes the authenticated raw session token', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture.service);

  const response = await app.inject({
    method: 'POST',
    url: '/logout',
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(fixture.calls.logoutToken, 'valid-owner-token');
  await app.close();
});

test('member routes scope requests to the authenticated owner and venue', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture.service);

  const addResponse = await app.inject({
    method: 'POST',
    url: `/venues/${venueId}/members`,
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: { memberOwnerId, role: 'STAFF' },
  });
  const listResponse = await app.inject({
    method: 'GET',
    url: `/venues/${venueId}/members`,
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(addResponse.statusCode, 201);
  assert.deepEqual(fixture.calls.addMember, {
    actingOwnerId: ownerId,
    venueId,
    memberOwnerId,
    role: 'STAFF',
  });
  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(fixture.calls.listMembers, { ownerId, venueId });
  await app.close();
});

test('member routes reject malformed identifiers before service execution', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture.service);

  const response = await app.inject({
    method: 'DELETE',
    url: `/venues/not-an-id/members/${memberOwnerId}`,
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});
