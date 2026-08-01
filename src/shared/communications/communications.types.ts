import type { ObjectId } from 'mongodb';

export const EXTERNAL_EVENT_TYPES = [
  'booking.confirmed',
  'booking.cancelled',
  'settlement.created',
  'settlement.completed',
  'payout.pending',
  'payout.completed',
  'payout.failed',
  'contract.proposed',
  'contract.accepted',
  'kyc.submitted',
  'kyc.verified',
  'kyc.rejected',
  'payment.recorded',
  'payment.refunded',
  'venue.updated',
  'court.updated',
  'inventory.changed',
  'remittance.required',
  'remittance.received',
  'payout.reversed',
] as const;

export type ExternalEventType = (typeof EXTERNAL_EVENT_TYPES)[number];
export type CommunicationsEnvironment = 'SANDBOX' | 'PRODUCTION';
export type DeliveryStatus = 'PENDING' | 'RETRYING' | 'DELIVERED' | 'FAILED';
export type DevicePlatform = 'ANDROID' | 'IOS' | 'WEB';
export type OwnerNotificationType =
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_CANCELLED'
  | 'PAYOUT_PENDING'
  | 'PAYOUT_COMPLETED'
  | 'PAYOUT_FAILED'
  | 'SETTLEMENT_CREATED'
  | 'SETTLEMENT_COMPLETED'
  | 'CONTRACT_PROPOSED'
  | 'CONTRACT_ACCEPTED'
  | 'KYC_SUBMITTED'
  | 'KYC_VERIFIED'
  | 'KYC_REJECTED'
  | 'PAYMENT_RECORDED'
  | 'PAYMENT_REFUNDED'
  | 'VENUE_UPDATED'
  | 'COURT_UPDATED'
  | 'AVAILABILITY_CHANGED';

export type OwnerNotificationAggregateType =
  | 'BOOKING' | 'PAYMENT' | 'SETTLEMENT' | 'PAYOUT' | 'CONTRACT'
  | 'KYC' | 'VENUE' | 'COURT' | 'INVENTORY';

export interface FcmTokenDocument {
  token: string;
  device_id: string;
  platform: DevicePlatform;
  last_seen_at: Date;
  created_at: Date;
}

export interface OwnerNotificationDocument {
  notification_type: OwnerNotificationType;
  aggregate_type: OwnerNotificationAggregateType;
  aggregate_id: ObjectId;
  venue_id: ObjectId;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export interface WebhookAttemptDocument {
  attempted_at: Date;
  request_payload: string;
  redacted_headers: Record<string, string>;
  response_code: number | null;
  response_payload: string | null;
  error: string | null;
  completed_at: Date;
}

export interface WebhookDeliveryDocument {
  endpoint_id: ObjectId;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  delivered_at: Date | null;
  attempts: WebhookAttemptDocument[];
  created_at: Date;
  updated_at: Date;
}

export interface OutboxEventDocument {
  _id: ObjectId;
  aggregate_type: string;
  aggregate_id: ObjectId;
  partner_id: ObjectId | null;
  venue_id: ObjectId | null;
  environment: CommunicationsEnvironment;
  event_type: string;
  event_version: number;
  correlation_id: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  available_at: Date;
  locked_by: string | null;
  locked_until: Date | null;
  webhook_endpoint_ids: ObjectId[];
  published_at: Date | null;
  webhook_deliveries: WebhookDeliveryDocument[];
  created_at: Date;
  updated_at: Date;
}

export interface WebhookEnvelope {
  id: string;
  eventType: ExternalEventType;
  eventVersion: number;
  occurredAt: string;
  environment: CommunicationsEnvironment;
  aggregate: { type: string; id: string };
  correlationId: string;
  data: Record<string, unknown>;
}

export function externalEventType(value: string): ExternalEventType {
  const mapped: Record<string, ExternalEventType> = {
    BOOKING_CONFIRMED: 'booking.confirmed',
    BOOKING_CANCELLED: 'booking.cancelled',
    SETTLEMENT_DRAFT_CREATED: 'settlement.created',
    SETTLEMENT_COMPLETED: 'settlement.completed',
    PAYOUT_PENDING: 'payout.pending',
    PAYOUT_PAID: 'payout.completed',
    PAYOUT_FAILED: 'payout.failed',
    CONTRACT_PROPOSED: 'contract.proposed',
    CONTRACT_ACCEPTED: 'contract.accepted',
    KYC_SUBMITTED: 'kyc.submitted',
    KYC_VERIFIED: 'kyc.verified',
    KYC_REJECTED: 'kyc.rejected',
    PAYMENT_RECORDED: 'payment.recorded',
    PAYMENT_REFUNDED: 'payment.refunded',
    VENUE_UPDATED: 'venue.updated',
    COURT_UPDATED: 'court.updated',
    AVAILABILITY_CHANGED: 'inventory.changed',
    REMITTANCE_REQUIRED: 'remittance.required',
    REMITTANCE_RECEIVED: 'remittance.received',
    PAYOUT_REVERSED: 'payout.reversed',
  };
  const result = mapped[value];
  if (!result) throw new Error(`Unsupported Communications event: ${value}`);
  return result;
}
