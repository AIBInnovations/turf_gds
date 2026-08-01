import type { ObjectId } from 'mongodb';

export type KycSubjectType = 'VENUE_OWNER' | 'PARTNER';
export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type KycVerificationType = 'IDENTITY' | 'BUSINESS' | 'ADDRESS';
export type KycDocumentType =
  | 'PAN'
  | 'AADHAAR'
  | 'GST_CERTIFICATE'
  | 'PASSBOOK'
  | 'BUSINESS_REGISTRATION'
  | 'ADDRESS_PROOF'
  | 'ID_PROOF';

export interface KycVerificationDocument {
  _id: ObjectId;
  subject_type: KycSubjectType;
  subject_id: ObjectId;
  verification_type: KycVerificationType;
  status: KycStatus;
  is_current: boolean;
  reviewed_by: ObjectId | null;
  preliminary_reviewed_by?: ObjectId | null;
  preliminary_reviewed_at?: Date | null;
  preliminary_status?: 'APPROVED' | 'REJECTED' | null;
  preliminary_checklist?: Record<string, boolean> | null;
  preliminary_notes?: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  expires_at: Date | null;
  audit_history: unknown[];
  created_at: Date;
}

export interface KycFileDocument {
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  classification: 'SENSITIVE';
  status: 'ACTIVE' | 'DELETED';
  created_at: Date;
}

export interface KycDocumentDocument {
  _id: ObjectId;
  kyc_verification_id: ObjectId;
  file: KycFileDocument;
  document_type: KycDocumentType;
  details?: Record<string, string>;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  rejection_reason: string | null;
  created_at: Date;
}
