import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
} from '../src/modules/booking/booking.types.js';
import type {
  OwnerBookingFilters,
  OwnerBookingRepository,
} from '../src/modules/booking/owner-booking.repository.js';
import { createOwnerBookingService } from '../src/modules/booking/owner-booking.service.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { CourtDocument } from '../src/modules/venue/courts/court.types.js';
import type { SlotDocument } from '../src/modules/venue/inventory/inventory.types.js';
import type { VenueDocument } from '../src/modules/venue/profile/venue.types.js';

const ownerId = new ObjectId('687f00000000000000000100');
const venueId = new ObjectId('687f00000000000000000101');
const otherVenueId = new ObjectId('687f00000000000000000102');
const courtId = new ObjectId('687f00000000000000000103');
const bookingId = new ObjectId('687f00000000000000000104');
const now = new Date('2026-07-29T08:00:00.000Z');

function booking(overrides: Partial<BookingDocument> = {}): BookingDocument {
  return {
    _id: bookingId,
    partner_id: new ObjectId('687f00000000000000000105'),
    venue_id: venueId,
    court_id: courtId,
    slot_id: new ObjectId('687f00000000000000000106'),
    contract_id: new ObjectId('687f00000000000000000107'),
    environment: 'PRODUCTION',
    external_booking_reference: 'PARTNER-BOOKING-42',
    confirm_idempotency_key: 'confirm-key',
    customer_reference: null,
    partner_payment_reference: null,
    booking_type: 'FIXED_SLOT',
    starts_at: new Date('2026-08-01T10:00:00.000Z'),
    ends_at: new Date('2026-08-01T11:00:00.000Z'),
    status: 'CONFIRMED',
    gross_amount_minor: 125_000,
    commission_amount_minor: 12_500,
    tax_amount_minor: 2_250,
    venue_net_amount_minor: 110_250,
    currency: 'INR',
    cancellation_terms_snapshot: { refundBps: 5_000 },
    audit_history: [],
    version: 1,
    confirmed_at: now,
    cancelled_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function cancellation(): BookingCancellationDocument {
  return {
    _id: new ObjectId('687f00000000000000000108'),
    booking_id: bookingId,
    idempotency_key: 'cancel-key',
    requested_by_type: 'PARTNER',
    requested_by_id: new ObjectId('687f00000000000000000105'),
    reason_code: 'Customer changed plans',
    reason_text: null,
    refund_percent: 50,
    refund_amount_minor: 62_500,
    slot_disposition: 'RELEASE_TO_INVENTORY',
    cancelled_at: new Date('2026-07-30T08:00:00.000Z'),
    created_at: new Date('2026-07-30T08:00:00.000Z'),
  };
}

function createFixture(options: {
  deny?: boolean;
  includeCancellation?: boolean;
  empty?: boolean;
} = {}) {
  const documents = options.empty ? [] : [
    booking(),
    booking({
      _id: new ObjectId('687f00000000000000000109'),
      venue_id: otherVenueId,
    }),
  ];
  let filters: OwnerBookingFilters | undefined;
  let permission:
    | { ownerId: string; venueId: string; permission: string }
    | undefined;

  const repository: OwnerBookingRepository = {
    async listForVenue(id, values) {
      filters = values;
      const results = documents.filter((item) => item.venue_id.equals(id));
      return { bookings: results, total: results.length };
    },
    async findForVenue(id, idBooking) {
      return documents.find(
        (item) => item.venue_id.equals(id) && item._id.equals(idBooking),
      ) ?? null;
    },
    async findCancellation(id) {
      return options.includeCancellation && id.equals(bookingId)
        ? cancellation()
        : null;
    },
    async findPayment() { return null; },
    async lockCourtForBooking() { return true; },
    async findOverlappingSlots() { return []; },
    async consumeFixedSlots() { return 0; },
    async insertDirectSlot() {},
    async insertDirectBooking() {},
    async findForVenueWithSession(id, idBooking) {
      return documents.find(
        (item) => item.venue_id.equals(id) && item._id.equals(idBooking),
      ) ?? null;
    },
    async cancelOwnerBooking() { return null; },
    async insertCancellation() {},
    async releaseDirectSlot() {},
  };
  const ownerAccessService: OwnerAccessService = {
    async authenticateOwner() {
      return {
        actorType: 'OWNER',
        ownerId: ownerId.toHexString(),
        status: 'ACTIVE',
      };
    },
    async logout() {},
    async getProfile() {
      throw new Error('not used');
    },
    async requirePermission(requestOwnerId, requestVenueId, value) {
      permission = {
        ownerId: requestOwnerId,
        venueId: requestVenueId,
        permission: value,
      };
      if (options.deny) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Permission denied',
          statusCode: 403,
        });
      }
    },
    async requireVenueMembership() {
      throw new Error('not used');
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };

  return {
    service: createOwnerBookingService({
      repository,
      ownerAccessService,
      database: { db: null, withTransaction: async () => {}, close: async () => {} } as never,
      outboxRepository: { async enqueue() {} },
    }),
    getFilters: () => filters,
    getPermission: () => permission,
  };
}

