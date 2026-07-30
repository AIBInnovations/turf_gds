import type { ObjectId } from 'mongodb';

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
  verification_method: 'PENNY_DROP' | 'MANUAL';
  audit_history: unknown[];
  created_at: Date;
  updated_at: Date;
}
