import {
  ObjectId,
  type ClientSession,
  type Filter,
  type UpdateFilter,
} from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { archiveAuditEvent } from '../../shared/audit/audit.persistence.js';
import type { PartnerVenueContractDocument } from '../contracts/contract.types.js';
import type { CourtDocument } from '../venue/courts/court.types.js';
import type {
  PricingRuleDocument,
  SlotAuditDocument,
  SlotDocument,
  SlotStatus,
} from '../venue/inventory/inventory.types.js';
import {
  consumeFixedSlots,
  restoreConsumedFixedSlots,
} from '../venue/inventory/slot-consumption.js';
import { queryOverlappingSlots } from '../venue/inventory/slot-overlap.js';
import type { VenueDocument } from '../venue/profile/venue.types.js';
import type {
  ApiIdempotencyRecordDocument,
  BookingCancellationDocument,
  BookingDocument,
} from './booking.types.js';

export interface RecoverExpiredHoldsInput {
  now: Date;
  /** Slots per transaction. */
  batchSize: number;
  /** Transactions per invocation; bounds one pass's total work. */
  maxBatches: number;
}

export interface RecoverExpiredHoldsResult {
  fixedReleased: number;
  openReleased: number;
  /** Committed transactions. */
  batches: number;
  /** Candidates read; a CAS may still have skipped some of them. */
  scanned: number;
  /** True when maxBatches was reached, meaning a backlog remains. */
  exhausted: boolean;
}

