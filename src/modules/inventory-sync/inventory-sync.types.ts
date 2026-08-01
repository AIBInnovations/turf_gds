import type { ObjectId } from 'mongodb';

export type SyncEnvironment = 'SANDBOX' | 'PRODUCTION';
export type ConnectorStatus = 'ACTIVE' | 'DISABLED';
export type SyncDirection = 'PULL' | 'PUSH' | 'WEBHOOK';

export interface InventoryConnectorDocument {
  _id: ObjectId;
  venue_id: ObjectId;
  environment: SyncEnvironment;
  provider: 'REFERENCE';
  name: string;
  status: ConnectorStatus;
  webhook_secret_hash: string;
  last_sync_at: Date | null;
  last_cursor: string | null;
  created_by: ObjectId;
  created_at: Date;
  updated_at: Date;
}

export interface ExternalResourceMappingDocument {
  _id: ObjectId;
  connector_id: ObjectId;
  venue_id: ObjectId;
  resource_type: 'COURT';
  internal_id: ObjectId;
  external_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface InventorySyncRunDocument {
  _id: ObjectId;
  connector_id: ObjectId;
  direction: SyncDirection;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  cursor_before: string | null;
  cursor_after: string | null;
  processed_count: number;
  conflict_count: number;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface InventoryConflictDocument {
  _id: ObjectId;
  connector_id: ObjectId;
  venue_id: ObjectId;
  court_id: ObjectId | null;
  external_event_id: string;
  type: 'UNMAPPED_RESOURCE' | 'OVERLAPPING_CONFIRMED_BOOKING' | 'STALE_UPDATE' | 'INVALID_EVENT';
  status: 'OPEN' | 'RESOLVED' | 'IGNORED';
  details: Record<string, unknown>;
  resolved_by: ObjectId | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

export interface ExternalInventoryEventDocument {
  _id: ObjectId;
  connector_id: ObjectId;
  external_event_id: string;
  external_version: number;
  event_type: 'AVAILABILITY_BLOCKED' | 'AVAILABILITY_RELEASED' | 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED';
  external_court_id: string;
  starts_at: Date;
  ends_at: Date;
  external_booking_reference: string | null;
  status: 'APPLIED' | 'CONFLICT' | 'IGNORED';
  received_at: Date;
}
