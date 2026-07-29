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
