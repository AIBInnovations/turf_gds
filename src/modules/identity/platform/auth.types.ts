import type { ObjectId } from 'mongodb';

export type AdminRole = 'ADMIN' | 'OPS' | 'SUPPORT';

export interface AdminUserDocument {
  _id: ObjectId;
  email: string;
  password_hash: string;
  display_name: string;
  role: AdminRole;
  status: 'ACTIVE' | 'DISABLED';
  /** Null until the admin verifies one via the phone+OTP self-service flow. */
  phone_e164: string | null;
  failed_login_count: number;
  locked_until: Date | null;
  fcm_tokens: unknown[];
  audit_history: unknown[];
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
