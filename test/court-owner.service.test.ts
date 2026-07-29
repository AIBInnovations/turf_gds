import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { CourtRepository } from '../src/modules/venue/court.repository.js';
import { createCourtOwnerService } from '../src/modules/venue/court-owner.service.js';
import type { CourtDocument } from '../src/modules/venue/court.types.js';
import type { VenueRepository } from '../src/modules/venue/venue.repository.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { MediaStorage } from '../src/shared/media/cloudinary-media-storage.js';

const fixedNow = new Date('2026-07-28T11:00:00.000Z');
const ownerId = new ObjectId('687f00000000000000000080');
const venueId = new ObjectId('687f00000000000000000081');
const courtId = new ObjectId('687f00000000000000000082');

function venue(): VenueDocument {
  return {
    _id: venueId,
    legal_name: 'Green Arena Private Limited',
    display_name: 'Green Arena',
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
    created_at: fixedNow,
    updated_at: fixedNow,
  };
}

function court(): CourtDocument {
  return {
    _id: courtId,
    venue_id: venueId,
    name: 'Court One',
    sport_type: 'FOOTBALL',
    surface_type: 'ARTIFICIAL_TURF',
    capacity: 10,
    booking_mode: 'BOTH',
    min_booking_minutes: 60,
    booking_increment_minutes: 30,
    operating_hours: { entries: [] },
    fixed_slot_duration_minutes: null,
    fixed_slot_anchor_minutes: null,
    media: [],
    status: 'AVAILABLE',
    audit_history: [],
    version: 2,
    created_at: fixedNow,
    updated_at: fixedNow,
  };
}

function createFixture(options: {
  deny?: boolean;
  duplicate?: boolean;
  conflict?: boolean;
} = {}) {
  let storedCourt = court();
  let inserted: CourtDocument | undefined;
  let deletedMedia: string | undefined;
  const repository: CourtRepository = {
    async insert(value) {
      if (options.duplicate) {
        throw { code: 11_000 };
      }
      inserted = value;
    },
    async findByIdAndVenue(id, requestedVenueId) {
      return id.equals(courtId) && requestedVenueId.equals(venueId)
        ? storedCourt
        : null;
    },
    async listByVenue(requestedVenueId) {
      return requestedVenueId.equals(venueId) ? [storedCourt] : [];
    },
    async update(input) {
      if (options.conflict) {
        return null;
      }
      storedCourt = {
        ...storedCourt,
        ...input.changes,
        version: storedCourt.version + 1,
        updated_at: input.now,
      };
      return storedCourt;
    },
    async appendMedia(input) {
      if (options.conflict) {
        return null;
      }
      storedCourt = {
        ...storedCourt,
        media: [...storedCourt.media, input.media],
        version: storedCourt.version + 1,
      };
      return storedCourt;
    },
  };
  const venueRepository: VenueRepository = {
    async insertInitialVenue() {},
    async approveVenue() {
      return true;
    },
    async findById(id) {
      return id.equals(venueId) ? venue() : null;
    },
    async updateProfile() {
      return null;
    },
    async appendMedia() {
      return null;
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
    async requirePermission() {
      if (options.deny) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Denied',
          statusCode: 403,
        });
      }
    },
    async requireVenueMembership() {
      if (options.deny) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Denied',
          statusCode: 403,
        });
      }
      return { membershipId: new ObjectId().toHexString(), role: 'OWNER' };
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };
  const mediaStorage: MediaStorage = {
    async ping() {},
    async uploadBuffer() {
      return {
        publicId: 'courts/court-one/hero',
        resourceType: 'image',
        deliveryType: 'upload',
        format: 'jpg',
        bytes: 8,
        width: 100,
        height: 80,
        url: 'http://example.com/court.jpg',
        secureUrl: 'https://example.com/court.jpg',
        version: 1,
        checksum: 'court-checksum',
      };
    },
    async delete(publicId) {
      deletedMedia = publicId;
    },
  };
  const service = createCourtOwnerService({
    repository,
    venueRepository,
    ownerAccessService,
    mediaStorage,
    now: () => fixedNow,
  });
  return {
    service,
    getInserted: () => inserted,
    getStored: () => storedCourt,
    getDeletedMedia: () => deletedMedia,
  };
}