export interface BookingLifecycleRepository {
  findVenue(
    id: ObjectId,
    session: ClientSession,
  ): Promise<VenueDocument | null>;
  findCourt(
    id: ObjectId,
    session: ClientSession,
  ): Promise<CourtDocument | null>;
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
    /**
     * Consumer slot ids whose holds have expired. A FIXED_SLOT consumed by one
     * of these is reclaimable even though it is still UNAVAILABLE, so a claim
     * does not have to wait for the reaper.
     */
    allowConsumedBySlotIds: readonly ObjectId[];
    correlationId: string;
    session: ClientSession;
  }): Promise<SlotDocument | null>;
  /**
   * Every slot overlapping the interval, whatever its booking type or status.
   * Callers classify with `classifyOverlap`; see `slot-overlap.ts`.
   */
  findOverlappingSlots(input: {
    courtId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    startsAt: Date;
    endsAt: Date;
    session: ClientSession;
  }): Promise<SlotDocument[]>;
  lockCourt(input: {
    courtId: ObjectId;
    version: number;
    now: Date;
    session: ClientSession;
  }): Promise<boolean>;
  insertSlot(slot: SlotDocument, session: ClientSession): Promise<void>;
  /** Mark overlapping FIXED_SLOTs as consumed by a new OPEN_TIME slot. */
  consumeFixedSlots(input: {
    courtId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    consumerSlotId: ObjectId;
    fixedSlotIds: readonly ObjectId[];
    staleConsumerIds: readonly ObjectId[];
    partnerId: ObjectId;
    correlationId: string;
    now: Date;
    session: ClientSession;
  }): Promise<number>;
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
  insertBooking(
    booking: BookingDocument,
    session: ClientSession,
  ): Promise<void>;
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
  recoverExpiredHolds(
    input: RecoverExpiredHoldsInput,
  ): Promise<RecoverExpiredHoldsResult>;
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
        .find(
          {
            partner_id: partnerId,
            venue_id: venueId,
            status: 'ACTIVE',
            effective_from: { $lte: at },
            $or: [{ effective_to: null }, { effective_to: { $gt: at } }],
          },
          { session },
        )
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
    async claimFixedHold(input) {
      const result = await slots().findOneAndUpdate(
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
            ...(input.allowConsumedBySlotIds.length > 0
              ? [
                  {
                    status: 'UNAVAILABLE' as const,
                    consumed_by_slot_id: {
                      $in: [...input.allowConsumedBySlotIds],
                    },
                  },
                ]
              : []),
          ],
        },
        {
          $set: {
            status: 'HELD',
            hold_id: input.holdId,
            hold_partner_id: input.partnerId,
            hold_created_at: input.now,
            hold_expires_at: input.expiresAt,
            consumed_by_slot_id: null,
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [
                {
                  event_type: 'SLOT_HELD',
                  actor_type: 'PARTNER',
                  actor_id: input.partnerId,
                  previous_status: input.previousStatus as SlotStatus,
                  new_status: 'HELD' as SlotStatus,
                  reason: 'Partner booking hold',
                  correlation_id: input.correlationId,
                  occurred_at: input.now,
                },
              ],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
      if (result) {
        await archiveLatest(database, 'SLOT', result, input.session);
      }
      return result;
    },
    findOverlappingSlots(input) {
      return queryOverlappingSlots(
        database.db,
        {
          courtId: input.courtId,
          environment: input.environment,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
        input.session,
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
      await archiveLatest(database, 'SLOT', slot, session);
    },
    consumeFixedSlots(input) {
      return consumeFixedSlots({
        db: database.db,
        courtId: input.courtId,
        environment: input.environment,
        consumerSlotId: input.consumerSlotId,
        fixedSlotIds: input.fixedSlotIds,
        staleConsumerIds: input.staleConsumerIds,
        actorType: 'PARTNER',
        actorId: input.partnerId,
        reason: 'Consumed by Partner open-time hold',
        correlationId: input.correlationId,
        now: input.now,
        session: input.session,
      });
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
    async confirmSlot(input) {
      const result = await slots().findOneAndUpdate(
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
              $each: [
                {
                  event_type: 'SLOT_BOOKED',
                  actor_type: 'PARTNER',
                  actor_id: input.partnerId,
                  previous_status: 'HELD' as SlotStatus,
                  new_status: 'BOOKED' as SlotStatus,
                  reason: 'Booking confirmed',
                  correlation_id: input.correlationId,
                  occurred_at: input.now,
                },
              ],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
      if (result) {
        await archiveLatest(database, 'SLOT', result, input.session);
      }
      return result;
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
      await archiveLatest(database, 'BOOKING', booking, session);
    },
    findBooking(id, partnerId, environment, session) {
      return bookings().findOne(
        { _id: id, partner_id: partnerId, environment },
        { session },
      );
    },
    async cancelBooking(input) {
      const result = await bookings().findOneAndUpdate(
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
              $each: [
                {
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
                },
              ],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after', session: input.session },
      );
      if (result) {
        await archiveLatest(database, 'BOOKING', result, input.session);
      }
      return result;
    },
    async disposeSlot(input) {
      const slotId = input.booking.slot_id ?? new ObjectId();
      const nextStatus =
        input.disposition === 'RELEASE_TO_INVENTORY'
          ? 'AVAILABLE'
          : 'UNAVAILABLE';
      const booked = await slots().findOne(
        { _id: slotId, booking_id: input.booking._id, status: 'BOOKED' },
        { session: input.session },
      );
      if (!booked) return false;

      // Releasing an open-time booking retires its slot entirely, matching
      // recoverExpiredHolds. Leaving an AVAILABLE husk behind would collide
      // with uq_slots_court_mode_interval the next time the same interval is
      // booked, surfacing as an unhandled duplicate-key error.
      if (
        input.disposition === 'RELEASE_TO_INVENTORY' &&
        booked.booking_type === 'OPEN_TIME' &&
        booked.source === 'BOOKING'
      ) {
        await restoreConsumedFixedSlots({
          db: database.db,
          courtId: booked.court_id,
          consumerSlotId: booked._id,
          actorType: 'PARTNER',
          actorId: input.booking.partner_id,
          reason: 'Partner booking cancelled',
          correlationId: input.correlationId,
          now: input.now,
          session: input.session,
        });
        await archiveAuditEvent({
          db: database.db,
          aggregateType: 'SLOT',
          aggregateId: booked._id,
          environment: booked.environment,
          event: {
            event_type: 'SLOT_RELEASED',
            actor_type: 'PARTNER',
            actor_id: input.booking.partner_id,
            previous_status: 'BOOKED',
            new_status: 'AVAILABLE',
            reason: 'Booking cancelled',
            correlation_id: input.correlationId,
            occurred_at: input.now,
          },
          session: input.session,
        });
        const deleted = await slots().deleteOne(
          { _id: booked._id, booking_id: input.booking._id, status: 'BOOKED' },
          { session: input.session },
        );
        return deleted.deletedCount === 1;
      }

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
            $each: [
              {
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
              },
            ],
            $slice: -100,
          },
        },
      };
      const result = await slots().updateOne(
        { _id: slotId, booking_id: input.booking._id, status: 'BOOKED' },
        update,
        { session: input.session },
      );
      if (result.modifiedCount === 1) {
        const slot = await slots().findOne(
          { _id: slotId },
          { session: input.session },
        );
        if (slot) await archiveLatest(database, 'SLOT', slot, input.session);
      }
      return result.modifiedCount === 1;
    },
    async insertCancellation(cancellation, session) {
      await database.db
        .collection<BookingCancellationDocument>('booking_cancellations')
        .insertOne(cancellation, { session });
    },
    async recoverExpiredHolds(input) {
      const totals = {
        fixedReleased: 0,
        openReleased: 0,
        batches: 0,
        scanned: 0,
        exhausted: false,
      };
      let cursor: { expiresAt: Date; id: ObjectId } | undefined;

      for (let batch = 0; batch < input.maxBatches; batch += 1) {
        // Read outside the transaction. Every mutation below is still a
        // version-guarded CAS, so a slot that changed between the read and the
        // write is simply skipped rather than clobbered. Keeping the scan out
        // of the transaction is what bounds its size and duration.
        const expired = await slots()
          .find(expiredHoldFilter(input.now, cursor))
          .sort({ hold_expires_at: 1, _id: 1 })
          .limit(input.batchSize)
          .toArray();
        if (expired.length === 0) break;

        // Counters live inside the callback: withTransaction retries the whole
        // callback on a transient error, so accumulating outside it would
        // double-count every replayed slot.
        const released = await database.withTransaction(async ({ session }) => {
          let fixed = 0;
          let open = 0;
          for (const slot of expired) {
            const outcome = await releaseExpiredHold({
              database,
              slot,
              now: input.now,
              session,
            });
            if (outcome === 'FIXED_RELEASED') fixed += 1;
            else if (outcome === 'OPEN_DELETED') open += 1;
          }
          return { fixed, open };
        });

        totals.fixedReleased += released.fixed;
        totals.openReleased += released.open;
        totals.scanned += expired.length;
        totals.batches += 1;
        const last = expired[expired.length - 1]!;
        cursor = { expiresAt: last.hold_expires_at!, id: last._id };
        if (expired.length < input.batchSize) break;
        if (batch === input.maxBatches - 1) totals.exhausted = true;
      }

      return totals;
    },
    findBookingAudit(id) {
      return bookings().findOne({ _id: id });
    },
  };
}

