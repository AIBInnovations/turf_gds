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
import { createCourtOwnerService } from '../src/modules/venue/court-owner.service.js';
import { createCourtRepository } from '../src/modules/venue/court.repository.js';
import type { CourtDocument } from '../src/modules/venue/court.types.js';
import { initializeVenuePersistence } from '../src/modules/venue/venue.persistence.js';
import { createVenueRepository } from '../src/modules/venue/venue.repository.js';
import { createVenueService } from '../src/modules/venue/venue.service.js';
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

test('Court persistence enforces venue isolation, unique names, versions, status, audit, and media', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_court_it_${process.pid}_${Date.now()}`;
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
    const venueRepository = createVenueRepository(database);
    const identityService = createIdentityService({
      repository: createIdentityRepository(database),
      venueService: createVenueService({ repository: venueRepository }),
      database,
      authConfig,
    });
    const first = await identityService.registerVenueOwner(
      registrationInput('court-owner-a@example.com', 'Arena A'),
    );
    const second = await identityService.registerVenueOwner(
      registrationInput('court-owner-b@example.com', 'Arena B'),
    );
    const ownerAccessService = createOwnerAccessService({
      identityService,
      repository: createOwnerAccessRepository(database),
    });
    const mediaStorage: MediaStorage = {
      async ping() {},
      async uploadBuffer() {
        return {
          publicId: 'integration/courts/alpha/hero',
          resourceType: 'image',
          deliveryType: 'upload',
          format: 'jpg',
          bytes: 8,
          width: 100,
          height: 80,
          url: 'http://example.com/court.jpg',
          secureUrl: 'https://example.com/court.jpg',
          version: 1,
          checksum: 'court-integration-checksum',
        };
      },
      async delete() {},
    };
    const service = createCourtOwnerService({
      repository: createCourtRepository(database),
      venueRepository,
      ownerAccessService,
      mediaStorage,
    });
    const created = await service.create({
      actorOwnerId: first.ownerId,
      venueId: first.venueId,
      correlationId: 'court-create-integration',
      name: 'Court Alpha',
      sportTypes: ['football'],
      bookingMode: 'BOTH',
      minBookingMinutes: 60,
      bookingIncrementMinutes: 30,
    });
    assert.equal(created.version, 1);

    await assert.rejects(
      service.create({
        actorOwnerId: first.ownerId,
        venueId: first.venueId,
        correlationId: 'court-duplicate-integration',
        name: 'court alpha',
        sportTypes: ['CRICKET'],
        bookingMode: 'FIXED_SLOT',
        minBookingMinutes: 60,
        bookingIncrementMinutes: 30,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COURT_NAME_ALREADY_EXISTS',
    );
    await assert.rejects(
      service.get({
        actorOwnerId: second.ownerId,
        venueId: first.venueId,
        courtId: created.id,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PERMISSION_DENIED',
    );

    const updated = await service.update({
      actorOwnerId: first.ownerId,
      venueId: first.venueId,
      courtId: created.id,
      correlationId: 'court-update-integration',
      expectedVersion: 1,
      status: 'INACTIVE',
    });
    assert.equal(updated.status, 'INACTIVE');
    assert.equal(updated.version, 2);

    await assert.rejects(
      service.update({
        actorOwnerId: first.ownerId,
        venueId: first.venueId,
        courtId: created.id,
        correlationId: 'court-stale-integration',
        expectedVersion: 1,
        name: 'Stale Court',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COURT_VERSION_CONFLICT',
    );

    const withMedia = await service.addMedia({
      actorOwnerId: first.ownerId,
      venueId: first.venueId,
      courtId: created.id,
      correlationId: 'court-media-integration',
      expectedVersion: 2,
      filename: 'court.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    });
    assert.equal(withMedia.media.length, 1);
    assert.equal(withMedia.version, 3);

    const stored = await database.db
      .collection<CourtDocument>('courts')
      .findOne({ _id: new ObjectId(created.id) });
    assert.deepEqual(
      stored?.audit_history.map((event) => event.event_type),
      ['COURT_CREATED', 'COURT_UPDATED', 'COURT_MEDIA_ADDED'],
    );
    assert.equal(stored?.media[0]?.storage_key, 'integration/courts/alpha/hero');
  } finally {
    if (databaseName.startsWith('turf_gds_court_it_')) {
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
