import type { ObjectId } from 'mongodb';

export type BookingEnvironment = 'SANDBOX' | 'PRODUCTION';
export type BookingType = 'OPEN_TIME' | 'FIXED_SLOT';
export type BookingStatus =
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'DISPUTED';

export interface BookingAuditDocument {
  event_type: string;
  actor_type: 'ADMIN' | 'VENUE' | 'PARTNER' | 'SYSTEM';
  actor_id: ObjectId | null;
  correlation_id: string;
  changes: Record<string, unknown>;
  occurred_at: Date;
}

export interface BookingDocument {
  _id: ObjectId;
  slot_id: ObjectId;
  contract_id: ObjectId;
  partner_id: ObjectId;
  venue_id: ObjectId;
  court_id: ObjectId;
  environment: BookingEnvironment;
  booking_type: BookingType;
  starts_at: Date;
  ends_at: Date;
  external_booking_reference: string | null;
  confirm_idempotency_key: string;
  customer_reference: string | null;
  partner_payment_reference: string | null;
  status: BookingStatus;
  gross_amount_minor: number;
  commission_amount_minor: number;
  tax_amount_minor: number;
  venue_net_amount_minor: number;
  currency: 'INR';
  cancellation_terms_snapshot: Record<string, unknown>;
  confirmed_at: Date;
  cancelled_at: Date | null;
  audit_history: BookingAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface BookingCancellationDocument {
  _id: ObjectId;
  booking_id: ObjectId;
  requested_by_type: 'PARTNER' | 'VENUE' | 'PLATFORM' | 'SYSTEM';
  requested_by_id: ObjectId | null;
  reason_code: string;
  reason_text: string | null;
  refund_percent: number;
  refund_amount_minor: number;
  slot_disposition: 'RELEASE_TO_INVENTORY' | 'KEEP_UNAVAILABLE';
  idempotency_key: string;
  cancelled_at: Date;
  created_at: Date;
}

export interface ApiIdempotencyRecordDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: BookingEnvironment;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  response_status: number;
  response_body: Record<string, unknown> | null;
  resource_type: string | null;
  resource_id: ObjectId | null;
  expires_at: Date;
  created_at: Date;
}
