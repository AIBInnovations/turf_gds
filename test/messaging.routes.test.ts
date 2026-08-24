import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { PartnerAccessService } from '../src/modules/identity/partner/partner-access.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import {
  adminMessagingRoutes,
  ownerMessagingRoutes,
  partnerMessagingRoutes,
} from '../src/modules/messaging/messaging.routes.js';
import type { MessagingService } from '../src/modules/messaging/messaging.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const adminId = '68c000000000000000000001';
const ownerId = '68c000000000000000000002';
const partnerId = '68c000000000000000000003';

function fakeService(calls: Array<Record<string, unknown>>): MessagingService {
  return {
    async send(input) {
      calls.push({ op: 'send', ...input });
      return {
        messageId: '68c0000000000000000000ff',
        recipientType: input.recipientType,
        recipientId: input.recipientId,
        direction: 'OUTBOUND',
        senderName: 'Platform Admin',
        subject: input.subject ?? '',
        body: input.body,
        readAt: null,
        createdAt: new Date(0).toISOString(),
      };
    },
    async reply(input) {
      calls.push({ op: 'reply', ...input });
      return {
        messageId: '68c0000000000000000000fe',
        recipientType: input.recipientType,
        recipientId: input.recipientId,
        direction: 'INBOUND',
        senderName: input.senderName,
        subject: input.subject ?? '',
        body: input.body,
        readAt: null,
        createdAt: new Date(0).toISOString(),
      };
    },
    async listThread(input) {
      calls.push({ op: 'listThread', ...input });
      return { items: [], pagination: { page: 1, limit: 30, total: 0, totalPages: 1 } };
    },
    async listThreads(input) {
      calls.push({ op: 'listThreads', ...input });
      return { items: [], pagination: { page: 1, limit: 30, total: 0, totalPages: 1 } };
    },
    async markRead(input) {
      calls.push({ op: 'markRead', ...input });
      return { updated: 0 };
    },
    async unreadForRecipient() {
      return { unread: 0 };
    },
  };
}

const adminAuthService = {
  async authenticate(token: string) {
    if (token === 'admin-token') {
      return { actorType: 'ADMIN' as const, adminId, role: 'ADMIN' as const };
    }
    if (token === 'support-token') {
      return { actorType: 'ADMIN' as const, adminId, role: 'SUPPORT' as const };
    }
    throw new Error('invalid');
  },
} as AdminAuthService;

test('Admin messaging routes authenticate, validate and pass the sender through', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(adminMessagingRoutes, {
    prefix: '/api/v1/admin/messages',
    service: fakeService(calls),
    adminAuthService,
  });

  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/messages/threads',
  });
  assert.equal(anonymous.statusCode, 401);

  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/messages',
    headers: { authorization: 'Bearer admin-token' },
    payload: { recipientType: 'VENUE_OWNER', recipientId: ownerId, subject: 'Hi', body: 'Hello there' },
  });
  assert.equal(sent.statusCode, 201);
  assert.equal(sent.json().direction, 'OUTBOUND');
  assert.deepEqual(calls.at(-1), {
    op: 'send',
    recipientType: 'VENUE_OWNER',
    recipientId: ownerId,
    subject: 'Hi',
    body: 'Hello there',
    senderAdminId: adminId,
  });

  // A body is the one required field, and an unknown recipient type never reaches the service.
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/messages',
    headers: { authorization: 'Bearer admin-token' },
    payload: { recipientType: 'SOMEONE', recipientId: ownerId, body: 'x' },
  });
  assert.equal(invalid.statusCode, 400);

  // SUPPORT reads the console but does not write to a customer in the platform's name.
  const support = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/messages',
    headers: { authorization: 'Bearer support-token' },
    payload: { recipientType: 'VENUE_OWNER', recipientId: ownerId, body: 'Hello' },
  });
  assert.equal(support.statusCode, 403);
  assert.equal(support.json().error.code, 'MESSAGING_OPERATOR_REQUIRED');

  // …but it can still read, and clear its own side of the badge.
  const read = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/messages/read',
    headers: { authorization: 'Bearer support-token' },
    payload: { recipientType: 'VENUE_OWNER', recipientId: ownerId },
  });
  assert.equal(read.statusCode, 200);
  assert.equal((calls.at(-1) as { side: string }).side, 'ADMIN');
});

test('Recipient messaging routes take the thread from the session, never the request', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = fakeService(calls);
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(ownerMessagingRoutes, {
    prefix: '/api/v1/owner',
    service,
    ownerAccessService: {
      async authenticateOwner(token: string) {
        if (token !== 'owner-token') throw new Error('invalid');
        return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
      },
    } as OwnerAccessService,
  });
  await app.register(partnerMessagingRoutes, {
    prefix: '/api/v1/partners',
    service,
    partnerAccessService: {
      async authenticatePortalSession(token: string) {
        if (token !== 'partner-token') throw new Error('invalid');
        return { actorType: 'PARTNER_PORTAL', partnerId, status: 'ACTIVE' };
      },
    } as unknown as PartnerAccessService,
  });

  const ownerReply = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/messages',
    headers: { authorization: 'Bearer owner-token' },
    payload: { body: 'Thanks, uploading now' },
  });
  assert.equal(ownerReply.statusCode, 201);
  assert.equal(ownerReply.json().direction, 'INBOUND');
  assert.equal((calls.at(-1) as { recipientId: string }).recipientId, ownerId);

  // An id smuggled into the payload is stripped by the schema and ignored by the handler —
  // the thread written to is always the session's own.
  const spoof = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/messages',
    headers: { authorization: 'Bearer owner-token' },
    payload: { body: 'x', recipientId: partnerId, recipientType: 'PARTNER' },
  });
  assert.equal(spoof.statusCode, 201);
  assert.equal((calls.at(-1) as { recipientId: string }).recipientId, ownerId);
  assert.equal((calls.at(-1) as { recipientType: string }).recipientType, 'VENUE_OWNER');

  const partnerList = await app.inject({
    method: 'GET',
    url: '/api/v1/partners/me/messages',
    headers: { authorization: 'Bearer partner-token' },
  });
  assert.equal(partnerList.statusCode, 200);
  assert.deepEqual(calls.at(-1), {
    op: 'listThread',
    recipientType: 'PARTNER',
    recipientId: partnerId,
  });

  const partnerRead = await app.inject({
    method: 'POST',
    url: '/api/v1/partners/me/messages/read',
    headers: { authorization: 'Bearer partner-token' },
  });
  assert.equal(partnerRead.statusCode, 200);
  assert.equal((calls.at(-1) as { side: string }).side, 'RECIPIENT');
});
