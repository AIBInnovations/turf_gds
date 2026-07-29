import type { ClientSession, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';

export interface LedgerEntryDocument {
  _id: ObjectId;
  booking_id: ObjectId;
  partner_id: ObjectId;
  venue_id: ObjectId;
  contract_id: ObjectId;
  settlement_id: ObjectId | null;
  payout_id: ObjectId | null;
  reverses_entry_id: ObjectId | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  entry_type:
    | 'BOOKING'
    | 'COMMISSION'
    | 'TAX'
    | 'REFUND'
    | 'REVERSAL'
    | 'ADJUSTMENT';
  direction: 'DEBIT' | 'CREDIT';
  amount_minor: number;
  currency: 'INR';
  effective_at: Date;
  correlation_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface LedgerRepository {
  post(entries: LedgerEntryDocument[], session: ClientSession): Promise<void>;
  listForBooking(
    bookingId: ObjectId,
    session: ClientSession,
  ): Promise<LedgerEntryDocument[]>;
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
  };
}
