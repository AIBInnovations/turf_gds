import type { ObjectId } from 'mongodb';

export type ContractBookingMode = 'OPEN_TIME' | 'FIXED_SLOT' | 'BOTH';
export type ContractStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'TERMINATED';
export type SettlementCycle = 'T_PLUS_N' | 'WEEKLY' | 'MONTHLY';

export interface CancellationTermsDocument {
  cancellation_allowed: boolean;
  default_refund_bps: number;
  release_inventory: boolean;
}

export interface RefundRuleDocument {
  min_minutes_before_start: number;
  refund_bps: number;
  release_inventory: boolean;
}

export interface RefundRulesDocument {
  rules: RefundRuleDocument[];
}

export interface ContractAuditDocument {
  event_type: string;
  actor_type: 'ADMIN';
  actor_id: ObjectId;
  correlation_id: string;
  changes: Record<string, unknown>;
  occurred_at: Date;
}

export interface PartnerVenueContractDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  venue_id: ObjectId;
  status: ContractStatus;
  settlement_cycle: SettlementCycle;
  settlement_lag_days: number;
  commission_rate_bps: number;
  tax_rate_bps: number;
  allowed_booking_modes: ContractBookingMode;
  cancellation_terms: CancellationTermsDocument;
  resale_cutoff_minutes: number;
  refund_rules: RefundRulesDocument;
  terms_version: number;
  effective_from: Date;
  effective_to: Date | null;
  audit_history: ContractAuditDocument[];
  created_at: Date;
  updated_at: Date;
}
