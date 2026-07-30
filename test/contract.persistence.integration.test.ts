import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { MongoServerError, ObjectId } from 'mongodb';

import { initializeContractPersistence } from '../src/modules/contracts/contract.persistence.js';
import { createContractRepository } from '../src/modules/contracts/contract.repository.js';
import { createContractService } from '../src/modules/contracts/contract.service.js';
import type { PartnerVenueContractDocument } from '../src/modules/contracts/contract.types.js';
import type { PartnerDocument } from '../src/modules/identity/partner/partner-access.types.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import type { VenueDocument } from '../src/modules/venue/profile/venue.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('Contracts persistence versions terms transactionally and resolves effective history', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }

  const databaseName = `turf_gds_contract_it_${process.pid}_${Date.now()}`;
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
    await initializeContractPersistence(database.db);
    const partnerId = new ObjectId();
    const venueId = new ObjectId();
    const adminId = new ObjectId();
    const timestamp = new Date('2026-07-29T10:00:00.000Z');
    await database.db.collection<PartnerDocument>('partners').insertOne({
      _id: partnerId,
      legal_name: 'Contract Partner Private Limited',
      display_name: 'Contract Partner',
      kyc_status: 'VERIFIED',
      status: 'ACTIVE',
      rate_limit_tier: 'STANDARD',
      sandbox_approved_at: timestamp,
      production_approved_by: adminId,
      production_approved_at: timestamp,
      audit_history: [],
      created_at: timestamp,
      updated_at: timestamp,
    });
    await database.db.collection<VenueDocument>('venues').insertOne({
      _id: venueId,
      legal_name: 'Contract Arena Private Limited',
      display_name: 'Contract Arena',
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
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const service = createContractService({
      repository: createContractRepository(database),
      database,
      now: () => timestamp,
    });
    const base = {
      adminId: adminId.toHexString(),
      partnerId: partnerId.toHexString(),
      venueId: venueId.toHexString(),
      commissionRateBps: 1_000,
      taxRateBps: 180,
      settlementCycle: 'WEEKLY' as const,
      settlementLagDays: 2,
      allowedBookingModes: 'BOTH' as const,
      cancellationTerms: {
        cancellationAllowed: true,
        defaultRefundBps: 0,
        releaseInventory: false,
      },
      refundRules: [{
        minMinutesBeforeStart: 1_440,
        refundBps: 10_000,
        releaseInventory: true,
      }],
      resaleCutoffMinutes: 60,
    };
    const first = await service.saveVersion({
      ...base,
      allowedBookingModes: base.allowedBookingModes,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    });
    const second = await service.saveVersion({
      ...base,
      allowedBookingModes: 'OPEN_TIME',
      commissionRateBps: 1_200,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    });

    assert.equal(first.termsVersion, 1);
    assert.equal(second.termsVersion, 2);
    const storedFirst = await service.get(first.id);
    assert.equal(storedFirst.status, 'ACTIVE');
    assert.equal(storedFirst.effectiveTo, '2026-09-01T00:00:00.000Z');
    assert.equal(
      (await service.getActiveContract({
        partnerId: partnerId.toHexString(),
        venueId: venueId.toHexString(),
        at: new Date('2026-08-15T00:00:00.000Z'),
      })).id,
      first.id,
    );
    assert.equal(
      await service.isBookingModeAllowed({
        partnerId: partnerId.toHexString(),
        venueId: venueId.toHexString(),
        bookingMode: 'FIXED_SLOT',
        at: new Date('2026-09-15T00:00:00.000Z'),
      }),
      false,
    );

    const concurrent = await Promise.allSettled([
      service.saveVersion({
        ...base,
        allowedBookingModes: 'OPEN_TIME',
        commissionRateBps: 1_300,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
      }),
      service.saveVersion({
        ...base,
        allowedBookingModes: 'OPEN_TIME',
        commissionRateBps: 1_400,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
      }),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = concurrent.find(
      (result) => result.status === 'rejected',
    );
    assert.ok(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof AppError &&
        [
          'CONTRACT_EFFECTIVE_DATE_CONFLICT',
          'CONTRACT_VERSION_CONFLICT',
        ].includes(rejected.reason.code),
    );

    const storedSecond = await database.db
      .collection<PartnerVenueContractDocument>(
        'partner_venue_contracts',
      )
      .findOne({ _id: new ObjectId(second.id) });
    assert.ok(storedSecond);
    await assert.rejects(
      database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .insertOne({
          ...storedSecond,
          _id: new ObjectId(),
          partner_id: new ObjectId(),
          venue_id: new ObjectId(),
          effective_from: new Date('2026-09-01T00:00:00.000Z'),
          effective_to: new Date('2026-08-01T00:00:00.000Z'),
        }),
      (error: unknown) =>
        error instanceof MongoServerError && error.code === 121,
    );
    await assert.rejects(
      database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .insertOne({
          ...storedSecond,
          _id: new ObjectId(),
          status: 'ACTIVE',
        }),
      (error: unknown) =>
        error instanceof MongoServerError && error.code === 11_000,
    );

    const indexes = await database.db
      .collection('partner_venue_contracts')
      .indexes();
    assert.ok(
      indexes.some(
        (index) => index.name === 'uq_contract_partner_venue_effective',
      ),
    );
    assert.ok(
      indexes.some(
        (index) => index.name === 'ix_contract_effective_lookup',
      ),
    );
  } finally {
    if (databaseName.startsWith('turf_gds_contract_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
