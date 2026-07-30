import type { ObjectId } from 'mongodb';

export interface AddressDocument {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export interface VenueMediaDocument {
  provider: 'CLOUDINARY';
  storage_key: string;
  resource_type: string;
  delivery_type: string;
  format: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  mime_type: string;
  original_filename: string;
  secure_url: string;
  checksum: string | null;
  created_at: Date;
}

export interface VenueAuditDocument {
  event_type: string;
  actor_type: 'ADMIN' | 'VENUE_OWNER';
  actor_id: ObjectId;
  correlation_id: string;
  changed_fields?: string[];
  reason?: string;
  occurred_at: Date;
}

export interface VenueDocument {
  _id: ObjectId;
  legal_name: string;
  display_name: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  timezone: string;
  address: AddressDocument;
  geo: {
    type: 'Point';
    coordinates: [number, number];
  };
  currency: 'INR';
  media: VenueMediaDocument[];
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  audit_history: VenueAuditDocument[];
  version: number;
  created_at: Date;
  updated_at: Date;
}