test('create Court stores the decided sport, surface, and capacity', async () => {
  const fixture = createFixture();

  const result = await fixture.service.create({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    correlationId: 'court-create',
    name: ' Court Two ',
    sportType: 'FOOTBALL',
    surfaceType: 'ARTIFICIAL_TURF',
    capacity: 10,
    bookingMode: 'BOTH',
    minBookingMinutes: 60,
    bookingIncrementMinutes: 30,
  });

  assert.equal(result.name, 'Court Two');
  assert.equal(result.sportType, 'FOOTBALL');
  assert.equal(result.surfaceType, 'ARTIFICIAL_TURF');
  assert.equal(result.capacity, 10);
  assert.equal(fixture.getInserted()?.audit_history[0]?.event_type, 'COURT_CREATED');
});

test('Court duration rules reject invalid minimums and increments', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.create({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'invalid-duration',
      name: 'Court Two',
      sportType: 'FOOTBALL',
      surfaceType: 'ARTIFICIAL_TURF',
      capacity: 10,
      bookingMode: 'OPEN_TIME',
      minBookingMinutes: 75,
      bookingIncrementMinutes: 30,
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_COURT_DURATION',
  );
});

test('duplicate Court names are mapped to a stable conflict', async () => {
  const fixture = createFixture({ duplicate: true });

  await assert.rejects(
    fixture.service.create({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'duplicate-court',
      name: 'Court One',
      sportType: 'FOOTBALL',
      surfaceType: 'ARTIFICIAL_TURF',
      capacity: 10,
      bookingMode: 'FIXED_SLOT',
      minBookingMinutes: 60,
      bookingIncrementMinutes: 30,
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COURT_NAME_ALREADY_EXISTS',
  );
});

test('Court updates use optimistic versioning and can deactivate a Court', async () => {
  const fixture = createFixture();
  const result = await fixture.service.update({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    correlationId: 'court-update',
    expectedVersion: 2,
    status: 'UNAVAILABLE',
    bookingMode: 'FIXED_SLOT',
  });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.bookingMode, 'FIXED_SLOT');
  assert.equal(result.version, 3);

  const conflicting = createFixture({ conflict: true });
  await assert.rejects(
    conflicting.service.update({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'stale-court',
      expectedVersion: 1,
      name: 'Stale Name',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COURT_VERSION_CONFLICT',
  );
});

test('operating hours are validated, sorted, and versioned', async () => {
  const fixture = createFixture();
  const result = await fixture.service.setOperatingHours({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    correlationId: 'court-hours',
    expectedVersion: 2,
    operatingHours: [
      { dayOfWeek: 7, opensAt: '08:00', closesAt: '20:00' },
      { dayOfWeek: 1, opensAt: '06:00', closesAt: '22:00' },
    ],
  });

  assert.deepEqual(result.operatingHours, [
    { dayOfWeek: 1, opensAt: '06:00', closesAt: '22:00' },
    { dayOfWeek: 7, opensAt: '08:00', closesAt: '20:00' },
  ]);
  assert.equal(result.version, 3);

  await assert.rejects(
    fixture.service.setOperatingHours({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'bad-hours',
      expectedVersion: 3,
      operatingHours: [
        { dayOfWeek: 1, opensAt: '20:00', closesAt: '08:00' },
      ],
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_OPERATING_HOURS',
  );
});

test('Court media cleanup runs when persistence conflicts', async () => {
  const fixture = createFixture({ conflict: true });

  await assert.rejects(
    fixture.service.addMedia({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'court-media',
      expectedVersion: 2,
      filename: 'hero.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COURT_VERSION_CONFLICT',
  );
  assert.equal(fixture.getDeletedMedia(), 'courts/court-one/hero');
});

test('cross-owner Court access is rejected before persistence mutation', async () => {
  const fixture = createFixture({ deny: true });

  await assert.rejects(
    fixture.service.update({
      actorOwnerId: new ObjectId().toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'cross-owner-court',
      expectedVersion: 2,
      name: 'Unauthorized',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
  assert.equal(fixture.getStored().name, 'Court One');
});
