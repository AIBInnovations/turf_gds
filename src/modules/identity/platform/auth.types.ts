import type { ObjectId } from 'mongodb';

export type AdminRole = 'ADMIN' | 'OPS' | 'SUPPORT';

export interface AdminUserDocument {
  _id: ObjectId;
  email: string;
  password_hash: string;
  display_name: string;
  role: AdminRole;
  status: 'ACTIVE' | 'DISABLED';
  fcm_tokens: unknown[];
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
