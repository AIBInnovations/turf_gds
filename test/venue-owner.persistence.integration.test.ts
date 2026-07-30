import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';

import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { createIdentityRepository } from '../src/modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import { createOwnerAccessRepository } from '../src/modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { createVenueOwnerService } from '../src/modules/venue/profile/venue-owner.service.js';
import { createVenueRepository } from '../src/modules/venue/profile/venue.repository.js';
import { createVenueService } from '../src/modules/venue/profile/venue.service.js';
import type { VenueDocument } from '../src/modules/venue/profile/venue.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { MediaStorage } from '../src/shared/media/cloudinary-media-storage.js';

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

test('Venue Owner profile persistence enforces isolation, versioning, audit, and media metadata', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }

  const databaseName =
    `turf_gds_venue_owner_it_${process.pid}_${Date.now()}`;
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
    const repository = createVenueRepository(database);
    const baseVenueService = createVenueService({ repository });
    const identityService = createIdentityService({
      repository: createIdentityRepository(database),
      venueService: baseVenueService,
      database,
      authConfig,
    });
    const firstOwner = await identityService.registerVenueOwner(
      registrationInput('venue-owner-a@example.com', 'Arena A'),
    );
    const secondOwner = await identityService.registerVenueOwner(
      registrationInput('venue-owner-b@example.com', 'Arena B'),
    );
    const ownerAccessService = createOwnerAccessService({
      identityService,
      repository: createOwnerAccessRepository(database),
    });
    const mediaStorage: MediaStorage = {
      async ping() {},
      async uploadBuffer() {
        return {
          publicId: 'integration/venues/arena-a/hero',
          resourceType: 'image',
          deliveryType: 'upload',
          format: 'jpg',
          bytes: 8,
          width: 100,
          height: 80,
          url: 'http://example.com/hero.jpg',
          secureUrl: 'https://example.com/hero.jpg',
          version: 1,
          checksum: 'venue-hero-checksum',
        };
      },
      async delete() {},
    };
    const service = createVenueOwnerService({
      repository,
      ownerAccessService,
      mediaStorage,
    });

    const initial = await service.getProfile({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
    });
    assert.equal(initial.version, 1);

    await assert.rejects(
      service.getProfile({
        actorOwnerId: secondOwner.ownerId,
        venueId: firstOwner.venueId,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PERMISSION_DENIED',
    );

    const updated = await service.updateProfile({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
      correlationId: 'integration-profile-update',
      expectedVersion: 1,
      displayName: 'Arena A Central',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    });
    assert.equal(updated.displayName, 'Arena A Central');
    assert.equal(updated.version, 2);

    await assert.rejects(
      service.updateProfile({
        actorOwnerId: firstOwner.ownerId,
        venueId: firstOwner.venueId,
        correlationId: 'integration-stale-update',
        expectedVersion: 1,
        displayName: 'Stale Arena Name',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'VENUE_VERSION_CONFLICT',
    );

    const withMedia = await service.addMedia({
      actorOwnerId: firstOwner.ownerId,
      venueId: firstOwner.venueId,
      correlationId: 'integration-media-add',
      expectedVersion: 2,
      filename: 'hero.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    });
    assert.equal(withMedia.media.length, 1);
    assert.equal(withMedia.version, 3);

    const stored = await database.db
      .collection<VenueDocument>('venues')
      .findOne({ _id: new ObjectId(firstOwner.venueId) });
    assert.equal(stored?.media[0]?.storage_key, 'integration/venues/arena-a/hero');
    assert.deepEqual(
      stored?.audit_history.map((event) => event.event_type),
      ['VENUE_PROFILE_UPDATED', 'VENUE_MEDIA_ADDED'],
    );
    assert.equal(stored?.version, 3);
  } finally {
    if (databaseName.startsWith('turf_gds_venue_owner_it_')) {
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
