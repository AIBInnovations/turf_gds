import type { ClientSession, Filter, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type { BookingDocument } from '../booking/booking.types.js';
import type { PartnerVenueContractDocument } from '../contracts/contract.types.js';
import type { KycVerificationDocument } from '../identity/kyc/kyc.types.js';
import type { VenueOwnerMembershipDocument } from '../identity/owner/owner.types.js';
import type { VenuePayoutAccountDocument } from '../venue/payout-accounts/payout-account.types.js';
import type { VenueDocument } from '../venue/profile/venue.types.js';
import type {
  FinancialEnvironment,
  PayoutDocument,
  PayoutStatus,
  ReconciliationAttemptDocument,
  ReconciliationDocument,
  SettlementDocument,
  SettlementStatus,
} from './financial-close.types.js';

export interface Page<T> {
  items: T[];
  total: number;
}

export interface FinancialCloseRepository {
  findContracts(
    ids: ObjectId[],
    session: ClientSession,
  ): Promise<PartnerVenueContractDocument[]>;
  insertSettlement(
    settlement: SettlementDocument,
    session: ClientSession,
  ): Promise<void>;
  findSettlementPeriod(input: {
    partnerId: ObjectId;
    environment: FinancialEnvironment;
    periodStart: Date;
    periodEnd: Date;
    session: ClientSession;
  }): Promise<SettlementDocument | null>;
  findSettlement(
    id: ObjectId,
    session?: ClientSession,
  ): Promise<SettlementDocument | null>;
  listSettlements(input: {
    ids?: ObjectId[];
    partnerId?: ObjectId;
    environment?: FinancialEnvironment;
    status?: SettlementStatus;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }): Promise<Page<SettlementDocument>>;
  transitionSettlement(input: {
    id: ObjectId;
    from: SettlementStatus;
    to: SettlementStatus;
    adminId: ObjectId;
    correlationId: string;
    now: Date;
    completedAt?: Date | null;
    session: ClientSession;
  }): Promise<SettlementDocument | null>;
  insertReconciliation(
    reconciliation: ReconciliationDocument,
    session: ClientSession,
  ): Promise<void>;
  findReconciliation(
    settlementId: ObjectId,
    session?: ClientSession,
  ): Promise<ReconciliationDocument | null>;
  resolveReconciliation(input: {
    settlementId: ObjectId;
    adminId: ObjectId;
    evidenceUri: string;
    notes: string;
    attempt: ReconciliationAttemptDocument;
    correlationId: string;
    now: Date;
    session: ClientSession;
  }): Promise<ReconciliationDocument | null>;
  findVenue(id: ObjectId, session: ClientSession): Promise<VenueDocument | null>;
  findCanonicalOwner(
    venueId: ObjectId,
    session: ClientSession,
  ): Promise<VenueOwnerMembershipDocument | null>;
  findCurrentBusinessKyc(
    ownerId: ObjectId,
    session: ClientSession,
  ): Promise<KycVerificationDocument | null>;
  findPayoutAccount(
    id: ObjectId,
    venueId: ObjectId,
    session?: ClientSession,
  ): Promise<VenuePayoutAccountDocument | null>;
  findPayoutByIdempotency(
    key: string,
    session: ClientSession,
  ): Promise<PayoutDocument | null>;
  findPayoutForSettlementVenue(
    settlementId: ObjectId,
    venueId: ObjectId,
    session: ClientSession,
  ): Promise<PayoutDocument | null>;
  insertPayout(payout: PayoutDocument, session: ClientSession): Promise<void>;
  findPayout(
    id: ObjectId,
    venueId?: ObjectId,
    session?: ClientSession,
  ): Promise<PayoutDocument | null>;
  listPayouts(input: {
    venueId?: ObjectId;
    settlementId?: ObjectId;
    status?: PayoutStatus;
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }): Promise<Page<PayoutDocument>>;
  recordPayoutResult(input: {
    id: ObjectId;
    status: 'PAID' | 'FAILED';
    bankReference: string | null;
    failureReason: string | null;
    adminId: ObjectId;
    correlationId: string;
    now: Date;
    session: ClientSession;
  }): Promise<PayoutDocument | null>;
  findBookings(
    ids: ObjectId[],
    session?: ClientSession,
  ): Promise<BookingDocument[]>;
}

export function createFinancialCloseRepository(
  database: DatabaseConnection,
): FinancialCloseRepository {
  const settlements = () =>
    database.db.collection<SettlementDocument>('settlements');
  const reconciliations = () =>
    database.db.collection<ReconciliationDocument>('reconciliations');
  const payouts = () => database.db.collection<PayoutDocument>('payouts');

  return {
    findContracts(ids, session) {
      return database.db
        .collection<PartnerVenueContractDocument>('partner_venue_contracts')
        .find({ _id: { $in: ids } }, { session })
        .toArray();
    },
    async insertSettlement(settlement, session) {
      await settlements().insertOne(settlement, { session });
    },
    findSettlementPeriod(input) {
      return settlements().findOne(
        {
          partner_id: input.partnerId,
          environment: input.environment,
          period_start: input.periodStart,
          period_end: input.periodEnd,
        },
        { session: input.session },
      );
    },
    findSettlement(id, session) {
      return settlements().findOne(
        { _id: id },
        { ...(session ? { session } : {}) },
      );
    },
    async listSettlements(input) {
      const filter: Filter<SettlementDocument> = {
        ...(input.ids ? { _id: { $in: input.ids } } : {}),
        ...(input.partnerId ? { partner_id: input.partnerId } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.from || input.to
          ? {
              period_start: {
                ...(input.from ? { $gte: input.from } : {}),
                ...(input.to ? { $lt: input.to } : {}),
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        settlements()
          .find(filter)
          .sort({ period_start: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .toArray(),
        settlements().countDocuments(filter),
      ]);
      return { items, total };
    },
    transitionSettlement(input) {
      return settlements().findOneAndUpdate(
        { _id: input.id, status: input.from },
        {
          $set: {
            status: input.to,
            ...(input.completedAt !== undefined
              ? { completed_at: input.completedAt }
              : {}),
          },
          $push: {
            audit_history: {
              $each: [{
                event_type: `SETTLEMENT_${input.to}`,
                actor_type: 'ADMIN' as const,
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: input.from,
                  new_status: input.to,
                },
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
    },
    async insertReconciliation(reconciliation, session) {
      await reconciliations().insertOne(reconciliation, { session });
    },
    findReconciliation(settlementId, session) {
      return reconciliations().findOne(
        { settlement_id: settlementId },
        {
          ...(session ? { session } : {}),
          sort: { created_at: -1 },
        },
      );
    },
    resolveReconciliation(input) {
      return reconciliations().findOneAndUpdate(
        { settlement_id: input.settlementId, status: 'MISMATCH' },
        {
          $set: {
            status: 'RESOLVED',
            reconciled_by: input.adminId,
            reconciled_at: input.now,
            evidence_uri: input.evidenceUri,
            notes: input.notes,
          },
          $push: {
            attempt_history: { $each: [input.attempt], $slice: -100 },
            audit_history: {
              $each: [{
                event_type: 'RECONCILIATION_RESOLVED',
                actor_type: 'ADMIN' as const,
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: 'MISMATCH',
                  new_status: 'RESOLVED',
                },
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
    },
    findVenue(id, session) {
      return database.db
        .collection<VenueDocument>('venues')
        .findOne({ _id: id }, { session });
    },
    findCanonicalOwner(venueId, session) {
      return database.db
        .collection<VenueOwnerMembershipDocument>('venue_owner_memberships')
        .findOne(
          { venue_id: venueId, role: 'OWNER', status: 'ACTIVE' },
          { session },
        );
    },
    findCurrentBusinessKyc(ownerId, session) {
      return database.db
        .collection<KycVerificationDocument>('kyc_verifications')
        .findOne(
          {
            subject_type: 'VENUE_OWNER',
            subject_id: ownerId,
            verification_type: 'BUSINESS',
            is_current: true,
          },
          { session },
        );
    },
    findPayoutAccount(id, venueId, session) {
      return database.db
        .collection<VenuePayoutAccountDocument>('venue_payout_accounts')
        .findOne(
          { _id: id, venue_id: venueId },
          { ...(session ? { session } : {}) },
        );
    },
    findPayoutByIdempotency(key, session) {
      return payouts().findOne({ idempotency_key: key }, { session });
    },
    findPayoutForSettlementVenue(settlementId, venueId, session) {
      return payouts().findOne(
        { settlement_id: settlementId, venue_id: venueId },
        { session },
      );
    },
    async insertPayout(payout, session) {
      await payouts().insertOne(payout, { session });
    },
    findPayout(id, venueId, session) {
      return payouts().findOne(
        { _id: id, ...(venueId ? { venue_id: venueId } : {}) },
        { ...(session ? { session } : {}) },
      );
    },
    async listPayouts(input) {
      const filter: Filter<PayoutDocument> = {
        ...(input.venueId ? { venue_id: input.venueId } : {}),
        ...(input.settlementId ? { settlement_id: input.settlementId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.from || input.to
          ? {
              created_at: {
                ...(input.from ? { $gte: input.from } : {}),
                ...(input.to ? { $lt: input.to } : {}),
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        payouts()
          .find(filter)
          .sort({ created_at: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .toArray(),
        payouts().countDocuments(filter),
      ]);
      return { items, total };
    },
    recordPayoutResult(input) {
      return payouts().findOneAndUpdate(
        { _id: input.id, status: 'PENDING' },
        {
          $set: {
            status: input.status,
            bank_reference: input.bankReference,
            failure_reason: input.failureReason,
            paid_at: input.status === 'PAID' ? input.now : null,
            updated_at: input.now,
          },
          $push: {
            audit_history: {
              $each: [{
                event_type: `PAYOUT_${input.status}`,
                actor_type: 'ADMIN' as const,
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: 'PENDING',
                  new_status: input.status,
                  bank_reference: input.bankReference,
                  failure_reason: input.failureReason,
                },
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
    },
    findBookings(ids, session) {
      if (ids.length === 0) return Promise.resolve([]);
      return database.db
        .collection<BookingDocument>('bookings')
        .find(
          { _id: { $in: ids } },
          { ...(session ? { session } : {}) },
        )
        .toArray();
    },
  };
}
