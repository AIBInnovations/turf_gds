import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { createCommunicationsRepository } from '../src/shared/communications/communications.repository.js';
import { createCommunicationsService } from '../src/shared/communications/communications.service.js';
import { EXTERNAL_EVENT_TYPES } from '../src/shared/communications/communications.types.js';
import { initializeOutboxPersistence } from '../src/shared/communications/outbox.persistence.js';
import { createOutboxRepository } from '../src/shared/communications/outbox.repository.js';
import { deriveSigningSecret, hashCredential } from '../src/shared/auth/partner-signature.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';

test('Communications migrates subscriptions and atomically drains an event once', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_comms_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 4,
  });
  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    const partnerId = new ObjectId();
    const venueId = new ObjectId();
    const ownerId = new ObjectId();
    const endpointId = new ObjectId();
    const now = new Date('2026-08-02T00:00:00.000Z');
    await database.db.createCollection('webhook_endpoints');
    await database.db.collection('webhook_endpoints').insertOne({
      _id: endpointId,
      partner_id: partnerId,
      environment: 'PRODUCTION',
      url: 'https://example.com/events',
      signing_secret_hash: hashCredential(
        deriveSigningSecret(
          'communications-integration-secret-long-enough',
          `webhook:${endpointId.toHexString()}`,
        ),
      ),
      status: 'ACTIVE',
      verified_at: now,
      created_at: now,
      updated_at: now,
    });
    await initializeIdentityPersistence(database.db);
    await initializeOutboxPersistence(database.db);
    const migrated = await database.db
      .collection('webhook_endpoints')
      .findOne({ _id: endpointId });
    assert.deepEqual(
      migrated?.subscribed_event_types,
      [...EXTERNAL_EVENT_TYPES],
    );
    await database.db.collection('venue_owners').insertOne({
      _id: ownerId,
      legal_name: 'Communications Owner',
      email: `communications-${ownerId.toHexString()}@example.com`,
      phone_e164: '+919999999999',
      password_hash: 'hash',
      email_verified_at: null,
      kyc_status: 'VERIFIED',
      status: 'ACTIVE',
      failed_login_count: 0,
      locked_until: null,
      last_login_at: null,
      sessions: [],
      fcm_tokens: [{
        token: 'integration-fcm-token-long-enough',
        device_id: 'phone',
        platform: 'ANDROID',
        last_seen_at: now,
        created_at: now,
      }],
      notifications: [],
      audit_history: [],
      approved_by: null,
      approved_at: null,
      created_at: now,
      updated_at: now,
    });
    await assert.rejects(
      database.db.collection('venue_owners').updateOne(
        { _id: ownerId },
        {
          $set: {
            fcm_tokens: Array.from({ length: 21 }, (_, index) => ({
              token: `integration-token-${index}-long-enough`,
              device_id: `device-${index}`,
              platform: 'ANDROID',
              last_seen_at: now,
              created_at: now,
            })),
          },
        },
      ),
    );
    await database.db.collection('venue_owner_memberships').insertOne({
      _id: new ObjectId(),
      owner_id: ownerId,
      venue_id: venueId,
      role: 'OWNER',
      status: 'ACTIVE',
      created_at: now,
    });
    const aggregateId = new ObjectId();
    await database.withTransaction(async ({ session }) => {
      await createOutboxRepository(database).enqueue({
        aggregateType: 'BOOKING',
        aggregateId,
        partnerId,
        venueId,
        environment: 'PRODUCTION',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 1,
        correlationId: 'communications-integration',
        payload: { booking_id: aggregateId.toHexString() },
        now,
        session,
      });
    });
    const stored = await database.db.collection('outbox_events').findOne({
      aggregate_id: aggregateId,
    });
    assert.deepEqual(stored?.webhook_endpoint_ids, [endpointId]);
    await assert.rejects(
      database.db.collection('outbox_events').updateOne(
        { aggregate_id: aggregateId },
        {
          $set: {
            webhook_endpoint_ids: Array.from(
              { length: 21 },
              () => new ObjectId(),
            ),
          },
        },
      ),
    );
    const outboxIndexNames = (
      await database.db.collection('outbox_events').indexes()
    ).map(({ name }) => name);
    assert.equal(
      outboxIndexNames.includes('ix_outbox_webhook_delivery_due'),
      true,
    );
    const repository = createCommunicationsRepository(database);
    const claims = await Promise.all([
      repository.claimNext({
        workerId: 'concurrent-a',
        now,
        lockedUntil: new Date(now.getTime() + 60_000),
      }),
      repository.claimNext({
        workerId: 'concurrent-b',
        now,
        lockedUntil: new Date(now.getTime() + 60_000),
      }),
    ]);
    const winners = claims.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    assert.equal(winners.length, 1);
    assert.equal(
      await repository.saveEvent({
        eventId: winners[0]!._id,
        workerId: winners[0]!.locked_by!,
        status: 'PENDING',
        deliveries: [],
        availableAt: now,
        publishedAt: null,
        now,
      }),
      true,
    );
    let delivered = 0;
    const service = createCommunicationsService({
      repository,
      webhookTransport: {
        async deliver(input) {
          delivered += 1;
          return {
            delivered: true,
            retryable: false,
            attempt: {
              attempted_at: now,
              request_payload: input.body,
              redacted_headers: {},
              response_code: 200,
              response_payload: 'ok',
              error: null,
              completed_at: now,
            },
          };
        },
      },
      pushDelivery: {
        async send() {
          return { invalidTokens: ['integration-fcm-token-long-enough'] };
        },
      },
      authConfig: {
        sessionTtlHours: 168,
        maxSessions: 5,
        maxLoginAttempts: 5,
        lockMinutes: 15,
        adminAccessTokenSecret: 'admin-secret-that-is-long-enough-for-test',
        adminAccessTokenTtlMinutes: 60,
        partnerCredentialMasterSecret:
          'communications-integration-secret-long-enough',
        partnerHmacMaxSkewSeconds: 300,
      },
      config: {
        pollIntervalMs: 1_000,
        batchSize: 20,
        leaseSeconds: 60,
        requestTimeoutMs: 10_000,
        maxWebhookAttempts: 8,
        retryBaseSeconds: 30,
        retryMaxSeconds: 3_600,
      },
      now: () => now,
      random: () => 0,
    });
    assert.equal(await service.processNext('integration-worker'), true);
    assert.equal(await service.processNext('second-worker'), false);
    assert.equal(delivered, 1);
    const published = await database.db.collection('outbox_events').findOne({
      aggregate_id: aggregateId,
    });
    assert.equal(published?.status, 'PUBLISHED');
    assert.equal(published?.webhook_deliveries[0]?.status, 'DELIVERED');
    const owner = await database.db.collection('venue_owners').findOne({
      _id: ownerId,
    });
    assert.equal(owner?.notifications.length, 1);
    assert.equal(owner?.notifications[0]?.notification_type, 'BOOKING_CONFIRMED');
    assert.deepEqual(owner?.fcm_tokens, []);
  } finally {
    if (databaseName.startsWith('turf_gds_comms_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
