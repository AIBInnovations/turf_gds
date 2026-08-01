import type { ObjectId } from 'mongodb';
import type { ExternalEventType } from '../../../shared/communications/communications.types.js';

export type PartnerEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface PartnerSessionDocument {
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface PartnerDocument {
  _id: ObjectId;
  legal_name: string;
  display_name: string;
  email?: string;
  phone_e164?: string;
  password_hash?: string;
  failed_login_count?: number;
  locked_until?: Date | null;
  last_login_at?: Date | null;
  sessions?: PartnerSessionDocument[];
  kyc_status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  rate_limit_tier: 'STARTER' | 'STANDARD' | 'ENTERPRISE';
  sandbox_approved_at: Date | null;
  production_approved_by: ObjectId | null;
  production_approved_at: Date | null;
  audit_history: unknown[];
  created_at: Date;
  updated_at: Date;
}

export interface PartnerApiKeyDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  key_prefix: string;
  key_hash: string;
  signing_secret_hash: string;
  environment: PartnerEnvironment;
  scopes: { values: string[] };
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  expires_at: Date | null;
  last_used_at: Date | null;
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
  rate_limited_count: number;
  p95_latency_ms: number;
  latency_samples?: number[];
  rate_limit_window_started_at: Date;
  rate_limit_window_count: number;
  updated_at: Date;
}

export interface WebhookEndpointDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: PartnerEnvironment;
  url: string;
  signing_secret_hash: string;
  secret_version?: number;
  subscribed_event_types: ExternalEventType[];
  status: 'PENDING' | 'ACTIVE' | 'DISABLED';
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
