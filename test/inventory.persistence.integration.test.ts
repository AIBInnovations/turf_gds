import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { createCourtRepository } from '../src/modules/venue/courts/court.repository.js';
import type { CourtDocument } from '../src/modules/venue/courts/court.types.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { createInventoryRepository } from '../src/modules/venue/inventory/inventory.repository.js';
import { createInventoryService } from '../src/modules/venue/inventory/inventory.service.js';
import { createPayoutAccountRepository } from '../src/modules/venue/payout-accounts/payout-account.repository.js';
import { createPayoutAccountService } from '../src/modules/venue/payout-accounts/payout-account.service.js';
import { createVenueRepository } from '../src/modules/venue/profile/venue.repository.js';
import type { VenueDocument } from '../src/modules/venue/profile/venue.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('Inventory and payout-account persistence enforce their independent boundaries', async (context) => {
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
      audit_history: [],
      version: 1,
      created_at: now,
      updated_at: now,
    });
    await database.db.collection<CourtDocument>('courts').insertOne({
      _id: courtId,
      venue_id: venueId,
      name: 'Inventory Court',
      sport_type: 'FOOTBALL',
      surface_type: 'ARTIFICIAL_TURF',
      capacity: 10,
      booking_mode: 'BOTH',
      min_booking_minutes: 60,
      booking_increment_minutes: 30,
      operating_hours: { entries: [
        { day_of_week: 2, opens_at: '06:00', closes_at: '08:00' },
      ] },
      fixed_slot_duration_minutes: null,
      fixed_slot_anchor_minutes: null,
      media: [],
      status: 'AVAILABLE',
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
    const service = createInventoryService({
      repository: createInventoryRepository(database),
      venueRepository: createVenueRepository(database),
      courtRepository: createCourtRepository(database),
      ownerAccessService,
      database,
      now: () => now,
    });
    const payoutAccountService = createPayoutAccountService({
      repository: createPayoutAccountRepository(database),
      ownerAccessService,
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
      dayOfWeek: 2,
      startTime: '06:00',
      endTime: '08:00',
      priceMinor: 125000,
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

    const payout = await payoutAccountService.add({
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
    assert.equal(names.includes('venue_contents'), false);
    assert.equal(names.includes('venue_payout_accounts'), true);
  } finally {
    if (databaseName.startsWith('turf_gds_venue_ops_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
