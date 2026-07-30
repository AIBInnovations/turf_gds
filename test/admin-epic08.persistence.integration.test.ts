import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import { createAdminEpic08Service } from '../src/modules/admin/epic08/admin-epic08.service.js';
import { initializeBookingPersistence } from '../src/modules/booking/booking.persistence.js';
import type { BookingDocument } from '../src/modules/booking/booking.types.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { createIdentityRepository } from '../src/modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import { initializeLedgerPersistence } from '../src/modules/ledger/ledger.persistence.js';
import { createLedgerRepository } from '../src/modules/ledger/ledger.repository.js';
import { createLedgerService } from '../src/modules/ledger/ledger.service.js';
import { createAdminVenueService } from '../src/modules/venue/admin-venue.service.js';
import { initializeInventoryPersistence } from '../src/modules/venue/inventory/inventory.persistence.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { createVenueRepository } from '../src/modules/venue/profile/venue.repository.js';
import { createVenueService } from '../src/modules/venue/profile/venue.service.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';

const authConfig: AppConfig['auth'] = {
  sessionTtlHours: 168, maxSessions: 5, maxLoginAttempts: 5, lockMinutes: 15,
  adminAccessTokenSecret: 'admin-epic08-secret-with-at-least-32-chars',
  adminAccessTokenTtlMinutes: 60,
  partnerCredentialMasterSecret: 'partner-epic08-secret-with-at-least-32-chars',
  partnerHmacMaxSkewSeconds: 300,
};

test('Epic 08 atomically creates venues and reports isolated stored financial data', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { context.skip('MONGODB_URI is not configured'); return; }
  const database = new MongoDatabaseConnection({
    uri, database: `turf_gds_admin08_${process.pid}_${Date.now()}`,
    serverSelectionTimeoutMs: 2_000, maxPoolSize: 4,
  });
  try {
    try { await database.connect(); } catch { context.skip('MongoDB integration server is unavailable'); return; }
    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeInventoryPersistence(database.db);
    await initializeBookingPersistence(database.db);
    await initializeLedgerPersistence(database.db);
    const venueService = createVenueService({ repository: createVenueRepository(database) });
    const identityService = createIdentityService({
      repository: createIdentityRepository(database), venueService, database, authConfig,
    });
    const owner = await identityService.registerVenueOwner({
      legalName: 'Admin Owner', email: 'admin-epic08-owner@example.com',
      phoneE164: '+919999990001', password: 'AdminOwnerPassword!123',
      venue: venueInput('Initial Venue'),
    });
    const venueAdmin = createAdminVenueService({ database, identityService, venueService });
    const service = createAdminEpic08Service({
      database, venues: venueAdmin, minimumCoverageDays: 7,
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });
    const created = await venueAdmin.createVenue({
      adminId: new ObjectId().toHexString(), ownerId: owner.ownerId,
      correlationId: 'admin-create-venue', environment: 'PRODUCTION',
      ...venueInput('Admin Created Venue'),
    }) as { venueId: string; membershipId: string; status: string };
    assert.equal(created.status, 'PENDING');
    assert.ok(created.membershipId);
    const beforeRollback = await database.db.collection('venues').countDocuments();
    await assert.rejects(() => venueAdmin.createVenue({
      adminId: new ObjectId().toHexString(), ownerId: new ObjectId().toHexString(),
      correlationId: 'rollback', environment: 'PRODUCTION',
      ...venueInput('Rolled Back Venue'),
    }));
    assert.equal(await database.db.collection('venues').countDocuments(), beforeRollback);

    const venueId = new ObjectId(created.venueId);
    const court = await venueAdmin.createCourt({
      adminId: new ObjectId().toHexString(), venueId: created.venueId,
      correlationId: 'create-court', name: 'Court One', sportType: 'BADMINTON',
      surfaceType: 'SYNTHETIC', capacity: 4, bookingMode: 'FIXED_SLOT',
      minBookingMinutes: 60, bookingIncrementMinutes: 30,
    }) as { courtId: string };
    const bookingId = new ObjectId();
    const partnerId = new ObjectId();
    const contractId = new ObjectId();
    const booking: BookingDocument = {
      _id: bookingId, slot_id: new ObjectId(), contract_id: contractId,
      partner_id: partnerId, venue_id: venueId, court_id: new ObjectId(court.courtId),
      environment: 'PRODUCTION', booking_type: 'FIXED_SLOT',
      starts_at: new Date('2026-07-15T10:00:00.000Z'),
      ends_at: new Date('2026-07-15T11:00:00.000Z'),
      external_booking_reference: 'EXT-08', confirm_idempotency_key: 'confirm-08',
      customer_reference: null, partner_payment_reference: null,
      status: 'CONFIRMED', gross_amount_minor: 10_000,
      commission_amount_minor: 1_000, tax_amount_minor: 180,
      venue_net_amount_minor: 8_820, currency: 'INR',
      cancellation_terms_snapshot: {}, confirmed_at: new Date('2026-07-15T09:00:00.000Z'),
      cancelled_at: null, audit_history: [], version: 1,
      created_at: new Date('2026-07-15T09:00:00.000Z'),
      updated_at: new Date('2026-07-15T09:00:00.000Z'),
    };
    await database.db.collection<BookingDocument>('bookings').insertOne(booking);
    const ledger = createLedgerService(createLedgerRepository(database));
    await database.withTransaction(async ({ session }) => {
      await ledger.postBooking({
        booking: {
          bookingId, partnerId, venueId, contractId, environment: 'PRODUCTION',
          grossAmountMinor: 10_000, commissionAmountMinor: 1_000,
          taxAmountMinor: 180, venueNetAmountMinor: 8_820,
        },
        effectiveAt: new Date('2026-07-15T09:00:00.000Z'),
        correlationId: 'ledger-08', session,
      });
    });
    const filter = {
      environment: 'PRODUCTION' as const,
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    };
    const bookings = await service.bookingReport(filter);
    assert.equal(bookings.total, 1);
    const revenue = await service.revenueReport(filter);
    assert.equal((revenue.totals as Record<string, number>).grossAmountMinor, 10_000);
    assert.equal((revenue.totals as Record<string, number>).venueNetAmountMinor, 8_820);
    const note = await service.addDisputeNote({
      bookingId: bookingId.toHexString(), environment: 'PRODUCTION',
      adminId: new ObjectId().toHexString(), expectedVersion: 1,
      correlationId: 'dispute-08', note: 'Reviewed evidence.',
    });
    assert.equal(note.version, 2);
    const health = await service.inventoryHealth({ venueId: created.venueId });
    assert.equal((health.items as Array<{ health: string }>)[0]?.health, 'DISABLED');
    const indexes = await database.db.collection('bookings').indexes();
    assert.ok(indexes.some(({ name }) => name === 'ix_booking_admin_venue_report'));
  } finally {
    try { await database.db.dropDatabase(); } catch {}
    await database.close();
  }
});

