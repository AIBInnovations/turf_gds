import type { Document, ObjectId } from 'mongodb';

export interface PricingRuleDocument {
  _id: ObjectId;
  court_id: ObjectId;
  name: string;
  days_of_week: number[];
  starts_time: string;
  ends_time: string;
  amount_minor: number;
  currency: 'INR';
  effective_from: Date;
  effective_to: Date | null;
  priority: number;
  status: 'ACTIVE' | 'INACTIVE';
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
  environment: 'SANDBOX' | 'PRODUCTION';
  booking_mode: 'OPEN_TIME' | 'FIXED_SLOT';
  starts_at: Date;
  ends_at: Date;
  price_amount_minor: number;
  currency: 'INR';
  status: SlotStatus;
  hold_id: string | null;
  hold_partner_id: ObjectId | null;
  hold_expires_at: Date | null;
  hold_created_at: Date | null;
  generation_source: string;
  audit_history: SlotAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface VenueContentDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  content: Document;
  version: number;
  updated_by_type: 'ADMIN_USER' | 'VENUE_OWNER';
  updated_by_id: ObjectId;
  created_at: Date;
  updated_at: Date;
}

export interface VenuePayoutAccountDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  account_holder_name: string;
  vault_provider: string;
  vault_account_token: string;
  account_last4: string;
  bank_name: string;
  ifsc_code: string;
  status: 'PENDING' | 'VERIFIED' | 'DISABLED';
  verified_by: ObjectId | null;
  verified_at: Date | null;
  verification_failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
