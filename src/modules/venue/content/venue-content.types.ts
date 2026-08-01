import type { ObjectId } from 'mongodb';

export interface VenueContentDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  locale: string;
  content: Record<string, unknown>;
  version: number;
  updated_by_type: 'VENUE_OWNER';
  updated_by_id: ObjectId;
  created_at: Date;
  updated_at: Date;
}
