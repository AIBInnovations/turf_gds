import type {
  ClientSession,
  ObjectId,
  UpdateFilter,
} from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type { PartnerVenueContractDocument } from '../contracts/contract.types.js';
import type { CourtDocument } from '../venue/court.types.js';
import type {
  PricingRuleDocument,
  SlotDocument,
  SlotStatus,
} from '../venue/inventory.types.js';
import type { VenueDocument } from '../venue/venue.types.js';
import type {
  ApiIdempotencyRecordDocument,
  BookingCancellationDocument,
  BookingDocument,
} from './booking.types.js';

export interface BookingLifecycleRepository {
  findVenue(id: ObjectId, session: ClientSession): Promise<VenueDocument | null>;
  findCourt(id: ObjectId, session: ClientSession): Promise<CourtDocument | null>;
  findEffectiveContract(
    partnerId: ObjectId,
    venueId: ObjectId,
    environment: 'SANDBOX' | 'PRODUCTION',
    at: Date,
    session: ClientSession,
  ): Promise<PartnerVenueContractDocument | null>;
  findSlot(id: ObjectId, session: ClientSession): Promise<SlotDocument | null>;
  findPricingRules(
    courtId: ObjectId,
    at: Date,
    session: ClientSession,
  ): Promise<PricingRuleDocument[]>;
  claimFixedHold(input: {
    slotId: ObjectId;
    partnerId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    holdId: string;
    expiresAt: Date;
    now: Date;
    previousStatus: 'AVAILABLE' | 'HELD';
    correlationId: string;
    session: ClientSession;
  }): Promise<SlotDocument | null>;
  findConflictingSlot(input: {
    courtId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    startsAt: Date;
    endsAt: Date;
    now: Date;
    session: ClientSession;
  }): Promise<SlotDocument | null>;
  lockCourt(input: {
    courtId: ObjectId;
    version: number;
    now: Date;
    session: ClientSession;
  }): Promise<boolean>;
  insertSlot(slot: SlotDocument, session: ClientSession): Promise<void>;
  findHeldSlot(
    holdId: string,
    partnerId: ObjectId,
    environment: 'SANDBOX' | 'PRODUCTION',
    session: ClientSession,
  ): Promise<SlotDocument | null>;
  confirmSlot(input: {
    slot: SlotDocument;
    bookingId: ObjectId;
    partnerId: ObjectId;
    now: Date;
    correlationId: string;
    session: ClientSession;
  }): Promise<SlotDocument | null>;
  getIdempotency(
    partnerId: ObjectId,
    environment: 'SANDBOX' | 'PRODUCTION',
    key: string,
    operation: string,
    session?: ClientSession,
  ): Promise<ApiIdempotencyRecordDocument | null>;
  insertIdempotency(
    record: ApiIdempotencyRecordDocument,
    session: ClientSession,
  ): Promise<void>;
  insertBooking(booking: BookingDocument, session: ClientSession): Promise<void>;
  findBooking(
    id: ObjectId,
    partnerId: ObjectId,
    environment: 'SANDBOX' | 'PRODUCTION',
    session: ClientSession,
  ): Promise<BookingDocument | null>;
  cancelBooking(input: {
    booking: BookingDocument;
    now: Date;
    correlationId: string;
    reasonCode: string;
    reasonText: string | null;
    session: ClientSession;
  }): Promise<BookingDocument | null>;
  disposeSlot(input: {
    booking: BookingDocument;
    disposition: 'RELEASE_TO_INVENTORY' | 'KEEP_UNAVAILABLE';
    now: Date;
    correlationId: string;
    session: ClientSession;
  }): Promise<boolean>;
  insertCancellation(
    cancellation: BookingCancellationDocument,
    session: ClientSession,
  ): Promise<void>;
  recoverExpiredHolds(now: Date): Promise<{
    fixedReleased: number;
    openReleased: number;
  }>;
  findBookingAudit(id: ObjectId): Promise<BookingDocument | null>;
}

