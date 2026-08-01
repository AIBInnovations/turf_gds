import type { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { VenueContentDocument } from './venue-content.types.js';

export interface VenueContentRepository {
  find(venueId: ObjectId, locale: string): Promise<VenueContentDocument | null>;
  save(input: {
    document: VenueContentDocument;
    expectedVersion: number | null;
  }): Promise<VenueContentDocument | null>;
}

export function createVenueContentRepository(database: DatabaseConnection): VenueContentRepository {
  const collection = () => database.db.collection<VenueContentDocument>('venue_contents');
  return {
    find: (venueId, locale) => collection().findOne({ venue_id: venueId, locale }),
    async save({ document, expectedVersion }) {
      if (expectedVersion === null) {
        try {
          await collection().insertOne(document);
          return document;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11_000) return null;
          throw error;
        }
      }
      return collection().findOneAndUpdate(
        { venue_id: document.venue_id, locale: document.locale, version: expectedVersion },
        { $set: {
          content: document.content,
          updated_by_type: document.updated_by_type,
          updated_by_id: document.updated_by_id,
          updated_at: document.updated_at,
        }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    },
  };
}