test('Epic 08 startup safely maps legacy Venue and Court statuses', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { context.skip('MONGODB_URI is not configured'); return; }
  const database = new MongoDatabaseConnection({
    uri, database: `turf_gds_admin08_migration_${process.pid}_${Date.now()}`,
    serverSelectionTimeoutMs: 2_000, maxPoolSize: 2,
  });
  try {
    try { await database.connect(); } catch { context.skip('MongoDB integration server is unavailable'); return; }
    const venueId = new ObjectId();
    const adminId = new ObjectId();
    await database.db.createCollection('venues');
    await database.db.createCollection('courts');
    await database.db.collection('venues').insertOne({
      _id: venueId, legal_name: 'Legacy Venue', display_name: 'Legacy Venue',
      environment: 'PRODUCTION', timezone: 'Asia/Kolkata',
      address: { line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001', country: 'IN' },
      geo: { type: 'Point', coordinates: [73.85, 18.52] }, currency: 'INR',
      media: [], status: 'PENDING_APPROVAL', audit_history: [], version: 1,
      approved_by: adminId, approved_at: new Date(),
      created_at: new Date(), updated_at: new Date(),
    });
    const court = (name: string, status: string) => ({
      _id: new ObjectId(), venue_id: venueId, name, sport_type: 'BADMINTON',
      surface_type: 'WOOD', capacity: 4, status, booking_mode: 'FIXED_SLOT',
      operating_hours: { entries: [] }, min_booking_minutes: 60,
      booking_increment_minutes: 30, fixed_slot_duration_minutes: 60,
      fixed_slot_anchor_minutes: 0, media: [], audit_history: [], version: 1,
      created_at: new Date(), updated_at: new Date(),
    });
    await database.db.collection('courts').insertMany([
      court('Legacy Active', 'ACTIVE'), court('Legacy Inactive', 'INACTIVE'),
    ]);
    await initializeVenuePersistence(database.db);
    const venue = await database.db.collection('venues').findOne({ _id: venueId });
    assert.equal(venue?.status, 'PENDING');
    assert.equal('approved_by' in venue!, false);
    assert.deepEqual(
      (await database.db.collection('courts').find().sort({ status: 1 }).toArray())
        .map(({ status }) => status),
      ['AVAILABLE', 'UNAVAILABLE'],
    );
  } finally {
    try { await database.db.dropDatabase(); } catch {}
    await database.close();
  }
});

function venueInput(displayName: string) {
  return {
    legalName: `${displayName} Pvt Ltd`, displayName, timezone: 'Asia/Kolkata',
    address: { line1: '1 Main Road', city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
    latitude: 18.52, longitude: 73.85,
  };
}
