import type { ObjectId } from 'mongodb';

export type PartnerEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface PartnerDocument {
  _id: ObjectId;
  legal_name: string;
  display_name: string;
  email: string;
  status: 'ONBOARDING' | 'SANDBOX' | 'ACTIVE' | 'SUSPENDED';
  integration_review_status:
    | 'NOT_STARTED'
    | 'PENDING'
    | 'PASSED'
    | 'FAILED';
  sandbox_approved_by: ObjectId | null;
  sandbox_approved_at: Date | null;
  production_approved_by: ObjectId | null;
  production_approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PartnerApiKeyDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: PartnerEnvironment;
  key_prefix: string;
  secret_hash: string;
  signing_secret_hash: string;
  scopes: string[];
  status: 'ACTIVE' | 'REVOKED';
  last_used_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface ApiUsageDailyDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: PartnerEnvironment;
  usage_date: Date;
  request_count: number;
  error_count: number;
  rate_limit_count: number;
  p95_latency_ms: number;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookEndpointDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: PartnerEnvironment;
  url: string;
  signing_secret_hash: string;
  subscribed_events: string[];
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'DISABLED';
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
