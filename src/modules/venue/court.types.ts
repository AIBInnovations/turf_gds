import type { ObjectId } from 'mongodb';

import type { VenueAuditDocument, VenueMediaDocument } from './venue.types.js';

export type CourtBookingMode = 'OPEN_TIME' | 'FIXED_SLOT' | 'BOTH';
export type CourtStatus = 'AVAILABLE' | 'UNAVAILABLE';
export type CourtSportType =
  | 'FOOTBALL'
  | 'CRICKET'
  | 'BADMINTON'
  | 'TENNIS'
  | 'PICKLEBALL'
  | 'MULTI_SPORT'
  | 'OTHER';

export interface CourtOperatingHourDocument {
  day_of_week: number;
  opens_at: string;
  closes_at: string;
}

export interface CourtDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  name: string;
  sport_type: CourtSportType;
  surface_type: string;
  capacity: number;
  status: CourtStatus;
  booking_mode: CourtBookingMode;
  operating_hours: { entries: CourtOperatingHourDocument[] };
  min_booking_minutes: number;
  booking_increment_minutes: number;
  fixed_slot_duration_minutes: number | null;
  fixed_slot_anchor_minutes: number | null;
  media: VenueMediaDocument[];
  audit_history: VenueAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}
