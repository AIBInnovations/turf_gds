import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import adminCommunicationsRoutes from '../src/shared/communications/admin-communications.routes.js';
import type { CommunicationsService } from '../src/shared/communications/communications.service.js';
import ownerCommunicationsRoutes from '../src/shared/communications/owner-communications.routes.js';
import ownerDeviceRoutes from '../src/shared/communications/owner-device.routes.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '68b000000000000000000001';
const aggregateId = '68b000000000000000000002';

test('Owner Communications routes authenticate, validate, and derive owner scope', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = fakeService({
    async registerDevice(input) {
      calls.push(input);
      return { deviceId: input.deviceId, platform: input.platform };
    },
    async listNotifications(input) {
      calls.push(input);
      return { items: [], unreadCount: 0, pagination: {} };
    },
    async markNotificationRead(input) {
      calls.push(input);
    },
  });
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  const ownerAccessService = {
    async authenticateOwner(token: string) {
      if (token !== 'valid-owner-token') throw new Error('invalid');
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
  } as OwnerAccessService;
  await app.register(ownerDeviceRoutes, {
    prefix: '/api/v1/auth/venue-owners',
    service,
    ownerAccessService,
  });
  await app.register(ownerCommunicationsRoutes, {
    prefix: '/api/v1/owner',
    service,
    ownerAccessService,
  });
  const headers = { authorization: 'Bearer valid-owner-token' };
  const device = await app.inject({
    method: 'PUT',
    url: '/api/v1/auth/venue-owners/devices/phone',
    headers,
    payload: {
      token: 'route-fcm-token-that-is-long-enough',
      platform: 'ANDROID',
    },
  });
  assert.equal(device.statusCode, 200);
  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/owner/notifications?unreadOnly=true&limit=10',
    headers,
  });
  assert.equal(list.statusCode, 200);
  const read = await app.inject({
    method: 'PATCH',
    url: '/api/v1/owner/notifications/read',
    headers,
    payload: {
      notificationType: 'BOOKING_CONFIRMED',
      aggregateType: 'BOOKING',
      aggregateId,
    },
  });
  assert.equal(read.statusCode, 204);
  assert.equal(calls.every((call) => call.ownerId === ownerId), true);
  const invalid = await app.inject({
    method: 'GET',
    url: '/api/v1/owner/notifications?limit=101',
    headers,
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test('Communications monitoring is readable by staff but retry is ADMIN/OPS only', async () => {
  let retries = 0;
  const service = fakeService({
    async listDeliveries() {
      return { items: [], pagination: {} };
    },
    async retryDelivery() {
      retries += 1;
    },
  });
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  const adminAuthService = {
    async authenticate(token: string) {
      const role = token === 'support' ? 'SUPPORT' : token === 'ops'
        ? 'OPS'
        : 'ADMIN';
      return {
        actorType: 'ADMIN',
        adminId: '68b000000000000000000003',
        role,
      };
    },
  } as AdminAuthService;
  await app.register(adminCommunicationsRoutes, {
    prefix: '/api/v1/admin/communications',
    service,
    adminAuthService,
  });
  const supportRead = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/communications/deliveries',
    headers: { authorization: 'Bearer support' },
  });
  assert.equal(supportRead.statusCode, 200);
  const supportRetry = await app.inject({
    method: 'POST',
    url:
      '/api/v1/admin/communications/events/68b000000000000000000004/' +
      'endpoints/68b000000000000000000005/retry',
    headers: { authorization: 'Bearer support' },
  });
  assert.equal(supportRetry.statusCode, 403);
  const opsRetry = await app.inject({
    method: 'POST',
    url:
      '/api/v1/admin/communications/events/68b000000000000000000004/' +
      'endpoints/68b000000000000000000005/retry',
    headers: { authorization: 'Bearer ops' },
  });
  assert.equal(opsRetry.statusCode, 204);
  assert.equal(retries, 1);
  await app.close();
});

function fakeService(
  overrides: Partial<CommunicationsService>,
): CommunicationsService {
  return {
    async registerDevice(input) {
      return { deviceId: input.deviceId, platform: input.platform };
    },
    async removeDevice() {},
    async listNotifications() {
      return { items: [], unreadCount: 0, pagination: {} };
    },
    async markNotificationRead() {},
    async listDeliveries() {
      return { items: [], pagination: {} };
    },
    async getEvent() {
      return {};
    },
    async retryDelivery() {},
    async processNext() {
      return false;
    },
    async drain() {
      return 0;
    },
    ...overrides,
  };
}
