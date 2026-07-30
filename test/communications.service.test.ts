import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { CommunicationsRepository } from '../src/shared/communications/communications.repository.js';
import { createCommunicationsService } from '../src/shared/communications/communications.service.js';
import {
  externalEventType,
  type OutboxEventDocument,
  type OwnerNotificationDocument,
} from '../src/shared/communications/communications.types.js';
import {
  createWebhookSignature,
  isPublicAddress,
  resolvePublicDestination,
} from '../src/shared/communications/webhook-transport.js';
import { deriveSigningSecret, hashCredential } from '../src/shared/auth/partner-signature.js';

const timestamp = new Date('2026-08-01T00:00:00.000Z');
const masterSecret = 'communications-test-master-secret-32-chars';
const endpointId = new ObjectId('68a000000000000000000001');
const ownerId = new ObjectId('68a000000000000000000002');
const venueId = new ObjectId('68a000000000000000000003');
const eventId = new ObjectId('68a000000000000000000004');

test('Communications maps public event names and signs exact outbound bytes', () => {
  assert.equal(externalEventType('BOOKING_CONFIRMED'), 'booking.confirmed');
  const signature = createWebhookSignature('123', '{"ok":true}', 'secret');
  assert.equal(
    signature,
    `sha256=${createHmac('sha256', 'secret')
      .update('123.{"ok":true}')
      .digest('hex')}`,
  );
});

test('SSRF address validation rejects private and reserved destinations', () => {
  for (const value of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ]) {
    assert.equal(isPublicAddress(value), false, value);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('webhook destination resolution blocks literals, localhost, and URL credentials', async () => {
  await assert.rejects(resolvePublicDestination('https://127.0.0.1/hook'));
  await assert.rejects(resolvePublicDestination('https://localhost/hook'));
  await assert.rejects(
    resolvePublicDestination('https://user:secret@example.com/hook'),
  );
});

test('worker materializes a durable notification, removes invalid push tokens, and publishes', async () => {
  const event = bookingEvent();
  const repository = fixtureRepository(event);
  const notifications: OwnerNotificationDocument[] = [];
  const removed: string[] = [];
  let savedStatus = '';
  repository.listRecipientOwnerIds = async () => [ownerId];
  repository.appendNotification = async (_id, notification) => {
    notifications.push(notification);
    return true;
  };
  repository.listOwnerTokens = async () => [{
    token: 'token-that-is-long-enough-for-fcm',
    device_id: 'phone',
    platform: 'ANDROID',
    last_seen_at: timestamp,
    created_at: timestamp,
  }];
  repository.removeOwnerTokens = async (_id, tokens) => {
    removed.push(...tokens);
  };
  repository.saveEvent = async (input) => {
    savedStatus = input.status;
    assert.equal(input.deliveries[0]?.status, 'DELIVERED');
    return true;
  };
  const service = createCommunicationsService({
    repository,
    webhookTransport: {
      async deliver(input) {
        assert.equal(input.eventType, 'booking.confirmed');
        return {
          delivered: true,
          retryable: false,
          attempt: {
            attempted_at: timestamp,
            request_payload: input.body,
            redacted_headers: {},
            response_code: 204,
            response_payload: '',
            error: null,
            completed_at: timestamp,
          },
        };
      },
    },
    pushDelivery: {
      async send() {
        return {
          invalidTokens: ['token-that-is-long-enough-for-fcm'],
        };
      },
    },
    authConfig: authConfig(),
    config: communicationsConfig(),
    now: () => timestamp,
    random: () => 0,
  });

  assert.equal(await service.processNext('worker-one'), true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notification_type, 'BOOKING_CONFIRMED');
  assert.deepEqual(removed, ['token-that-is-long-enough-for-fcm']);
  assert.equal(savedStatus, 'PUBLISHED');
});

test('retryable webhooks use bounded exponential scheduling', async () => {
  const event = bookingEvent();
  const repository = fixtureRepository(event);
  repository.saveEvent = async (input) => {
    assert.equal(input.status, 'PENDING');
    assert.equal(input.deliveries[0]?.status, 'RETRYING');
    assert.equal(input.deliveries[0]?.attempt_count, 1);
    assert.equal(
      input.availableAt.toISOString(),
      '2026-08-01T00:00:30.000Z',
    );
    return true;
  };
  const service = createCommunicationsService({
    repository,
    webhookTransport: {
      async deliver() {
        return {
          delivered: false,
          retryable: true,
          attempt: {
            attempted_at: timestamp,
            request_payload: '{}',
            redacted_headers: {},
            response_code: 503,
            response_payload: '',
            error: 'HTTP 503',
            completed_at: timestamp,
          },
        };
      },
    },
    pushDelivery: { async send() { return { invalidTokens: [] }; } },
    authConfig: authConfig(),
    config: communicationsConfig(),
    now: () => timestamp,
    random: () => 0,
  });
  assert.equal(await service.processNext('worker-two'), true);
});

function bookingEvent(): OutboxEventDocument {
  return {
    _id: eventId,
    aggregate_type: 'BOOKING',
    aggregate_id: new ObjectId('68a000000000000000000005'),
    partner_id: new ObjectId('68a000000000000000000006'),
    venue_id: venueId,
    environment: 'PRODUCTION',
    event_type: 'BOOKING_CONFIRMED',
    event_version: 1,
    correlation_id: 'communications-test',
    payload: { venue_id: venueId.toHexString() },
    status: 'PROCESSING',
    attempts: 1,
    available_at: timestamp,
    locked_by: 'worker',
    locked_until: new Date(timestamp.getTime() + 60_000),
    webhook_endpoint_ids: [endpointId],
    published_at: null,
    webhook_deliveries: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function fixtureRepository(
  event: OutboxEventDocument,
): CommunicationsRepository {
  let claimed = false;
  const secret = deriveSigningSecret(
    masterSecret,
    `webhook:${endpointId.toHexString()}`,
  );
  return {
    async claimNext(input) {
      if (claimed) return null;
      claimed = true;
      return { ...event, locked_by: input.workerId };
    },
    async renewLease() { return true; },
    async saveEvent() { return true; },
    async findEndpoint() {
      return {
        _id: endpointId,
        partner_id: event.partner_id!,
        environment: event.environment,
        url: 'https://example.com/events',
        signing_secret_hash: hashCredential(secret),
        subscribed_event_types: ['booking.confirmed'],
        status: 'ACTIVE',
        verified_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      };
    },
    async listRecipientOwnerIds() { return []; },
    async appendNotification() { return false; },
    async listOwnerTokens() { return []; },
    async removeOwnerTokens() {},
    async upsertDevice() { return 'UPDATED'; },
    async removeDevice() { return true; },
    async listNotifications() {
      return { items: [], total: 0, unreadCount: 0 };
    },
    async markNotificationRead() { return 'UPDATED'; },
    async listDeliveries() { return { items: [], total: 0 }; },
    async findEvent() { return event; },
    async scheduleRetry() { return true; },
  };
}

function authConfig() {
  return {
    sessionTtlHours: 168,
    maxSessions: 5,
    maxLoginAttempts: 5,
    lockMinutes: 15,
    adminAccessTokenSecret: 'admin-test-secret-that-is-long-enough',
    adminAccessTokenTtlMinutes: 60,
    partnerCredentialMasterSecret: masterSecret,
    partnerHmacMaxSkewSeconds: 300,
  };
}

function communicationsConfig() {
  return {
    pollIntervalMs: 1_000,
    batchSize: 20,
    leaseSeconds: 60,
    requestTimeoutMs: 10_000,
    maxWebhookAttempts: 8,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
  };
}
