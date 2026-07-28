import type { ObjectId } from 'mongodb';

export type KycSubjectType = 'VENUE_OWNER' | 'PARTNER';
export type KycStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED';

export interface KycVerificationDocument {
  _id: ObjectId;
  subject_type: KycSubjectType;
  subject_id: ObjectId;
  verification_type: string;
  status: KycStatus;
  is_current: boolean;
  submitted_at: Date | null;
  reviewed_by: ObjectId | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KycFileDocument {
  provider: 'CLOUDINARY';
  storage_key: string;
  resource_type: string;
  delivery_type: string;
  format: string | null;
  bytes: number;
  checksum: string | null;
  mime_type: string;
  original_filename: string;
  secure_url: string;
}

export interface KycDocumentDocument {
  _id: ObjectId;
  kyc_verification_id: ObjectId;
  document_type: string;
  file: KycFileDocument;
  status: 'ACTIVE' | 'REJECTED' | 'DELETED';
  created_at: Date;
  updated_at: Date;
}
