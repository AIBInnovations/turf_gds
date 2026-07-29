import type { ClientSession, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  AddressDocument,
  VenueDocument,
  VenueMediaDocument,
} from './venue.types.js';

export interface VenueRepository {
  insertInitialVenue(
    venue: VenueDocument,
    session: ClientSession,
  ): Promise<void>;
  approveVenue(input: {
    venueId: ObjectId;
    adminId: ObjectId;
    correlationId: string;
    now: Date;
    session: ClientSession;
  }): Promise<boolean>;
  findById(venueId: ObjectId): Promise<VenueDocument | null>;
  updateProfile(input: {
    venueId: ObjectId;
    expectedVersion: number;
    actorOwnerId: ObjectId;
    correlationId: string;
    changes: {
      legal_name?: string;
      display_name?: string;
      timezone?: string;
      address?: AddressDocument;
      geo?: {
        type: 'Point';
        coordinates: [number, number];
      };
    };
    changedFields: string[];
    now: Date;
  }): Promise<VenueDocument | null>;
  appendMedia(input: {
    venueId: ObjectId;
    expectedVersion: number;
    actorOwnerId: ObjectId;
    correlationId: string;
    media: VenueMediaDocument;
    now: Date;
  }): Promise<VenueDocument | null>;
}

export function createVenueRepository(
  database: DatabaseConnection,
): VenueRepository {
  async function insertInitialVenue(
    venue: VenueDocument,
    session: ClientSession,
  ): Promise<void> {
    await database.db
      .collection<VenueDocument>('venues')
      .insertOne(venue, { session });
  }

  async function approveVenue(
    input: Parameters<VenueRepository['approveVenue']>[0],
  ): Promise<boolean> {
    const result = await database.db
      .collection<VenueDocument>('venues')
      .updateOne(
        { _id: input.venueId, status: 'PENDING' },
        {
          $set: {
            status: 'ACTIVE',
            updated_at: input.now,
          },
          $inc: { version: 1 },
          $push: {
            audit_history: {
              $each: [{
                event_type: 'VENUE_APPROVED',
                actor_type: 'ADMIN',
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { session: input.session },
      );

    return result.modifiedCount > 0;
  }

  async function findById(
    venueId: ObjectId,
  ): Promise<VenueDocument | null> {
    return database.db
      .collection<VenueDocument>('venues')
      .findOne({ _id: venueId });
  }

  async function updateProfile(
    input: Parameters<VenueRepository['updateProfile']>[0],
  ): Promise<VenueDocument | null> {
    return database.db
      .collection<VenueDocument>('venues')
      .findOneAndUpdate(
        {
          _id: input.venueId,
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
                event_type: 'VENUE_PROFILE_UPDATED',
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
        { returnDocument: 'after' },
      );
  }

  async function appendMedia(
    input: Parameters<VenueRepository['appendMedia']>[0],
  ): Promise<VenueDocument | null> {
    return database.db
      .collection<VenueDocument>('venues')
      .findOneAndUpdate(
        {
          _id: input.venueId,
          version: input.expectedVersion,
          'media.19': { $exists: false },
        },
        {
          $set: { updated_at: input.now },
          $inc: { version: 1 },
          $push: {
            media: {
              $each: [input.media],
            },
            audit_history: {
              $each: [{
                event_type: 'VENUE_MEDIA_ADDED',
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
  }

  return {
    insertInitialVenue,
    approveVenue,
    findById,
    updateProfile,
    appendMedia,
  };
}
