import type { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  CourtBookingMode,
  CourtDocument,
  CourtOperatingHourDocument,
  CourtSportType,
  CourtStatus,
} from './court.types.js';
import type { VenueMediaDocument } from './venue.types.js';

export interface CourtRepository {
  insert(court: CourtDocument): Promise<void>;
  findByIdAndVenue(
    courtId: ObjectId,
    venueId: ObjectId,
  ): Promise<CourtDocument | null>;
  listByVenue(venueId: ObjectId): Promise<CourtDocument[]>;
  update(input: {
    courtId: ObjectId;
    venueId: ObjectId;
    expectedVersion: number;
    actorOwnerId: ObjectId;
    correlationId: string;
    changes: {
      name?: string;
      sport_type?: CourtSportType;
      surface_type?: string;
      capacity?: number;
      booking_mode?: CourtBookingMode;
      min_booking_minutes?: number;
      booking_increment_minutes?: number;
      fixed_slot_duration_minutes?: number | null;
      fixed_slot_anchor_minutes?: number | null;
      status?: CourtStatus;
      operating_hours?: { entries: CourtOperatingHourDocument[] };
    };
    changedFields: string[];
    now: Date;
  }): Promise<CourtDocument | null>;
  appendMedia(input: {
    courtId: ObjectId;
    venueId: ObjectId;
    expectedVersion: number;
    actorOwnerId: ObjectId;
    correlationId: string;
    media: VenueMediaDocument;
    now: Date;
  }): Promise<CourtDocument | null>;
}

export function createCourtRepository(
  database: DatabaseConnection,
): CourtRepository {
  const courts = () =>
    database.db.collection<CourtDocument>('courts');

  return {
    async insert(court) {
      await courts().insertOne(court);
    },
    findByIdAndVenue(courtId, venueId) {
      return courts().findOne({ _id: courtId, venue_id: venueId });
    },
    listByVenue(venueId) {
      return courts()
        .find({ venue_id: venueId })
        .collation({ locale: 'en', strength: 2 })
        .sort({ name: 1, _id: 1 })
        .toArray();
    },
    update(input) {
      return courts().findOneAndUpdate(
        {
          _id: input.courtId,
          venue_id: input.venueId,
          version: input.expectedVersion,
        },
        {
          $set: {
            ...input.changes,
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'COURT_UPDATED',
                actor_type: 'VENUE_OWNER',
                actor_id: input.actorOwnerId,
                correlation_id: input.correlationId,
                changed_fields: input.changedFields,
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        {
          returnDocument: 'after',
          collation: { locale: 'en', strength: 2 },
        },
      );
    },
    appendMedia(input) {
      return courts().findOneAndUpdate(
        {
          _id: input.courtId,
          venue_id: input.venueId,
          version: input.expectedVersion,
          'media.19': { $exists: false },
        },
        {
          $set: { updated_at: input.now },
          $inc: { version: 1 },
          $push: {
            media: { $each: [input.media] },
            audit_history: {
              $each: [{
                event_type: 'COURT_MEDIA_ADDED',
                actor_type: 'VENUE_OWNER',
                actor_id: input.actorOwnerId,
                correlation_id: input.correlationId,
                changed_fields: ['media'],
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
