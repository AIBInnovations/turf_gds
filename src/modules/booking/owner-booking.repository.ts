import type { Filter, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
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
  };
}
