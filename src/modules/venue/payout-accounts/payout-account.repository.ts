import type { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { VenuePayoutAccountDocument } from './payout-account.types.js';

export interface PayoutAccountRepository {
  insert(account: VenuePayoutAccountDocument): Promise<void>;
  list(venueId: ObjectId): Promise<VenuePayoutAccountDocument[]>;
  verify(input: {
    accountId: ObjectId;
    venueId: ObjectId;
    adminId: ObjectId;
    outcome: 'VERIFIED' | 'FAILED';
    verificationMethod: 'PENNY_DROP' | 'MANUAL';
    failureReason: string | null;
    correlationId: string;
    now: Date;
  }): Promise<VenuePayoutAccountDocument | null>;
}

export function createPayoutAccountRepository(
  database: DatabaseConnection,
): PayoutAccountRepository {
  const accounts = () =>
    database.db.collection<VenuePayoutAccountDocument>('venue_payout_accounts');
  return {
    async insert(account) {
      await accounts().insertOne(account);
    },
    list(venueId) {
      return accounts()
        .find({ venue_id: venueId })
        .sort({ created_at: -1 })
        .toArray();
    },
    verify(input) {
      const verified = input.outcome === 'VERIFIED';
      return accounts().findOneAndUpdate(
        {
          _id: input.accountId,
          venue_id: input.venueId,
          status: 'PENDING',
        },
        {
          $set: {
            status: verified ? 'VERIFIED' : 'DISABLED',
            verification_method: input.verificationMethod,
            verified_by: verified ? input.adminId : null,
            verified_at: verified ? input.now : null,
            verification_failure_reason: input.failureReason,
            updated_at: input.now,
          },
          $push: {
            audit_history: {
              $each: [{
                event_type: verified
                  ? 'PAYOUT_ACCOUNT_VERIFIED'
                  : 'PAYOUT_ACCOUNT_VERIFICATION_FAILED',
                actor_type: 'ADMIN',
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: 'PENDING',
                  new_status: verified ? 'VERIFIED' : 'DISABLED',
                  verification_method: input.verificationMethod,
                  failure_reason: input.failureReason,
                },
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after' },
      );
    },
  };
}
