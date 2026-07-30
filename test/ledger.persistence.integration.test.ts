import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import { initializeLedgerPersistence } from '../src/modules/ledger/ledger.persistence.js';
import { createLedgerRepository } from '../src/modules/ledger/ledger.repository.js';
import { createLedgerService } from '../src/modules/ledger/ledger.service.js';
import type { LedgerEntryDocument } from '../src/modules/ledger/ledger.types.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';

test('Ledger persistence validates journals, indexes allocations, and links once', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_ledger_it_${process.pid}_${Date.now()}`;
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
    await initializeLedgerPersistence(database.db);
    const repository = createLedgerRepository(database);
    const service = createLedgerService(repository);
    const bookingId = new ObjectId();
    const timestamp = new Date('2026-08-12T10:00:00.000Z');
    let posted: LedgerEntryDocument[] = [];
    await database.withTransaction(async ({ session }) => {
      posted = await service.postBooking({
        booking: {
          bookingId,
          partnerId: new ObjectId(),
          venueId: new ObjectId(),
          contractId: new ObjectId(),
          environment: 'PRODUCTION',
          grossAmountMinor: 10_000,
          commissionAmountMinor: 1_000,
          taxAmountMinor: 180,
          venueNetAmountMinor: 8_820,
        },
        effectiveAt: timestamp,
        correlationId: 'ledger-integration',
        session,
      });
    });
    assert.equal(posted.length, 4);
    const settlementId = new ObjectId();
    await database.withTransaction(async ({ session }) => {
      assert.equal(
        await service.allocateToSettlement({
          entryIds: posted.map(({ _id }) => _id),
          settlementId,
          session,
        }),
        true,
      );
    });
    await database.withTransaction(async ({ session }) => {
      assert.equal(
        await service.allocateToSettlement({
          entryIds: posted.map(({ _id }) => _id),
          settlementId: new ObjectId(),
          session,
        }),
        false,
      );
    });
    const stored = await database.db
      .collection<LedgerEntryDocument>('ledger_entries')
      .find({ booking_id: bookingId })
      .toArray();
    assert.equal(
      stored.every(({ settlement_id }) => settlement_id?.equals(settlementId)),
      true,
    );
    assert.equal(
      stored.reduce(
        (sum, value) =>
          sum +
          (value.direction === 'DEBIT'
            ? value.amount_minor
            : -value.amount_minor),
        0,
      ),
      0,
    );
    const settlementIds = await service.listSettlementIdsForVenue({
      venueId: posted[0]!.venue_id,
      from: new Date('2026-08-12T00:00:00.000Z'),
      to: new Date('2026-08-13T00:00:00.000Z'),
    });
    assert.deepEqual(
      settlementIds.map((value) => value.toHexString()),
      [settlementId.toHexString()],
    );
    await assert.rejects(
      database.db.collection('ledger_entries').insertOne({
        _id: new ObjectId(),
        booking_id: bookingId,
      }),
    );
    const indexNames = (
      await database.db.collection('ledger_entries').indexes()
    ).map(({ name }) => name);
    for (const name of [
      'ix_ledger_booking',
      'ix_ledger_settlement_venue',
      'ix_ledger_payout',
      'ix_ledger_unsettled_batch',
      'ix_ledger_reversal_reference',
      'ix_ledger_correlation',
    ]) {
      assert.equal(indexNames.includes(name), true);
    }
  } finally {
    if (databaseName.startsWith('turf_gds_ledger_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
