import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { VenueRepository } from '../src/modules/venue/venue.repository.js';
import { createVenueOwnerService } from '../src/modules/venue/venue-owner.service.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { MediaStorage } from '../src/shared/media/cloudinary-media-storage.js';

const fixedNow = new Date('2026-07-28T10:00:00.000Z');
const ownerId = new ObjectId('687f00000000000000000060');
const venueId = new ObjectId('687f00000000000000000061');

function venueDocument(): VenueDocument {
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
    geo: { type: 'Point', coordinates: [77.5946, 12.9716] },
    currency: 'INR',
    media: [],
    status: 'ACTIVE',
    audit_history: [],
    version: 3,
    created_at: fixedNow,
    updated_at: fixedNow,
  };
}

function createFixture(options: {
  denyPermission?: boolean;
  updateConflict?: boolean;
  mediaConflict?: boolean;
} = {}) {
  let venue = venueDocument();
  let permissionRequest:
    | { ownerId: string; venueId: string; permission: string }
    | undefined;
  let deletedMedia: string | undefined;

  const repository: VenueRepository = {
    async insertInitialVenue() {},
    async approveVenue() {
      return true;
    },
    async findById(id) {
      return id.equals(venueId) ? venue : null;
    },
    async updateProfile(input) {
      if (
        options.updateConflict ||
        input.expectedVersion !== venue.version
      ) {
        return null;
      }
      venue = {
        ...venue,
        ...input.changes,
        version: venue.version + 1,
        updated_at: input.now,
      };
      return venue;
    },
    async appendMedia(input) {
      if (
        options.mediaConflict ||
        input.expectedVersion !== venue.version
      ) {
        return null;
      }
      venue = {
        ...venue,
        media: [...venue.media, input.media],
        version: venue.version + 1,
        updated_at: input.now,
      };
      return venue;
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
    async requirePermission(requestOwnerId, requestVenueId, permission) {
      permissionRequest = {
        ownerId: requestOwnerId,
        venueId: requestVenueId,
        permission,
      };
      if (options.denyPermission) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Permission denied',
          statusCode: 403,
        });
      }
    },
    async requireVenueMembership() {
      if (options.denyPermission) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Permission denied',
          statusCode: 403,
        });
      }
      return {
        membershipId: new ObjectId().toHexString(),
        role: 'OWNER',
      };
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
        publicId: 'venues/green-arena/hero',
        resourceType: 'image',
        deliveryType: 'upload',
        format: 'jpg',
        bytes: 8,
        width: 100,
        height: 80,
        url: 'http://example.com/hero.jpg',
        secureUrl: 'https://example.com/hero.jpg',
        version: 1,
        checksum: 'hero-checksum',
      };
    },
    async delete(publicId) {
      deletedMedia = publicId;
    },
  };
  const service = createVenueOwnerService({
    repository,
    ownerAccessService,
    mediaStorage,
    now: () => fixedNow,
  });

  return {
    service,
    getVenue: () => venue,
    getPermissionRequest: () => permissionRequest,
    getDeletedMedia: () => deletedMedia,
  };
}

test('getProfile returns a member-scoped venue view', async () => {
  const fixture = createFixture();

  const result = await fixture.service.getProfile({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
  });

  assert.equal(result.id, venueId.toHexString());
  assert.equal(result.latitude, 12.9716);
  assert.equal(result.longitude, 77.5946);
  assert.equal(result.version, 3);
});

test('updateProfile normalizes fields and requires MANAGE_VENUE', async () => {
  const fixture = createFixture();

  const result = await fixture.service.updateProfile({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    correlationId: 'request-venue-update',
    expectedVersion: 3,
    displayName: ' Green Arena Central ',
    timezone: 'Asia/Kolkata',
    latitude: 12.98,
    longitude: 77.61,
    currency: 'INR',
  });

  assert.deepEqual(fixture.getPermissionRequest(), {
    ownerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    permission: 'MANAGE_VENUE',
  });
  assert.equal(result.displayName, 'Green Arena Central');
  assert.equal(result.latitude, 12.98);
  assert.equal(result.longitude, 77.61);
  assert.equal(result.version, 4);
});

test('updateProfile rejects non-INR currency and incomplete coordinates', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.updateProfile({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'request-currency',
      expectedVersion: 3,
      displayName: 'Green Arena',
      currency: 'USD',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'UNSUPPORTED_CURRENCY',
  );
  await assert.rejects(
    fixture.service.updateProfile({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'request-coordinates',
      expectedVersion: 3,
      latitude: 12.98,
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'VENUE_COORDINATES_REQUIRED',
  );
});

test('updateProfile reports optimistic concurrency conflicts', async () => {
  const fixture = createFixture({ updateConflict: true });

  await assert.rejects(
    fixture.service.updateProfile({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'request-conflict',
      expectedVersion: 2,
      displayName: 'Stale Update',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'VENUE_VERSION_CONFLICT' &&
      error.details !== undefined,
  );
});

test('addMedia embeds public metadata and cleans up failed writes', async () => {
  const successful = createFixture();
  const result = await successful.service.addMedia({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    correlationId: 'request-media',
    expectedVersion: 3,
    filename: 'hero.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('document'),
  });

  assert.equal(result.media[0]?.storageKey, 'venues/green-arena/hero');
  assert.equal(result.version, 4);

  const conflicting = createFixture({ mediaConflict: true });
  await assert.rejects(
    conflicting.service.addMedia({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'request-media-conflict',
      expectedVersion: 3,
      filename: 'hero.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'VENUE_VERSION_CONFLICT',
  );
  assert.equal(
    conflicting.getDeletedMedia(),
    'venues/green-arena/hero',
  );
});

test('venue mutation is rejected when the actor lacks venue permission', async () => {
  const fixture = createFixture({ denyPermission: true });

  await assert.rejects(
    fixture.service.updateProfile({
      actorOwnerId: new ObjectId().toHexString(),
      venueId: venueId.toHexString(),
      correlationId: 'request-cross-owner',
      expectedVersion: 3,
      displayName: 'Unauthorized',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
  assert.equal(fixture.getVenue().display_name, 'Green Arena');
});
