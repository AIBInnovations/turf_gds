import type { Filter, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { archiveAuditEvent } from '../../shared/audit/audit.persistence.js';
import {
  consumeFixedSlots,
  restoreConsumedFixedSlots,
} from '../venue/inventory/slot-consumption.js';
import type { CourtDocument } from '../venue/courts/court.types.js';
import type { SlotDocument } from '../venue/inventory/inventory.types.js';
import { queryOverlappingSlots } from '../venue/inventory/slot-overlap.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
  BookingPaymentDocument,
  BookingStatus,
} from './booking.types.js';

export interface OwnerBookingFilters {
  courtId?: ObjectId;
  status?: BookingStatus;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export interface OwnerBookingRepository {
  listForVenue(
    venueId: ObjectId,
    filters: OwnerBookingFilters,
  ): Promise<{ bookings: BookingDocument[]; total: number }>;
  findForVenue(
    venueId: ObjectId,
    bookingId: ObjectId,
  ): Promise<BookingDocument | null>;
  findCancellation(
    bookingId: ObjectId,
  ): Promise<BookingCancellationDocument | null>;
  findPayment(
    venueId: ObjectId,
    bookingId: ObjectId,
  ): Promise<BookingPaymentDocument | null>;
  lockCourtForBooking(input: {
    courtId: ObjectId;
    venueId: ObjectId;
    expectedVersion: number;
    now: Date;
    session: import('mongodb').ClientSession;
  }): Promise<boolean>;
  /**
   * Every slot overlapping the interval, whatever its booking type or status.
   * Callers classify with `classifyOverlap`; see `slot-overlap.ts`.
   */
  findOverlappingSlots(input: {
    courtId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    startsAt: Date;
    endsAt: Date;
    session: import('mongodb').ClientSession;
  }): Promise<SlotDocument[]>;
  insertDirectSlot(
    slot: SlotDocument,
    session: import('mongodb').ClientSession,
  ): Promise<void>;
  /** Mark overlapping FIXED_SLOTs as consumed by a new OPEN_TIME slot. */
  consumeFixedSlots(input: {
    courtId: ObjectId;
    environment: 'SANDBOX' | 'PRODUCTION';
    consumerSlotId: ObjectId;
    fixedSlotIds: readonly ObjectId[];
    staleConsumerIds: readonly ObjectId[];
    actorOwnerId: ObjectId;
    correlationId: string;
    now: Date;
    session: import('mongodb').ClientSession;
  }): Promise<number>;
  insertDirectBooking(
    booking: BookingDocument,
    session: import('mongodb').ClientSession,
  ): Promise<void>;
  findForVenueWithSession(
    venueId: ObjectId,
    bookingId: ObjectId,
    session: import('mongodb').ClientSession,
  ): Promise<BookingDocument | null>;
  cancelOwnerBooking(input: {
    booking: BookingDocument;
    actorOwnerId: ObjectId;
    reasonCode: string;
    reasonText: string | null;
    correlationId: string;
    now: Date;
    session: import('mongodb').ClientSession;
  }): Promise<BookingDocument | null>;
  insertCancellation(
    cancellation: BookingCancellationDocument,
    session: import('mongodb').ClientSession,
  ): Promise<void>;
  releaseDirectSlot(input: {
    slotId: ObjectId;
    courtId: ObjectId;
    bookingId: ObjectId;
    now: Date;
    correlationId: string;
    actorOwnerId: ObjectId;
    session: import('mongodb').ClientSession;
  }): Promise<void>;
}

export function createOwnerBookingRepository(
  database: DatabaseConnection,
): OwnerBookingRepository {
  return {
    async listForVenue(venueId, filters) {
      const bookings = database.db.collection<BookingDocument>('bookings');
      const query: Filter<BookingDocument> = { venue_id: venueId };

      if (filters.courtId) {
        query.court_id = filters.courtId;
      }
      if (filters.status) {
        query.status = filters.status;
      }
      if (filters.from || filters.to) {
        query.starts_at = {
          ...(filters.from ? { $gte: filters.from } : {}),
          ...(filters.to ? { $lt: filters.to } : {}),
        };
      }

      const [results, total] = await Promise.all([
        bookings
          .find(query)
          .sort({ starts_at: 1, _id: 1 })
          .skip((filters.page - 1) * filters.limit)
          .limit(filters.limit)
          .toArray(),
        bookings.countDocuments(query),
      ]);

      return { bookings: results, total };
    },

    findForVenue(venueId, bookingId) {
      return database.db
        .collection<BookingDocument>('bookings')
        .findOne({ _id: bookingId, venue_id: venueId });
    },

    findCancellation(bookingId) {
      return database.db
        .collection<BookingCancellationDocument>('booking_cancellations')
        .findOne({ booking_id: bookingId });
    },
    findPayment(venueId, bookingId) {
      return database.db
        .collection<BookingPaymentDocument>('booking_payments')
        .findOne({ venue_id: venueId, booking_id: bookingId });
    },

    async lockCourtForBooking(input) {
      const result = await database.db
        .collection<CourtDocument>('courts')
        .updateOne(
          {
            _id: input.courtId,
            venue_id: input.venueId,
            version: input.expectedVersion,
            status: 'AVAILABLE',
          },
          { $inc: { version: 1 }, $set: { updated_at: input.now } },
          { session: input.session },
        );
      return result.modifiedCount === 1;
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

    async insertDirectSlot(slot, session) {
      await database.db
        .collection<SlotDocument>('slots')
        .insertOne(slot, { session });
    },

    consumeFixedSlots(input) {
      return consumeFixedSlots({
        db: database.db,
        courtId: input.courtId,
        environment: input.environment,
        consumerSlotId: input.consumerSlotId,
        fixedSlotIds: input.fixedSlotIds,
        staleConsumerIds: input.staleConsumerIds,
        actorType: 'VENUE_OWNER',
        actorId: input.actorOwnerId,
        reason: 'Consumed by Venue Owner direct booking',
        correlationId: input.correlationId,
        now: input.now,
        session: input.session,
      });
    },

    async insertDirectBooking(booking, session) {
      await database.db
        .collection<BookingDocument>('bookings')
        .insertOne(booking, { session });
    },

    findForVenueWithSession(venueId, bookingId, session) {
      return database.db
        .collection<BookingDocument>('bookings')
        .findOne({ _id: bookingId, venue_id: venueId }, { session });
    },

    async cancelOwnerBooking(input) {
      return database.db
        .collection<BookingDocument>('bookings')
        .findOneAndUpdate(
          {
            _id: input.booking._id,
            venue_id: input.booking.venue_id,
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
                    actor_type: 'VENUE' as const,
                    actor_id: input.actorOwnerId,
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
    },

    async insertCancellation(cancellation, session) {
      await database.db
        .collection<BookingCancellationDocument>('booking_cancellations')
        .insertOne(cancellation, { session });
    },

    async releaseDirectSlot(input) {
      const slots = database.db.collection<SlotDocument>('slots');
      const booked = await slots.findOne(
        { _id: input.slotId, booking_id: input.bookingId, status: 'BOOKED' },
        { session: input.session },
      );
      if (!booked) return;

      await restoreConsumedFixedSlots({
        db: database.db,
        courtId: input.courtId,
        consumerSlotId: booked._id,
        actorType: 'VENUE_OWNER',
        actorId: input.actorOwnerId,
        reason: 'Owner booking cancelled',
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
          actor_type: 'VENUE_OWNER',
          actor_id: input.actorOwnerId,
          previous_status: 'BOOKED',
          new_status: 'AVAILABLE',
          reason: 'Owner booking cancelled',
          correlation_id: input.correlationId,
          occurred_at: input.now,
        },
        session: input.session,
      });
      // Retire the slot rather than leaving an AVAILABLE husk, which would
      // collide with uq_slots_court_mode_interval on the next booking of the
      // same interval.
      await slots.deleteOne(
        { _id: booked._id, booking_id: input.bookingId, status: 'BOOKED' },
        { session: input.session },
      );
    },
  };
}
