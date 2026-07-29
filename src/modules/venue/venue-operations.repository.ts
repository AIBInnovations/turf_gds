import { type ClientSession, type ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  PricingRuleDocument,
  SlotDocument,
  VenuePayoutAccountDocument,
} from './inventory.types.js';
import type { CourtDocument } from './court.types.js';

export interface VenueOperationsRepository {
  insertPricingRule(rule: PricingRuleDocument): Promise<void>;
  listPricingRules(courtId: ObjectId): Promise<PricingRuleDocument[]>;
  findPricingRule(
    id: ObjectId,
    courtId: ObjectId,
  ): Promise<PricingRuleDocument | null>;
  updatePricingRule(
    id: ObjectId,
    courtId: ObjectId,
    changes: Partial<PricingRuleDocument>,
  ): Promise<PricingRuleDocument | null>;
  bulkUpsertSlots(slots: SlotDocument[]): Promise<number>;
  listSlots(
    courtId: ObjectId,
    from: Date,
    to: Date,
  ): Promise<SlotDocument[]>;
  updateFixedSlot(input: {
    slotId: ObjectId;
    courtId: ObjectId;
    expectedVersion: number;
    fromStatus: 'AVAILABLE' | 'BLOCKED';
    toStatus: 'BLOCKED' | 'AVAILABLE';
    actorOwnerId: ObjectId;
    reason: string;
    correlationId: string;
    now: Date;
  }): Promise<SlotDocument | null>;
  findOverlap(
    courtId: ObjectId,
    environment: 'SANDBOX' | 'PRODUCTION',
    startsAt: Date,
    endsAt: Date,
    session?: ClientSession,
  ): Promise<SlotDocument | null>;
  lockCourtForInventory(input: {
    courtId: ObjectId;
    venueId: ObjectId;
    expectedVersion: number;
    actorOwnerId: ObjectId;
    correlationId: string;
    now: Date;
    session: ClientSession;
  }): Promise<boolean>;
  insertOpenBlock(slot: SlotDocument, session: ClientSession): Promise<void>;
  deleteOpenBlock(input: {
    slotId: ObjectId;
    courtId: ObjectId;
    expectedVersion: number;
  }): Promise<boolean>;
  findSlot(id: ObjectId, courtId: ObjectId): Promise<SlotDocument | null>;
  insertPayoutAccount(account: VenuePayoutAccountDocument): Promise<void>;
  listPayoutAccounts(
    venueId: ObjectId,
  ): Promise<VenuePayoutAccountDocument[]>;
}

export function createVenueOperationsRepository(
  database: DatabaseConnection,
): VenueOperationsRepository {
  const pricing = () =>
    database.db.collection<PricingRuleDocument>('pricing_rules');
  const slots = () => database.db.collection<SlotDocument>('slots');
  const payoutAccounts = () =>
    database.db.collection<VenuePayoutAccountDocument>(
      'venue_payout_accounts',
    );

  return {
    async insertPricingRule(rule) {
      await pricing().insertOne(rule);
    },
    listPricingRules(courtId) {
      return pricing()
        .find({ court_id: courtId })
        .sort({ priority: -1, created_at: 1 })
        .toArray();
    },
    findPricingRule(id, courtId) {
      return pricing().findOne({ _id: id, court_id: courtId });
    },
    updatePricingRule(id, courtId, changes) {
      return pricing().findOneAndUpdate(
        { _id: id, court_id: courtId },
        { $set: changes },
        { returnDocument: 'after' },
      );
    },
    async bulkUpsertSlots(values) {
      if (values.length === 0) {
        return 0;
      }
      const result = await slots().bulkWrite(
        values.map((slot) => ({
          updateOne: {
            filter: {
              court_id: slot.court_id,
              environment: slot.environment,
              booking_type: slot.booking_type,
              starts_at: slot.starts_at,
              ends_at: slot.ends_at,
            },
            update: { $setOnInsert: slot },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      return result.upsertedCount;
    },
    listSlots(courtId, from, to) {
      return slots()
        .find({
          court_id: courtId,
          starts_at: { $lt: to },
          ends_at: { $gt: from },
        })
        .sort({ starts_at: 1 })
        .toArray();
    },
    updateFixedSlot(input) {
      return slots().findOneAndUpdate(
        {
          _id: input.slotId,
          court_id: input.courtId,
          booking_type: 'FIXED_SLOT',
          status: input.fromStatus,
          version: input.expectedVersion,
        },
        {
          $set: { status: input.toStatus, updated_at: input.now },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type:
                  input.toStatus === 'BLOCKED'
                    ? 'SLOT_BLOCKED'
                    : 'SLOT_RELEASED',
                actor_type: 'VENUE_OWNER',
                actor_id: input.actorOwnerId,
                previous_status: input.fromStatus,
                new_status: input.toStatus,
                reason: input.reason,
                correlation_id: input.correlationId,
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after' },
      );
    },
    findOverlap(courtId, environment, startsAt, endsAt, session) {
      return slots().findOne(
        {
          court_id: courtId,
          environment,
          status: { $in: ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'] },
          starts_at: { $lt: endsAt },
          ends_at: { $gt: startsAt },
        },
        ...(session ? [{ session }] : []),
      );
    },
    async lockCourtForInventory(input) {
      const result = await database.db.collection<CourtDocument>('courts').updateOne(
        {
          _id: input.courtId,
          venue_id: input.venueId,
          version: input.expectedVersion,
          status: 'AVAILABLE',
        },
        {
          $inc: { version: 1 },
          $set: { updated_at: input.now },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'COURT_INVENTORY_CHANGED',
                actor_type: 'VENUE_OWNER',
                actor_id: input.actorOwnerId,
                correlation_id: input.correlationId,
                changed_fields: ['inventory'],
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { session: input.session },
      );
      return result.modifiedCount > 0;
    },
    async insertOpenBlock(slot, session) {
      await slots().insertOne(slot, { session });
    },
    async deleteOpenBlock(input) {
      const result = await slots().deleteOne({
        _id: input.slotId,
        court_id: input.courtId,
        booking_type: 'OPEN_TIME',
        status: 'BLOCKED',
        version: input.expectedVersion,
      });
      return result.deletedCount > 0;
    },
    findSlot(id, courtId) {
      return slots().findOne({ _id: id, court_id: courtId });
    },
    async insertPayoutAccount(account) {
      await payoutAccounts().insertOne(account);
    },
    listPayoutAccounts(venueId) {
      return payoutAccounts()
        .find({ venue_id: venueId })
        .sort({ created_at: -1 })
        .toArray();
    },
  };
}
