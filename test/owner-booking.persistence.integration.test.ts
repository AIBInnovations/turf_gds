import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { MongoServerError, ObjectId } from 'mongodb';

import { initializeBookingPersistence } from '../src/modules/booking/booking.persistence.js';
import { createOwnerBookingRepository } from '../src/modules/booking/owner-booking.repository.js';
import { createOwnerBookingService } from '../src/modules/booking/owner-booking.service.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
} from '../src/modules/booking/booking.types.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { createIdentityRepository } from '../src/modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import { createOwnerAccessRepository } from '../src/modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { createVenueRepository } from '../src/modules/venue/profile/venue.repository.js';
import { createVenueService } from '../src/modules/venue/profile/venue.service.js';
import type { AppConfig } from '../src/config/env.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const authConfig: AppConfig['auth'] = {
  sessionTtlHours: 168,
  maxSessions: 5,
  maxLoginAttempts: 5,
  lockMinutes: 15,
  adminAccessTokenSecret: 'test-admin-secret-with-at-least-32-chars',
  adminAccessTokenTtlMinutes: 60,
  partnerCredentialMasterSecret:
    'test-partner-secret-with-at-least-32-chars',
  partnerHmacMaxSkewSeconds: 300,
};

test('Owner Booking persistence enforces filters, detail scope, cancellation, and cross-owner isolation', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }

  const databaseName =
    `turf_gds_owner_booking_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 2,
  });

  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }

    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeBookingPersistence(database.db);
    const venueRepository = createVenueRepository(database);
    const identityService = createIdentityService({
      repository: createIdentityRepository(database),
      venueService: createVenueService({ repository: venueRepository }),
      database,
      authConfig,
    });
    const firstOwner = await identityService.registerVenueOwner(
      registrationInput('booking-owner-a@example.com', 'Booking Arena A'),
    );
    const secondOwner = await identityService.registerVenueOwner(
      registrationInput('booking-owner-b@example.com', 'Booking Arena B'),
    );
    const ownerAccessService = createOwnerAccessService({
      identityService,
      repository: createOwnerAccessRepository(database),
    });
    const service = createOwnerBookingService({
      repository: createOwnerBookingRepository(database),
      ownerAccessService,
      database,
      outboxRepository: { async enqueue() {} },
    });

    const courtId = new ObjectId();
    const bookingId = new ObjectId();
    const timestamp = new Date('2026-07-29T08:00:00.000Z');
    const document: BookingDocument = {
      _id: bookingId,
      partner_id: new ObjectId(),
      venue_id: new ObjectId(firstOwner.venueId),
      court_id: courtId,
      slot_id: new ObjectId(),
      contract_id: new ObjectId(),
      environment: 'SANDBOX',
      external_booking_reference: 'INTEGRATION-BOOKING-1',
      confirm_idempotency_key: 'integration-confirm-key',
      customer_reference: null,
      partner_payment_reference: null,
      booking_type: 'FIXED_SLOT',
      starts_at: new Date('2026-08-01T10:00:00.000Z'),
      ends_at: new Date('2026-08-01T11:00:00.000Z'),
      status: 'CANCELLED',
      gross_amount_minor: 125_000,
      commission_amount_minor: 12_500,
      tax_amount_minor: 2_250,
      venue_net_amount_minor: 110_250,
      currency: 'INR',
      cancellation_terms_snapshot: { refund_percent: 50 },
      audit_history: [{
        event_type: 'BOOKING_CONFIRMED',
        actor_type: 'PARTNER',
        actor_id: new ObjectId(),
        correlation_id: 'integration-confirm',
        changes: { status: 'CONFIRMED' },
        occurred_at: timestamp,
      }],
      version: 2,
      confirmed_at: timestamp,
      cancelled_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const sameVenueId = new ObjectId(firstOwner.venueId);
    const makeBooking = (
      reference: string,
      overrides: Partial<BookingDocument>,
    ): BookingDocument => ({
      ...document,
      _id: new ObjectId(),
      contract_id: new ObjectId(),
      slot_id: new ObjectId(),
      external_booking_reference: reference,
      confirm_idempotency_key: `${reference}-confirm`,
      ...overrides,
    });
    const inclusiveBoundary = makeBooking('INTEGRATION-BOOKING-FROM', {
      venue_id: sameVenueId,
      starts_at: new Date('2026-08-01T00:00:00.000Z'),
      ends_at: new Date('2026-08-01T01:00:00.000Z'),
    });
    await database.db.collection<BookingDocument>('bookings').insertMany([
      document,
      inclusiveBoundary,
      makeBooking('INTEGRATION-BOOKING-TO', {
        venue_id: sameVenueId,
        starts_at: new Date('2026-08-02T00:00:00.000Z'),
        ends_at: new Date('2026-08-02T01:00:00.000Z'),
      }),
      makeBooking('INTEGRATION-BOOKING-COURT', {
        venue_id: sameVenueId,
        court_id: new ObjectId(),
      }),
      makeBooking('INTEGRATION-BOOKING-STATUS', {
        venue_id: sameVenueId,
        status: 'CONFIRMED',
      }),
    ]);
    const cancellation: BookingCancellationDocument = {
      _id: new ObjectId(),
      booking_id: bookingId,
      idempotency_key: 'integration-cancel-key',
      requested_by_type: 'PARTNER',
      requested_by_id: document.partner_id,
      reason_code: 'Customer changed plans',
      reason_text: null,
      refund_percent: 50,
      refund_amount_minor: 62_500,
      slot_disposition: 'RELEASE_TO_INVENTORY',
      cancelled_at: new Date('2026-07-30T08:00:00.000Z'),
      created_at: new Date('2026-07-30T08:00:00.000Z'),
    };
    await database.db
      .collection<BookingCancellationDocument>('booking_cancellations')
      .insertOne(cancellation);

    const list = await service.list({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
      courtId: courtId.toHexString(),
      status: 'CANCELLED',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(list.items.length, 2);
    assert.equal(list.pagination.total, 2);
    assert.equal(
      list.items[0]?.externalBookingReference,
      'INTEGRATION-BOOKING-FROM',
    );
    assert.equal(
      list.items[1]?.externalBookingReference,
      'INTEGRATION-BOOKING-1',
    );

    const secondPage = await service.list({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
      courtId: courtId.toHexString(),
      status: 'CANCELLED',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
      page: 2,
      limit: 1,
    });
    assert.equal(secondPage.pagination.total, 2);
    assert.equal(secondPage.pagination.pages, 2);
    assert.equal(
      secondPage.items[0]?.externalBookingReference,
      'INTEGRATION-BOOKING-1',
    );

    const detail = await service.getDetail({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
      bookingId: bookingId.toHexString(),
    });
    assert.equal(detail.cancellation?.refundAmountMinor, 62_500);

    await assert.rejects(
      database.db.collection<BookingDocument>('bookings').insertOne(
        makeBooking('INTEGRATION-BOOKING-INVALID-INTERVAL', {
          starts_at: new Date('2026-08-03T10:00:00.000Z'),
          ends_at: new Date('2026-08-03T10:00:00.000Z'),
        }),
      ),
      (error: unknown) =>
        error instanceof MongoServerError && error.code === 121,
    );

    await assert.rejects(
      service.getDetail({
        actorOwnerId: secondOwner.ownerId,
        venueId: firstOwner.venueId,
        bookingId: bookingId.toHexString(),
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PERMISSION_DENIED',
    );

    const indexNames = (
      await database.db.collection('bookings').indexes()
    ).map((index) => index.name);
    assert.ok(indexNames.includes('uq_booking_confirmation_idempotency'));
    assert.ok(indexNames.includes('ix_booking_owner_list'));
  } finally {
    if (databaseName.startsWith('turf_gds_owner_booking_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

function registrationInput(email: string, displayName: string) {
  return {
    legalName: `${displayName} Owner Private Limited`,
    email,
    phoneE164: '+919876543210',
    password: 'correct-horse-battery',
    venue: {
      legalName: `${displayName} Private Limited`,
      displayName,
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
    },
  };
}
