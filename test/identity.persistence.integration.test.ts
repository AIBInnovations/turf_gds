import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { createKycRepository } from '../src/modules/identity/kyc/kyc.repository.js';
import { createKycService } from '../src/modules/identity/kyc/kyc.service.js';
import { createIdentityRepository } from '../src/modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import { createOwnerAccessRepository } from '../src/modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { initializeVenuePersistence } from '../src/modules/venue/venue.persistence.js';
import { createVenueRepository } from '../src/modules/venue/venue.repository.js';
import {
  createVenueService,
  type VenueService,
} from '../src/modules/venue/venue.service.js';
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

test('Venue Owner registration commits and rolls back as one MongoDB transaction', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }

  const databaseName =
    `turf_gds_identity_it_${process.pid}_${Date.now()}`;
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

    const venueService = createVenueService({
      repository: createVenueRepository(database),
    });
    const service = createIdentityService({
      repository: createIdentityRepository(database),
      venueService,
      database,
      authConfig,
    });

    const result = await service.registerVenueOwner(
      registrationInput('committed-owner@example.com'),
    );

    assert.equal(
      await database.db.collection('venue_owners').countDocuments({
        email: 'committed-owner@example.com',
      }),
      1,
    );
    assert.equal(
      await database.db.collection('venues').countDocuments(),
      1,
    );
    assert.equal(
      await database.db
        .collection('venue_owner_memberships')
        .countDocuments(),
      1,
    );

    const secondOwner = await service.registerVenueOwner(
      registrationInput('second-owner@example.com'),
    );
    const ownerAccessService = createOwnerAccessService({
      identityService: service,
      repository: createOwnerAccessRepository(database),
    });
    await ownerAccessService.addMember({
      actingOwnerId: result.ownerId,
      venueId: result.venueId,
      memberOwnerId: secondOwner.ownerId,
      role: 'STAFF',
    });

    const members = await ownerAccessService.listMembers(
      result.ownerId,
      result.venueId,
    );
    assert.equal(members.length, 2);
    assert.equal(
      members.some(
        (member) =>
          member.ownerId === secondOwner.ownerId &&
          member.role === 'STAFF',
      ),
      true,
    );
    await assert.rejects(
      ownerAccessService.addMember({
        actingOwnerId: secondOwner.ownerId,
        venueId: result.venueId,
        memberOwnerId: result.ownerId,
        role: 'MANAGER',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PERMISSION_DENIED',
    );

    const mediaStorage: MediaStorage = {
      async ping() {},
      async uploadBuffer() {
        return {
          publicId: `integration/kyc/${Date.now()}`,
          resourceType: 'image',
          deliveryType: 'authenticated',
          format: 'jpg',
          bytes: 8,
          width: 1,
          height: 1,
          url: 'http://example.com/protected',
          secureUrl: 'https://example.com/protected',
          version: 1,
          checksum: `checksum-${Date.now()}`,
        };
      },
      async delete() {},
    };
    const kycService = createKycService({
      repository: createKycRepository(database),
      mediaStorage,
      config: {
        maxFileBytes: 1_024,
        allowedMimeTypes: ['image/jpeg'],
      },
    });
    const verification = await kycService.createDraft({
      subjectType: 'VENUE_OWNER',
      subjectId: result.ownerId,
      verificationType: 'BUSINESS',
    });
    await kycService.uploadDocument({
      verificationId: verification.id,
      subjectId: result.ownerId,
      documentType: 'GST_CERTIFICATE',
      filename: 'gst.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    });
    await kycService.submit({
      verificationId: verification.id,
      subjectId: result.ownerId,
    });
    assert.equal(
      (
        await kycService.getCurrent({
          subjectType: 'VENUE_OWNER',
          subjectId: result.ownerId,
          verificationType: 'BUSINESS',
        })
      ).status,
      'PENDING',
    );
    const submitted = await database.db
      .collection('kyc_verifications')
      .findOne({ _id: new ObjectId(verification.id) });
    assert.ok(
      submitted?.audit_history.some(
        (event: { event_type?: string }) =>
          event.event_type === 'KYC_SUBMITTED',
      ),
    );
    await assert.rejects(
      kycService.getCurrent({
        subjectType: 'VENUE_OWNER',
        subjectId: secondOwner.ownerId,
        verificationType: 'BUSINESS',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'KYC_NOT_FOUND',
    );

    const failingVenueService: VenueService = {
      async createInitialVenue(input, session) {
        await venueService.createInitialVenue(input, session);
        throw new Error('forced registration failure');
      },
      async approveVenue() {
        throw new Error('not used');
      },
    };
    const failingService = createIdentityService({
      repository: createIdentityRepository(database),
      venueService: failingVenueService,
      database,
      authConfig,
    });

    await assert.rejects(
      failingService.registerVenueOwner(
        registrationInput('rolled-back-owner@example.com'),
      ),
      /forced registration failure/,
    );

    assert.equal(
      await database.db.collection('venue_owners').countDocuments({
        email: 'rolled-back-owner@example.com',
      }),
      0,
    );
    assert.equal(
      await database.db.collection('venues').countDocuments(),
      2,
    );
    assert.equal(
      await database.db
        .collection('venue_owner_memberships')
        .countDocuments(),
      3,
    );
  } finally {
    if (databaseName.startsWith('turf_gds_identity_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

function registrationInput(email: string) {
  return {
    legalName: 'Turf Owner Private Limited',
    email,
    phoneE164: '+919876543210',
    password: 'correct-horse-battery',
    venue: {
      legalName: 'Green Arena Private Limited',
      displayName: 'Green Arena',
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
