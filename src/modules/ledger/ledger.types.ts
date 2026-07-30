import type { ObjectId } from 'mongodb';

export type LedgerEnvironment = 'SANDBOX' | 'PRODUCTION';
export type LedgerEntryType =
  | 'BOOKING'
  | 'COMMISSION'
  | 'TAX'
  | 'REFUND'
  | 'REVERSAL'
  | 'ADJUSTMENT';
export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryDocument {
  _id: ObjectId;
  booking_id: ObjectId;
  partner_id: ObjectId;
  venue_id: ObjectId;
  contract_id: ObjectId;
  settlement_id: ObjectId | null;
  payout_id: ObjectId | null;
  reverses_entry_id: ObjectId | null;
  environment: LedgerEnvironment;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount_minor: number;
  currency: 'INR';
  effective_at: Date;
  correlation_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface LedgerBookingSnapshot {
  bookingId: ObjectId;
  partnerId: ObjectId;
  venueId: ObjectId;
  contractId: ObjectId;
  environment: LedgerEnvironment;
  grossAmountMinor: number;
  commissionAmountMinor: number;
  taxAmountMinor: number;
  venueNetAmountMinor: number;
}