export function createBookingLifecycleRepository(
  database: DatabaseConnection,
): BookingLifecycleRepository {
  const slots = () => database.db.collection<SlotDocument>('slots');
  const bookings = () => database.db.collection<BookingDocument>('bookings');
  const idempotency = () =>
    database.db.collection<ApiIdempotencyRecordDocument>(
      'api_idempotency_records',
    );

  return {
    findVenue(id, session) {
      return database.db
        .collection<VenueDocument>('venues')
        .findOne({ _id: id }, { session });
    },
    findCourt(id, session) {
      return database.db
        .collection<CourtDocument>('courts')
        .findOne({ _id: id }, { session });
    },
    findEffectiveContract(partnerId, venueId, environment, at, session) {
      return database.db
        .collection<PartnerVenueContractDocument>('partner_venue_contracts')
        .find({
          partner_id: partnerId,
          venue_id: venueId,
          status: 'ACTIVE',
          effective_from: { $lte: at },
          $or: [{ effective_to: null }, { effective_to: { $gt: at } }],
        }, { session })
        .sort({ effective_from: -1 })
        .limit(1)
        .next()
        .then((contract) => {
          if (!contract) return null;
          // Contract has no environment field; the Venue is the environment
          // boundary and is checked by the service in the same transaction.
          void environment;
          return contract;
        });
    },
    findSlot(id, session) {
      return slots().findOne({ _id: id }, { session });
    },
    findPricingRules(courtId, at, session) {
      return database.db
        .collection<PricingRuleDocument>('pricing_rules')
        .find(
          {
            court_id: courtId,
            active: true,
            effective_from: { $lte: at },
            $or: [{ effective_to: null }, { effective_to: { $gt: at } }],
          },
          { session },
        )
        .sort({ priority: -1, created_at: 1 })
        .toArray();
    },
    claimFixedHold(input) {
      return slots().findOneAndUpdate(
        {
          _id: input.slotId,
          environment: input.environment,
          booking_type: 'FIXED_SLOT',
          booking_id: null,
          $or: [
            { status: 'AVAILABLE' },
            {
              status: 'HELD',
              hold_expires_at: { $lte: input.now },
            },
          ],
        },
        {
          $set: {
            status: 'HELD',
            hold_id: input.holdId,
            hold_partner_id: input.partnerId,
            hold_created_at: input.now,
            hold_expires_at: input.expiresAt,
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'SLOT_HELD',
                actor_type: 'PARTNER',
                actor_id: input.partnerId,
                previous_status: input.previousStatus as SlotStatus,
                new_status: 'HELD' as SlotStatus,
                reason: 'Partner booking hold',
                correlation_id: input.correlationId,
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
    },
    findConflictingSlot(input) {
      return slots().findOne(
        {
          court_id: input.courtId,
          environment: input.environment,
          starts_at: { $lt: input.endsAt },
          ends_at: { $gt: input.startsAt },
          $or: [
            { status: { $in: ['BOOKED', 'BLOCKED', 'UNAVAILABLE'] } },
            {
              status: 'HELD',
              hold_expires_at: { $gt: input.now },
            },
          ],
        },
        { session: input.session },
      );
    },
    async lockCourt(input) {
      const result = await database.db
        .collection<CourtDocument>('courts')
        .updateOne(
          {
            _id: input.courtId,
            version: input.version,
            status: 'AVAILABLE',
          },
          { $inc: { version: 1 }, $set: { updated_at: input.now } },
          { session: input.session },
        );
      return result.modifiedCount === 1;
    },
    async insertSlot(slot, session) {
      await slots().insertOne(slot, { session });
    },
    findHeldSlot(holdId, partnerId, environment, session) {
      return slots().findOne(
        {
          hold_id: holdId,
          hold_partner_id: partnerId,
          environment,
          status: 'HELD',
        },
        { session },
      );
    },
    confirmSlot(input) {
      return slots().findOneAndUpdate(
        {
          _id: input.slot._id,
          status: 'HELD',
          version: input.slot.version,
          hold_id: input.slot.hold_id,
          hold_partner_id: input.partnerId,
          hold_expires_at: { $gt: input.now },
          booking_id: null,
        },
        {
          $set: {
            status: 'BOOKED',
            booking_id: input.bookingId,
            hold_id: null,
            hold_partner_id: null,
            hold_expires_at: null,
            hold_created_at: null,
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'SLOT_BOOKED',
                actor_type: 'PARTNER',
                actor_id: input.partnerId,
                previous_status: 'HELD' as SlotStatus,
                new_status: 'BOOKED' as SlotStatus,
                reason: 'Booking confirmed',
                correlation_id: input.correlationId,
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
    },
    getIdempotency(partnerId, environment, key, operation, session) {
      return idempotency().findOne(
        {
          partner_id: partnerId,
          environment,
          idempotency_key: key,
          operation,
        },
        { ...(session ? { session } : {}) },
      );
    },
    async insertIdempotency(record, session) {
      await idempotency().insertOne(record, { session });
    },
    async insertBooking(booking, session) {
      await bookings().insertOne(booking, { session });
    },
    findBooking(id, partnerId, environment, session) {
      return bookings().findOne(
        { _id: id, partner_id: partnerId, environment },
        { session },
      );
    },
    cancelBooking(input) {
      return bookings().findOneAndUpdate(
        {
          _id: input.booking._id,
          partner_id: input.booking.partner_id,
          environment: input.booking.environment,
          status: 'CONFIRMED',
          version: input.booking.version,
        },
        {
          $set: {
            status: 'CANCELLED',
            cancelled_at: input.now,
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'BOOKING_CANCELLED',
                actor_type: 'PARTNER',
                actor_id: input.booking.partner_id,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: 'CONFIRMED',
                  new_status: 'CANCELLED',
                  reason_code: input.reasonCode,
                  reason_text: input.reasonText,
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
    async disposeSlot(input) {
      const nextStatus =
        input.disposition === 'RELEASE_TO_INVENTORY'
          ? 'AVAILABLE'
          : 'UNAVAILABLE';
      const update: UpdateFilter<SlotDocument> = {
        $set: {
          status: nextStatus,
          booking_id: null,
          hold_id: null,
          hold_partner_id: null,
          hold_expires_at: null,
          hold_created_at: null,
          updated_at: input.now,
        },
        $inc: { version: 1 },
        $push: {
          audit_history: {
            $each: [{
              event_type:
                nextStatus === 'AVAILABLE'
                  ? 'SLOT_RELEASED'
                  : 'SLOT_UNAVAILABLE',
              actor_type: 'PARTNER',
              actor_id: input.booking.partner_id,
              previous_status: 'BOOKED' as SlotStatus,
              new_status: nextStatus as SlotStatus,
              reason: 'Booking cancelled',
              correlation_id: input.correlationId,
              occurred_at: input.now,
            }],
            $slice: -100,
          },
        },
      };
      const result = await slots().updateOne(
        {
          _id: input.booking.slot_id,
          booking_id: input.booking._id,
          status: 'BOOKED',
        },
        update,
        { session: input.session },
      );
      return result.modifiedCount === 1;
    },
    async insertCancellation(cancellation, session) {
      await database.db
        .collection<BookingCancellationDocument>('booking_cancellations')
        .insertOne(cancellation, { session });
    },
    async recoverExpiredHolds(now) {
      const fixed = await slots().updateMany(
        {
          booking_type: 'FIXED_SLOT',
          status: 'HELD',
          hold_expires_at: { $lte: now },
          booking_id: null,
        },
        {
          $set: {
            status: 'AVAILABLE',
            hold_id: null,
            hold_partner_id: null,
            hold_expires_at: null,
            hold_created_at: null,
            updated_at: now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'HOLD_EXPIRED',
                actor_type: 'SYSTEM',
                actor_id: null,
                previous_status: 'HELD',
                new_status: 'AVAILABLE',
                reason: 'Hold expired',
                correlation_id: 'hold-recovery',
                occurred_at: now,
              }],
              $slice: -100,
            },
          },
        },
      );
      const open = await slots().deleteMany({
        booking_type: 'OPEN_TIME',
        source: 'BOOKING',
        status: 'HELD',
        hold_expires_at: { $lte: now },
        booking_id: null,
      });
      return {
        fixedReleased: fixed.modifiedCount,
        openReleased: open.deletedCount,
      };
    },
    findBookingAudit(id) {
      return bookings().findOne({ _id: id });
    },
  };
}
