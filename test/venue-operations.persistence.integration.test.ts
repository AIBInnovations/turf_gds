import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { createCourtRepository } from '../src/modules/venue/court.repository.js';
import type { CourtDocument } from '../src/modules/venue/court.types.js';
import { initializeVenuePersistence } from '../src/modules/venue/venue.persistence.js';
import { createVenueOperationsRepository } from '../src/modules/venue/venue-operations.repository.js';
import { createVenueOperationsService } from '../src/modules/venue/venue-operations.service.js';
import { createVenueRepository } from '../src/modules/venue/venue.repository.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('Venue operations persistence enforces generation, versions, content, and tokenized payouts', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_venue_ops_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 2,
  });
  const ownerId = new ObjectId();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  const now = new Date('2026-07-28T00:00:00.000Z');

  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    await initializeVenuePersistence(database.db);
    await database.db.collection<VenueDocument>('venues').insertOne({
      _id: venueId,
      legal_name: 'Inventory Venue Private Limited',
      display_name: 'Inventory Venue',
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
      approved_by: null,
      approved_at: null,
      audit_history: [],
      version: 1,
      created_at: now,
      updated_at: now,
    });
    await database.db.collection<CourtDocument>('courts').insertOne({
      _id: courtId,
      venue_id: venueId,
      name: 'Inventory Court',
      sport_types: ['FOOTBALL'],
      booking_mode: 'BOTH',
      min_booking_minutes: 60,
      booking_increment_minutes: 30,
      operating_hours: [
        { day_of_week: 2, opens_at: '06:00', closes_at: '08:00' },
      ],
      timezone: 'Asia/Kolkata',
      media: [],
      status: 'ACTIVE',
      audit_history: [],
      version: 1,
      created_at: now,
      updated_at: now,
    });

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
      async requirePermission(actor, venue) {
        if (
          actor !== ownerId.toHexString() ||
          venue !== venueId.toHexString()
        ) {
          throw new AppError({
            code: 'PERMISSION_DENIED',
            message: 'Denied',
            statusCode: 403,
          });
        }
      },
      async requireVenueMembership(actor, venue) {
        if (
          actor !== ownerId.toHexString() ||
          venue !== venueId.toHexString()
        ) {
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
    const service = createVenueOperationsService({
      repository: createVenueOperationsRepository(database),
      venueRepository: createVenueRepository(database),
      courtRepository: createCourtRepository(database),
      ownerAccessService,
      database,
      now: () => now,
    });
    const scope = {
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
    };

    await service.createPricingRule({
      ...scope,
      name: 'Weekday',
      daysOfWeek: [2],
      startsTime: '06:00',
      endsTime: '08:00',
      amountMinor: 125000,
      currency: 'INR',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      priority: 1,
    });
    assert.deepEqual(
      await service.generateFixedSlots({
        ...scope,
        dateFrom: '2026-07-28',
        dateTo: '2026-07-28',
        correlationId: 'generate',
      }),
      { created: 2 },
    );
    assert.deepEqual(
      await service.generateFixedSlots({
        ...scope,
        dateFrom: '2026-07-28',
        dateTo: '2026-07-28',
        correlationId: 'generate-again',
      }),
      { created: 0 },
    );

    const inventory = await service.listInventory({
      ...scope,
      from: '2026-07-28T00:00:00.000Z',
      to: '2026-07-29T00:00:00.000Z',
    }) as Array<{ id: string; status: string; version: number }>;
    assert.equal(inventory.length, 2);
    const blocked = await service.blockAvailability({
      ...scope,
      correlationId: 'block',
      reason: 'Maintenance',
      slotId: inventory[0]!.id,
      slotVersion: inventory[0]!.version,
    }) as { status: string; version: number };
    assert.equal(blocked.status, 'BLOCKED');
    await service.releaseAvailability({
      ...scope,
      slotId: inventory[0]!.id,
      expectedVersion: blocked.version,
      reason: 'Complete',
      correlationId: 'release',
    });

    const createdContent = await service.saveContent({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      content: { amenities: ['Parking'] },
    }) as { version: number };
    assert.equal(createdContent.version, 1);
    await assert.rejects(
      service.saveContent({
        actorOwnerId: ownerId.toHexString(),
        venueId: venueId.toHexString(),
        expectedVersion: 99,
        content: { amenities: [] },
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'CONTENT_VERSION_CONFLICT',
    );

    const payout = await service.addPayoutAccount({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      accountHolderName: 'Inventory Venue Pvt Ltd',
      vaultProvider: 'bank-vault',
      vaultAccountToken: 'tok_inventory_account_123',
      accountLast4: '4567',
      bankName: 'Example Bank',
      ifscCode: 'ABCD0123456',
    }) as Record<string, unknown>;
    assert.equal(payout.status, 'PENDING');
    assert.equal('vaultAccountToken' in payout, false);

    const collections = await database.db
      .listCollections({}, { nameOnly: true })
      .toArray();
    const names = collections.map((value) => value.name);
    assert.equal(names.includes('pricing_rules'), true);
    assert.equal(names.includes('slots'), true);
    assert.equal(names.includes('venue_contents'), true);
    assert.equal(names.includes('venue_payout_accounts'), true);
  } finally {
    if (databaseName.startsWith('turf_gds_venue_ops_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