test('owner booking list requires VIEW_BOOKINGS and returns only the scoped venue', async () => {
  const fixture = createFixture();

  const result = await fixture.service.list({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
  });

  assert.deepEqual(fixture.getPermission(), {
    ownerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    permission: 'VIEW_BOOKINGS',
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.venueId, venueId.toHexString());
  assert.equal(
    result.items[0]?.externalBookingReference,
    'PARTNER-BOOKING-42',
  );
  assert.deepEqual(result.pagination, {
    page: 1,
    limit: 50,
    total: 1,
    pages: 1,
  });
});

test('owner booking filters are normalized for persistence', async () => {
  const fixture = createFixture();

  await fixture.service.list({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    status: 'CONFIRMED',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-02T00:00:00.000Z',
    page: 2,
    limit: 20,
  });

  const filters = fixture.getFilters();
  assert.equal(filters?.courtId?.toHexString(), courtId.toHexString());
  assert.equal(filters?.status, 'CONFIRMED');
  assert.equal(filters?.from?.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(filters?.to?.toISOString(), '2026-08-02T00:00:00.000Z');
  assert.equal(filters?.page, 2);
  assert.equal(filters?.limit, 20);
});

test('owner booking detail includes external reference and cancellation outcome', async () => {
  const fixture = createFixture({ includeCancellation: true });

  const result = await fixture.service.getDetail({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    bookingId: bookingId.toHexString(),
  });

  assert.equal(result.externalBookingReference, 'PARTNER-BOOKING-42');
  assert.equal(result.cancellation?.refundAmountMinor, 62_500);
  assert.equal(
    result.cancellation?.slotDisposition,
    'RELEASE_TO_INVENTORY',
  );
  assert.equal(
    Object.hasOwn(result, 'confirmIdempotencyKey'),
    false,
  );
});

test('owner booking access is isolated before any booking lookup', async () => {
  const fixture = createFixture({ deny: true });

  await assert.rejects(
    fixture.service.getDetail({
      actorOwnerId: new ObjectId().toHexString(),
      venueId: venueId.toHexString(),
      bookingId: bookingId.toHexString(),
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
});

test('owner booking list rejects reversed date filters', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.list({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      from: '2026-08-02T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_BOOKING_DATE_RANGE',
  );
});

test('owner booking list validates pagination at the service boundary', async () => {
  const fixture = createFixture();

  for (const pagination of [
    { page: 0 },
    { page: 1.5 },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ]) {
    await assert.rejects(
      fixture.service.list({
        actorOwnerId: ownerId.toHexString(),
        venueId: venueId.toHexString(),
        ...pagination,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        ['INVALID_BOOKING_PAGE', 'INVALID_BOOKING_LIMIT'].includes(
          error.code,
        ),
    );
  }
});

test('owner booking list returns stable empty pagination metadata', async () => {
  const fixture = createFixture({ empty: true });

  const result = await fixture.service.list({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
  });

  assert.deepEqual(result, {
    items: [],
    pagination: {
      page: 1,
      limit: 50,
      total: 0,
      pages: 0,
    },
  });
});

test('confirmed booking detail returns a null cancellation', async () => {
  const fixture = createFixture();

  const result = await fixture.service.getDetail({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    bookingId: bookingId.toHexString(),
  });

  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.cancellation, null);
});

test('booking detail never crosses the requested venue boundary', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.getDetail({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      bookingId: '687f00000000000000000109',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'BOOKING_NOT_FOUND',
  );
});

function venue(overrides: Partial<VenueDocument> = {}): VenueDocument {
  return {
    _id: venueId,
    legal_name: 'Test Venue Pvt Ltd',
    display_name: 'Test Venue',
    environment: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    address: {} as VenueDocument['address'],
    geo: { type: 'Point', coordinates: [0, 0] },
    currency: 'INR',
    media: [],
    status: 'ACTIVE',
    audit_history: [],
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function court(overrides: Partial<CourtDocument> = {}): CourtDocument {
  return {
    _id: courtId,
    venue_id: venueId,
    name: 'Court 1',
    sport_type: 'FOOTBALL',
    surface_type: 'TURF',
    capacity: 10,
    status: 'AVAILABLE',
    booking_mode: 'OPEN_TIME',
    operating_hours: { entries: [] },
    min_booking_minutes: 60,
    booking_increment_minutes: 30,
    fixed_slot_duration_minutes: null,
    fixed_slot_anchor_minutes: null,
    media: [],
    audit_history: [],
    version: 3,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function slot(overrides: Partial<SlotDocument> = {}): SlotDocument {
  return {
    _id: new ObjectId(),
    court_id: courtId,
    venue_id: venueId,
    environment: 'PRODUCTION',
    booking_type: 'OPEN_TIME',
    starts_at: new Date('2026-08-01T10:00:00.000Z'),
    ends_at: new Date('2026-08-01T11:00:00.000Z'),
    price_minor: null,
    currency: 'INR',
    status: 'BOOKED',
    hold_id: null,
    hold_partner_id: null,
    hold_expires_at: null,
    hold_created_at: null,
    source: 'BOOKING',
    booking_id: null,
    consumed_by_slot_id: null,
    audit_history: [],
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createDirectBookingFixture(options: {
  courtOverrides?: Partial<CourtDocument>;
  venueOverrides?: Partial<VenueDocument>;
  lockSucceeds?: boolean;
  overlappingSlots?: SlotDocument[];
} = {}) {
  const venueDoc = venue(options.venueOverrides);
  const courtDoc = court(options.courtOverrides);
  const lockCalls: unknown[] = [];
  const insertedSlots: unknown[] = [];
  const consumeCalls: Array<{
    consumerSlotId: ObjectId;
    fixedSlotIds: readonly ObjectId[];
  }> = [];

  const repository: OwnerBookingRepository = {
    async listForVenue() { return { bookings: [], total: 0 }; },
    async findForVenue() { return null; },
    async findCancellation() { return null; },
    async findPayment() { return null; },
    async lockCourtForBooking(input) {
      lockCalls.push(input);
      return options.lockSucceeds ?? true;
    },
    async findOverlappingSlots() { return options.overlappingSlots ?? []; },
    async consumeFixedSlots(values) {
      consumeCalls.push(values);
      return values.fixedSlotIds.length;
    },
    async insertDirectSlot(slot) { insertedSlots.push(slot); },
    async insertDirectBooking() {},
    async findForVenueWithSession() { return null; },
    async cancelOwnerBooking() { return null; },
    async insertCancellation() {},
    async releaseDirectSlot() {},
  };

  const ownerAccessService: OwnerAccessService = {
    async authenticateOwner() {
      return { actorType: 'OWNER', ownerId: ownerId.toHexString(), status: 'ACTIVE' };
    },
    async logout() {},
    async getProfile() { throw new Error('not used'); },
    async requirePermission() {},
    async requireVenueMembership() { throw new Error('not used'); },
    async listMembers() { return []; },
    async addMember() { throw new Error('not used'); },
    async revokeMember() {},
  };

  const fakeDb = {
    collection(name: string) {
      if (name === 'venues') {
        return { findOne: async () => venueDoc };
      }
      if (name === 'courts') {
        return { findOne: async () => courtDoc };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  const database = {
    db: fakeDb as never,
    async withTransaction(operation: (context: { session: unknown }) => Promise<unknown>) {
      return operation({ session: {} });
    },
    async close() {},
  };

  return {
    service: createOwnerBookingService({
      repository,
      ownerAccessService,
      database: database as never,
      outboxRepository: { async enqueue() {} },
    }),
    getLockCalls: () => lockCalls,
    getInsertedSlots: () => insertedSlots,
    getConsumeCalls: () => consumeCalls,
  };
}

test('createDirectBooking rejects FIXED_SLOT-only courts', async () => {
  const fixture = createDirectBookingFixture({
    courtOverrides: { booking_mode: 'FIXED_SLOT' },
  });

  await assert.rejects(
    fixture.service.createDirectBooking({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      startsAt: '2026-08-01T10:00:00.000Z',
      endsAt: '2026-08-01T11:00:00.000Z',
      correlationId: 'corr-1',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COURT_BOOKING_MODE_NOT_ALLOWED',
  );
});

test('createDirectBooking throws COURT_VERSION_CONFLICT when the court lock fails', async () => {
  const fixture = createDirectBookingFixture({ lockSucceeds: false });

  await assert.rejects(
    fixture.service.createDirectBooking({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      startsAt: '2026-08-01T10:00:00.000Z',
      endsAt: '2026-08-01T11:00:00.000Z',
      correlationId: 'corr-2',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COURT_VERSION_CONFLICT',
  );
});

test('createDirectBooking succeeds for OPEN_TIME/BOTH courts and inserts a matching slot via the lock', async () => {
  const fixture = createDirectBookingFixture({
    courtOverrides: { booking_mode: 'BOTH', version: 7 },
  });

  const result = await fixture.service.createDirectBooking({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    startsAt: '2026-08-01T10:00:00.000Z',
    endsAt: '2026-08-01T11:00:00.000Z',
    correlationId: 'corr-3',
  });

  assert.equal(result.bookingType, 'DIRECT');
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(fixture.getLockCalls().length, 1);
  const lockCall = fixture.getLockCalls()[0] as {
    courtId: ObjectId;
    venueId: ObjectId;
    expectedVersion: number;
    now: Date;
  };
  assert.equal(lockCall.courtId.equals(courtId), true);
  assert.equal(lockCall.venueId.equals(venueId), true);
  assert.equal(lockCall.expectedVersion, 7);
  assert.equal(lockCall.now instanceof Date, true);
  assert.equal(fixture.getInsertedSlots().length, 1);
  const insertedSlot = fixture.getInsertedSlots()[0] as { starts_at: Date; ends_at: Date };
  assert.equal(insertedSlot.starts_at.toISOString(), '2026-08-01T10:00:00.000Z');
  assert.equal(insertedSlot.ends_at.toISOString(), '2026-08-01T11:00:00.000Z');
});

test('createDirectBooking rejects overlapping intervals reported by the repository', async () => {
  const fixture = createDirectBookingFixture({
    overlappingSlots: [slot({ status: 'BOOKED' })],
  });

  await assert.rejects(
    fixture.service.createDirectBooking({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      startsAt: '2026-08-01T10:00:00.000Z',
      endsAt: '2026-08-01T11:00:00.000Z',
      correlationId: 'corr-4',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVENTORY_OVERLAP',
  );
});

test('createDirectBooking consumes an overlapping available fixed slot instead of being blocked by it', async () => {
  const fixedSlot = slot({
    booking_type: 'FIXED_SLOT',
    status: 'AVAILABLE',
    source: 'SYSTEM_GENERATED',
  });
  const fixture = createDirectBookingFixture({ overlappingSlots: [fixedSlot] });

  const result = await fixture.service.createDirectBooking({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    startsAt: '2026-08-01T10:00:00.000Z',
    endsAt: '2026-08-01T11:00:00.000Z',
    correlationId: 'corr-5',
  }) as { status: string };

  assert.equal(result.status, 'CONFIRMED');
  const inserted = fixture.getInsertedSlots()[0] as { _id: ObjectId };
  const consume = fixture.getConsumeCalls()[0];
  assert.equal(fixture.getConsumeCalls().length, 1);
  assert.equal(
    consume?.fixedSlotIds.map((value) => value.toHexString()).join(),
    fixedSlot._id.toHexString(),
  );
  // The consumer must be the open-time slot this booking just created,
  // otherwise the restore on cancellation would never find these slots.
  assert.equal(
    consume?.consumerSlotId.toHexString(),
    inserted._id.toHexString(),
  );
});

test('createDirectBooking rejects an overlapping fixed slot that is already booked', async () => {
  const fixture = createDirectBookingFixture({
    overlappingSlots: [
      slot({ booking_type: 'FIXED_SLOT', status: 'BOOKED', source: 'SYSTEM_GENERATED' }),
    ],
  });

  await assert.rejects(
    fixture.service.createDirectBooking({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      startsAt: '2026-08-01T10:00:00.000Z',
      endsAt: '2026-08-01T11:00:00.000Z',
      correlationId: 'corr-6',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVENTORY_OVERLAP',
  );
});
