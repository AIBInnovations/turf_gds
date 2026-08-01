import type { ObjectId } from 'mongodb';

export interface OnboardingRefundRule { min_minutes_before_start: number; refund_bps: number }
export interface VenueOnboardingAgreementDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  owner_id: ObjectId;
  title: string;
  terms_text: string;
  template_id: ObjectId | null;
  template_version: number | null;
  terms_hash: string;
  platform_commission_bps: number;
  settlement_cycle: 'T_PLUS_N' | 'WEEKLY' | 'MONTHLY';
  settlement_lag_days: number;
  cancellation_policy: {
    cancellation_allowed: boolean;
    default_refund_bps: number;
    no_show_refund_bps: number;
    owner_cancellation_notice_minutes: number;
    refund_rules: OnboardingRefundRule[];
  };
  status: 'PROPOSED' | 'CHANGES_REQUESTED' | 'ACCEPTED' | 'SUPERSEDED';
  version: number;
  proposed_by: ObjectId;
  proposed_at: Date;
  accepted_by: ObjectId | null;
  accepted_at: Date | null;
  acceptance_ip: string | null;
  acceptance_user_agent: string | null;
  audit_history: unknown[];
  created_at: Date;
  updated_at: Date;
}
