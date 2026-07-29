import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import { createBookingLifecycleRepository } from '../src/modules/booking/booking-lifecycle.repository.js';
import { createBookingLifecycleService } from '../src/modules/booking/booking-lifecycle.service.js';
import { initializeBookingPersistence } from '../src/modules/booking/booking.persistence.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
} from '../src/modules/booking/booking.types.js';
import { initializeOutboxPersistence } from '../src/shared/communications/outbox.persistence.js';
import { createOutboxRepository } from '../src/shared/communications/outbox.repository.js';
import { initializeContractPersistence } from '../src/modules/contracts/contract.persistence.js';
import type { PartnerVenueContractDocument } from '../src/modules/contracts/contract.types.js';
import type { PartnerDocument } from '../src/modules/identity/partner/partner-access.types.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { initializeLedgerPersistence } from '../src/modules/ledger/ledger.persistence.js';
import { createLedgerRepository } from '../src/modules/ledger/ledger.repository.js';
import type { CourtDocument } from '../src/modules/venue/court.types.js';
import { initializeInventoryPersistence } from '../src/modules/venue/inventory.persistence.js';
import type {
  PricingRuleDocument,
  SlotDocument,
} from '../src/modules/venue/inventory.types.js';
import { initializeVenuePersistence } from '../src/modules/venue/venue.persistence.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('Booking lifecycle atomically holds, confirms, snapshots, cancels, audits, and replays', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_booking_lifecycle_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 4,
  });
  let clock = new Date('2026-08-03T02:30:00.000Z');

  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeInventoryPersistence(database.db);
    await initializeContractPersistence(database.db);
    await initializeBookingPersistence(database.db);
    await initializeLedgerPersistence(database.db);
    await initializeOutboxPersistence(database.db);

    const ids = await seed(database, clock);
    const service = createBookingLifecycleService({
      repository: createBookingLifecycleRepository(database),
      ledgerRepository: createLedgerRepository(database),
      outboxRepository: createOutboxRepository(database),
      database,
      now: () => clock,
      holdTtlMs: 10 * 60_000,
    });

    const hold = await service.hold({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      bookingType: 'FIXED_SLOT',
      slotId: ids.fixedSlotId.toHexString(),
      correlationId: 'fixed-hold',
    });
    assert.equal(hold.priceMinor, 10_000);
    assert.equal(hold.bookingType, 'FIXED_SLOT');

    await assert.rejects(
      service.hold({
        partnerId: ids.partnerId.toHexString(),
        environment: 'PRODUCTION',
        bookingType: 'FIXED_SLOT',
        slotId: ids.fixedSlotId.toHexString(),
        correlationId: 'duplicate-hold',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'SLOT_NOT_AVAILABLE',
    );

    const confirmed = await service.confirm({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      holdId: hold.holdId,
      idempotencyKey: 'confirm-001',
      externalBookingReference: 'partner-booking-001',
      customerReference: 'customer-001',
      partnerPaymentReference: 'payment-001',
      correlationId: 'confirm',
    });
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(confirmed.grossAmountMinor, 10_000);
    assert.equal(confirmed.commissionAmountMinor, 1_000);
    assert.equal(confirmed.taxAmountMinor, 500);
    assert.equal(confirmed.venueNetAmountMinor, 8_500);

    const replay = await service.confirm({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      holdId: hold.holdId,
      idempotencyKey: 'confirm-001',
      externalBookingReference: 'partner-booking-001',
      customerReference: 'customer-001',
      partnerPaymentReference: 'payment-001',
      correlationId: 'confirm-replay',
    });
    assert.deepEqual(replay, confirmed);
    await assert.rejects(
      service.confirm({
        partnerId: ids.partnerId.toHexString(),
        environment: 'PRODUCTION',
        holdId: hold.holdId,
        idempotencyKey: 'confirm-001',
        externalBookingReference: 'different-reference',
        correlationId: 'confirm-key-reuse',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'IDEMPOTENCY_KEY_REUSED',
    );

    const bookingId = new ObjectId(confirmed.bookingId as string);
    const booking = await database.db
      .collection<BookingDocument>('bookings')
      .findOne({ _id: bookingId });
    assert.equal(booking?.contract_id.equals(ids.contractId), true);
    assert.equal(booking?.audit_history.length, 1);
    const confirmationLedger = await database.db
      .collection('ledger_entries')
      .find({ booking_id: bookingId })
      .toArray();
    assert.equal(confirmationLedger.length, 4);
    assertBalanced(confirmationLedger);
    assert.equal(
      await database.db.collection('outbox_events').countDocuments({
        aggregate_id: bookingId,
        event_type: 'BOOKING_CONFIRMED',
      }),
      1,
    );

    clock = new Date('2026-08-03T03:00:00.000Z');
    const cancelled = await service.cancel({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      bookingId: bookingId.toHexString(),
      idempotencyKey: 'cancel-001',
      reasonCode: 'CUSTOMER_REQUEST',
      reasonText: 'Customer changed plans',
      correlationId: 'cancel',
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.refundPercent, 100);
    assert.equal(cancelled.refundAmountMinor, 10_000);
    assert.equal(cancelled.slotDisposition, 'RELEASE_TO_INVENTORY');

    const cancellationReplay = await service.cancel({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      bookingId: bookingId.toHexString(),
      idempotencyKey: 'cancel-001',
      reasonCode: 'CUSTOMER_REQUEST',
      reasonText: 'Customer changed plans',
      correlationId: 'cancel-replay',
    });
    assert.deepEqual(cancellationReplay, cancelled);
    const cancellation = await database.db
      .collection<BookingCancellationDocument>('booking_cancellations')
      .findOne({ booking_id: bookingId });
    assert.equal(cancellation?.requested_by_id?.equals(ids.partnerId), true);
    assert.equal(cancellation?.refund_percent, 100);
    const released = await database.db
      .collection<SlotDocument>('slots')
      .findOne({ _id: ids.fixedSlotId });
    assert.equal(released?.status, 'AVAILABLE');
    assert.equal(released?.booking_id, null);
    const allLedger = await database.db
      .collection('ledger_entries')
      .find({ booking_id: bookingId })
      .toArray();
    assert.equal(allLedger.length, 8);
    assertBalanced(allLedger.slice(4));
    const audit = await service.getAudit({ bookingId: bookingId.toHexString() });
    assert.equal((audit.auditHistory as unknown[]).length, 2);
    assert.equal(
      await database.db.collection('outbox_events').countDocuments({
        aggregate_id: bookingId,
      }),
      2,
    );

    const raceHold = await service.hold({
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION',
      bookingType: 'FIXED_SLOT',
      slotId: ids.fixedSlotId.toHexString(),
      correlationId: 'race-hold',
    });
    const confirmationRace = await Promise.allSettled([
      service.confirm({
        partnerId: ids.partnerId.toHexString(),
        environment: 'PRODUCTION',
        holdId: raceHold.holdId,
        idempotencyKey: 'race-confirm-a',
        externalBookingReference: 'race-a',
        correlationId: 'race-confirm-a',
      }),
      service.confirm({
        partnerId: ids.partnerId.toHexString(),
        environment: 'PRODUCTION',
        holdId: raceHold.holdId,
        idempotencyKey: 'race-confirm-b',
        externalBookingReference: 'race-b',
        correlationId: 'race-confirm-b',
      }),
    ]);
    assert.equal(
      confirmationRace.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    assert.equal(
      confirmationRace.filter(({ status }) => status === 'rejected').length,
      1,
    );
  } finally {
    if (databaseName.startsWith('turf_gds_booking_lifecycle_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

test('open-time holds enforce hours, duration, overlap, environment, and expiry recovery', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_open_hold_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 4,
  });
  let clock = new Date('2026-08-03T02:30:00.000Z');
  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeInventoryPersistence(database.db);
    await initializeContractPersistence(database.db);
    await initializeBookingPersistence(database.db);
    await initializeLedgerPersistence(database.db);
    await initializeOutboxPersistence(database.db);
    const ids = await seed(database, clock);
    const service = createBookingLifecycleService({
      repository: createBookingLifecycleRepository(database),
      ledgerRepository: createLedgerRepository(database),
      outboxRepository: createOutboxRepository(database),
      database,
      now: () => clock,
      holdTtlMs: 10 * 60_000,
    });
    const base = {
      partnerId: ids.partnerId.toHexString(),
      environment: 'PRODUCTION' as const,
      bookingType: 'OPEN_TIME' as const,
      venueId: ids.venueId.toHexString(),
      courtId: ids.courtId.toHexString(),
    };
    await assert.rejects(
      service.hold({
        ...base,
        startsAt: '2026-08-03T04:30:00.000Z',
        endsAt: '2026-08-03T05:00:00.000Z',
        correlationId: 'too-short',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_BOOKING_DURATION',
    );
    await assert.rejects(
      service.hold({
        ...base,
        startsAt: '2026-08-03T14:30:00.000Z',
        endsAt: '2026-08-03T15:30:00.000Z',
        correlationId: 'outside-hours',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'OUTSIDE_OPERATING_HOURS',
    );
    const hold = await service.hold({
      ...base,
      startsAt: '2026-08-03T04:30:00.000Z',
      endsAt: '2026-08-03T05:30:00.000Z',
      correlationId: 'open-hold',
    });
    assert.equal(hold.priceMinor, 2_000);
    await assert.rejects(
      service.hold({
        ...base,
        startsAt: '2026-08-03T05:00:00.000Z',
        endsAt: '2026-08-03T06:00:00.000Z',
        correlationId: 'overlap',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'INVENTORY_OVERLAP',
    );
    await assert.rejects(
      service.hold({
        ...base,
        environment: 'SANDBOX',
        startsAt: '2026-08-03T06:00:00.000Z',
        endsAt: '2026-08-03T07:00:00.000Z',
        correlationId: 'wrong-env',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'ENVIRONMENT_MISMATCH',
    );
    clock = new Date('2026-08-03T02:41:00.000Z');
    const recovered = await service.recoverExpiredHolds();
    assert.equal(recovered.openReleased, 1);
    assert.equal(
      await database.db.collection('slots').countDocuments({
        hold_id: hold.holdId,
      }),
      0,
    );

    const openRace = await Promise.allSettled([
      service.hold({
        ...base,
        startsAt: '2026-08-03T04:30:00.000Z',
        endsAt: '2026-08-03T05:30:00.000Z',
        correlationId: 'open-race-a',
      }),
      service.hold({
        ...base,
        startsAt: '2026-08-03T04:30:00.000Z',
        endsAt: '2026-08-03T05:30:00.000Z',
        correlationId: 'open-race-b',
      }),
    ]);
    assert.equal(
      openRace.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    assert.equal(
      openRace.filter(({ status }) => status === 'rejected').length,
      1,
    );
  } finally {
    if (databaseName.startsWith('turf_gds_open_hold_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

async function seed(
  database: MongoDatabaseConnection,
  now: Date,
): Promise<{
  partnerId: ObjectId;
  venueId: ObjectId;
  courtId: ObjectId;
  fixedSlotId: ObjectId;
  contractId: ObjectId;
}> {
  const partnerId = new ObjectId();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  const fixedSlotId = new ObjectId();
  const contractId = new ObjectId();
  await database.db.collection<PartnerDocument>('partners').insertOne({
    _id: partnerId,
    legal_name: 'Booking Lifecycle Partner Private Limited',
    display_name: 'Booking Lifecycle Partner',
    kyc_status: 'VERIFIED',
    status: 'ACTIVE',
    rate_limit_tier: 'STANDARD',
    sandbox_approved_at: now,
    production_approved_by: new ObjectId(),
    production_approved_at: now,
    audit_history: [],
    created_at: now,
    updated_at: now,
  });
  await database.db.collection<VenueDocument>('venues').insertOne({
    _id: venueId,
    legal_name: 'Booking Lifecycle Venue Private Limited',
    display_name: 'Booking Lifecycle Venue',
    environment: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    address: {
      line1: 'MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560001',
      country: 'IN',
    },
    geo: { type: 'Point', coordinates: [77.59, 12.97] },
    currency: 'INR',
    media: [],
    status: 'ACTIVE',
    audit_history: [],
    version: 1,
    created_at: now,
    updated_at: now,
  });
  await database.db.collection<CourtDocument>('courts').insertOne({
    _id: courtId,
    venue_id: venueId,
    name: 'Lifecycle Court',
    sport_type: 'FOOTBALL',
    surface_type: 'ARTIFICIAL_TURF',
    capacity: 10,
    status: 'AVAILABLE',
    booking_mode: 'BOTH',
    operating_hours: {
      entries: [{ day_of_week: 1, opens_at: '08:00', closes_at: '20:00' }],
    },
    min_booking_minutes: 60,
    booking_increment_minutes: 30,
    fixed_slot_duration_minutes: 60,
    fixed_slot_anchor_minutes: 0,
    media: [],
    audit_history: [],
    version: 1,
    created_at: now,
    updated_at: now,
  });
  await database.db
    .collection<PartnerVenueContractDocument>('partner_venue_contracts')
    .insertOne({
      _id: contractId,
      partner_id: partnerId,
      venue_id: venueId,
      status: 'ACTIVE',
      settlement_cycle: 'T_PLUS_N',
      settlement_lag_days: 2,
      commission_rate_bps: 1_000,
      tax_rate_bps: 500,
      allowed_booking_modes: 'BOTH',
      cancellation_terms: {
        cancellation_allowed: true,
        default_refund_bps: 5_000,
        release_inventory: true,
      },
      resale_cutoff_minutes: 30,
      refund_rules: {
        rules: [{
          min_minutes_before_start: 60,
          refund_bps: 10_000,
          release_inventory: true,
        }],
      },
      terms_version: 1,
      effective_from: new Date('2026-08-01T00:00:00.000Z'),
      effective_to: null,
      audit_history: [],
      created_at: now,
      updated_at: now,
    });
  await database.db.collection<PricingRuleDocument>('pricing_rules').insertOne({
    _id: new ObjectId(),
    court_id: courtId,
    name: 'Standard hourly price',
    day_of_week: null,
    start_time: null,
    end_time: null,
    price_minor: 2_000,
    currency: 'INR',
    effective_from: new Date('2026-08-01T00:00:00.000Z'),
    effective_to: null,
    priority: 1,
    active: true,
    created_at: now,
    updated_at: now,
  });
  await database.db.collection<SlotDocument>('slots').insertOne({
    _id: fixedSlotId,
    court_id: courtId,
    venue_id: venueId,
    environment: 'PRODUCTION',
    booking_type: 'FIXED_SLOT',
    starts_at: new Date('2026-08-03T04:30:00.000Z'),
    ends_at: new Date('2026-08-03T05:30:00.000Z'),
    price_minor: 10_000,
    currency: 'INR',
    status: 'AVAILABLE',
    hold_id: null,
    hold_partner_id: null,
    hold_expires_at: null,
    hold_created_at: null,
    source: 'SYSTEM_GENERATED',
    booking_id: null,
    audit_history: [],
    version: 1,
    created_at: now,
    updated_at: now,
  });
  return { partnerId, venueId, courtId, fixedSlotId, contractId };
}

function assertBalanced(entries: Array<Record<string, unknown>>): void {
  const debit = entries
    .filter(({ direction }) => direction === 'DEBIT')
    .reduce((sum, entry) => sum + Number(entry.amount_minor), 0);
  const credit = entries
    .filter(({ direction }) => direction === 'CREDIT')
    .reduce((sum, entry) => sum + Number(entry.amount_minor), 0);
  assert.equal(debit, credit);
}
