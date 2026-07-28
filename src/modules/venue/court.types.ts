import type { ObjectId } from 'mongodb';

import type {
  VenueAuditDocument,
  VenueMediaDocument,
} from './venue.types.js';

export type CourtBookingMode = 'OPEN_TIME' | 'FIXED_SLOT' | 'BOTH';
export type CourtStatus = 'ACTIVE' | 'INACTIVE';

export interface CourtOperatingHourDocument {
  day_of_week: number;
  opens_at: string;
  closes_at: string;
}

export interface CourtDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  name: string;
  sport_types: string[];
  booking_mode: CourtBookingMode;
  min_booking_minutes: number;
  booking_increment_minutes: number;
  operating_hours: CourtOperatingHourDocument[];
  timezone: string;
  media: VenueMediaDocument[];
  status: CourtStatus;
  audit_history: VenueAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}
