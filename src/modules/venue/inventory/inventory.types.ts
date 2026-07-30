import type { ObjectId } from 'mongodb';

export interface PricingRuleDocument {
  _id: ObjectId;
  court_id: ObjectId;
  name: string;
  day_of_week: number | null;
  start_time: string | null;
  end_time: string | null;
  price_minor: number;
  currency: 'INR';
  effective_from: Date;
  effective_to: Date | null;
  priority: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export type SlotStatus =
  | 'AVAILABLE'
  | 'HELD'
  | 'BOOKED'
  | 'BLOCKED'
  | 'UNAVAILABLE';

export interface SlotAuditDocument {
  event_type: string;
  actor_type: 'VENUE_OWNER' | 'SYSTEM' | 'PARTNER' | 'ADMIN';
  actor_id: ObjectId | null;
  previous_status: SlotStatus | null;
  new_status: SlotStatus;
  reason: string;
  correlation_id: string;
  occurred_at: Date;
}

export interface SlotDocument {
  _id: ObjectId;
  court_id: ObjectId;
  venue_id: ObjectId;
  environment: 'SANDBOX' | 'PRODUCTION';
  booking_type: 'OPEN_TIME' | 'FIXED_SLOT';
  starts_at: Date;
  ends_at: Date;
  price_minor: number | null;
  currency: 'INR';
  status: SlotStatus;
  hold_id: string | null;
  hold_partner_id: ObjectId | null;
  hold_expires_at: Date | null;
  hold_created_at: Date | null;
  source: 'SYSTEM_GENERATED' | 'OWNER_DASHBOARD' | 'ADMIN' | 'BOOKING';
  booking_id: ObjectId | null;
  audit_history: SlotAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}