/**
 * Expired holds after `cursor`, keyset-ordered by (hold_expires_at, _id).
 * A CAS-skipped slot keeps matching this filter, so it is retried on the next
 * invocation rather than blocking progress through the batch.
 */
function expiredHoldFilter(
  now: Date,
  cursor?: { expiresAt: Date; id: ObjectId },
): Filter<SlotDocument> {
  const base = {
    status: 'HELD' as const,
    hold_expires_at: { $lte: now },
    booking_id: null,
  };
  if (!cursor) return base;
  return {
    ...base,
    $or: [
      { hold_expires_at: { $gt: cursor.expiresAt, $lte: now } },
      { hold_expires_at: cursor.expiresAt, _id: { $gt: cursor.id } },
    ],
  };
}

type HoldReleaseOutcome = 'FIXED_RELEASED' | 'OPEN_DELETED' | 'SKIPPED';

async function releaseExpiredHold(input: {
  database: DatabaseConnection;
  slot: SlotDocument;
  now: Date;
  session: ClientSession;
}): Promise<HoldReleaseOutcome> {
  const { database, slot, now, session } = input;
  const slots = database.db.collection<SlotDocument>('slots');
  const event = {
    event_type: 'HOLD_EXPIRED',
    actor_type: 'SYSTEM',
    actor_id: null,
    previous_status: 'HELD',
    new_status: 'AVAILABLE',
    reason: 'Hold expired',
    correlation_id: `hold-recovery:${slot._id.toHexString()}:${slot.version}`,
    occurred_at: now,
  } satisfies SlotAuditDocument;

  if (slot.booking_type === 'OPEN_TIME' && slot.source === 'BOOKING') {
    await restoreConsumedFixedSlots({
      db: database.db,
      courtId: slot.court_id,
      consumerSlotId: slot._id,
      actorType: 'SYSTEM',
      actorId: null,
      reason: 'Open-time hold expired',
      correlationId: event.correlation_id,
      now,
      session,
    });
    await archiveAuditEvent({
      db: database.db,
      aggregateType: 'SLOT',
      aggregateId: slot._id,
      environment: slot.environment,
      event,
      session,
    });
    const deleted = await slots.deleteOne(
      { _id: slot._id, status: 'HELD', version: slot.version },
      { session },
    );
    return deleted.deletedCount === 1 ? 'OPEN_DELETED' : 'SKIPPED';
  }

  const updated = await slots.findOneAndUpdate(
    { _id: slot._id, status: 'HELD', version: slot.version },
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
      $push: { audit_history: { $each: [event], $slice: -100 } },
    },
    { returnDocument: 'after', session },
  );
  if (!updated) return 'SKIPPED';
  await archiveLatest(database, 'SLOT', updated, session);
  return 'FIXED_RELEASED';
}

async function archiveLatest(
  database: DatabaseConnection,
  aggregateType: 'BOOKING' | 'SLOT',
  value: BookingDocument | SlotDocument,
  session?: ClientSession,
): Promise<void> {
  const event = value.audit_history.at(-1);
  if (!event) return;
  await archiveAuditEvent({
    db: database.db,
    aggregateType,
    aggregateId: value._id,
    environment: value.environment,
    event,
    ...(session ? { session } : {}),
  });
}
