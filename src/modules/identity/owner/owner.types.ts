import type { ObjectId } from 'mongodb';

export type VenueOwnerStatus = 'ACTIVE' | 'SUSPENDED';
export type KycDerivedStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type VenueMembershipRole = 'OWNER' | 'MANAGER' | 'STAFF';
export const PERMISSIONS = [
  'MANAGE_VENUE',
  'MANAGE_COURTS',
  'MANAGE_PRICING',
  'MANAGE_MEMBERS',
  'MANAGE_KYC',
  'VIEW_FINANCE',
  'VIEW_BOOKINGS',
  'MANAGE_AVAILABILITY',
  'MANAGE_BOOKINGS', // [UPDATED 2026-07-31] Owner direct booking and cancellation
] as const;
export type VenuePermission = (typeof PERMISSIONS)[number];

export interface OwnerSessionDocument {
  token_hash: string;
  ip_hash: string;
  user_agent: string;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface VenueOwnerDocument {
  _id: ObjectId;
  legal_name: string;
  email: string;
  phone_e164: string;
  password_hash: string;
  email_verified_at: Date | null;
  kyc_status: KycDerivedStatus;
  status: VenueOwnerStatus;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  sessions: OwnerSessionDocument[];
  fcm_tokens: unknown[];
  notifications: unknown[];
  audit_history: unknown[];
  approved_by: ObjectId | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface VenueOwnerMembershipDocument {
  _id: ObjectId;
  owner_id: ObjectId;
  venue_id: ObjectId;
  role: VenueMembershipRole;
  status: 'ACTIVE' | 'REVOKED';
  created_at: Date;
}

export interface VenueRolePermissionDocument {
  _id: ObjectId;
  role: VenueMembershipRole;
  permission: VenuePermission;
  created_at: Date;
}

export interface RegisterVenueOwnerInput {
  legalName: string;
  email: string;
  phoneE164: string;
  password: string;
  venue: {
    legalName: string;
    displayName: string;
    timezone: string;
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
    latitude: number;
    longitude: number;
  };
}

export interface LoginVenueOwnerInput {
  email: string;
  password: string;
  ipAddress: string;
  userAgent: string;
}
