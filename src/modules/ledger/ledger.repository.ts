import type { ClientSession, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  LedgerEntryDocument,
  LedgerEnvironment,
} from './ledger.types.js';

export type { LedgerEntryDocument } from './ledger.types.js';

export interface LedgerRepository {
  post(entries: LedgerEntryDocument[], session: ClientSession): Promise<void>;
  listForBooking(
    bookingId: ObjectId,
    session: ClientSession,
  ): Promise<LedgerEntryDocument[]>;
  listUnsettled(input: {
    partnerId: ObjectId;
    environment: LedgerEnvironment;
    periodStart: Date;
    periodEnd: Date;
    session: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  allocateToSettlement(input: {
    entryIds: ObjectId[];
    settlementId: ObjectId;
    session: ClientSession;
  }): Promise<boolean>;
  findByIds(
    ids: ObjectId[],
    session?: ClientSession,
  ): Promise<LedgerEntryDocument[]>;
  listForSettlementVenue(input: {
    settlementId: ObjectId;
    venueId: ObjectId;
    session?: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  allocateToPayout(input: {
    entryIds: ObjectId[];
    settlementId: ObjectId;
    venueId: ObjectId;
    payoutId: ObjectId;
    session: ClientSession;
  }): Promise<boolean>;
  listSettlementIdsForVenue(input: {
    venueId: ObjectId;
    from?: Date;
    to?: Date;
  }): Promise<ObjectId[]>;
}

export function createLedgerRepository(
  database: DatabaseConnection,
): LedgerRepository {
  const collection = () =>
    database.db.collection<LedgerEntryDocument>('ledger_entries');
  return {
    async post(entries, session) {
      if (entries.length > 0) {
        await collection().insertMany(entries, { session });
      }
    },
    listForBooking(bookingId, session) {
      return collection()
        .find({ booking_id: bookingId }, { session })
        .sort({ created_at: 1, _id: 1 })
        .toArray();
    },
    listUnsettled(input) {
      return collection()
        .find(
          {
            partner_id: input.partnerId,
            environment: input.environment,
            effective_at: {
              $gte: input.periodStart,
              $lt: input.periodEnd,
            },
            settlement_id: null,
          },
          { session: input.session },
        )
        .sort({ effective_at: 1, _id: 1 })
        .toArray();
    },
    async allocateToSettlement(input) {
      if (input.entryIds.length === 0) return false;
      const result = await collection().updateMany(
        {
          _id: { $in: input.entryIds },
          settlement_id: null,
        },
        { $set: { settlement_id: input.settlementId } },
        { session: input.session },
      );
      return result.modifiedCount === input.entryIds.length;
    },
    findByIds(ids, session) {
      if (ids.length === 0) return Promise.resolve([]);
      return collection()
        .find(
          { _id: { $in: ids } },
          { ...(session ? { session } : {}) },
        )
        .toArray();
    },
    listForSettlementVenue(input) {
      return collection()
        .find(
          {
            settlement_id: input.settlementId,
            venue_id: input.venueId,
          },
          { ...(input.session ? { session: input.session } : {}) },
        )
        .sort({ effective_at: 1, _id: 1 })
        .toArray();
    },
    async allocateToPayout(input) {
      if (input.entryIds.length === 0) return false;
      const result = await collection().updateMany(
        {
          _id: { $in: input.entryIds },
          settlement_id: input.settlementId,
          venue_id: input.venueId,
          payout_id: null,
        },
        { $set: { payout_id: input.payoutId } },
        { session: input.session },
      );
      return result.modifiedCount === input.entryIds.length;
    },
    async listSettlementIdsForVenue(input) {
      const values = await collection()
        .aggregate<{ _id: ObjectId }>([
          {
            $match: {
              venue_id: input.venueId,
              settlement_id: { $type: 'objectId' },
              ...(input.from || input.to
                ? {
                    effective_at: {
                      ...(input.from ? { $gte: input.from } : {}),
                      ...(input.to ? { $lt: input.to } : {}),
                    },
                  }
                : {}),
            },
          },
          { $group: { _id: '$settlement_id' } },
        ])
        .toArray();
      return values.map(({ _id }) => _id);
    },
  };
}
