import { ObjectId, type Document } from 'mongodb';

import type { IdentityService } from '../identity/owner/owner-auth.service.js';
import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { VenueService } from './profile/venue.service.js';
import type { VenueDocument } from './profile/venue.types.js';
import type {
  CourtBookingMode,
  CourtDocument,
  CourtSportType,
} from './courts/court.types.js';

type Environment = 'SANDBOX' | 'PRODUCTION';
type VenueStatus = VenueDocument['status'];

export interface AdminVenueService {
  listVenues(input: {
    environment?: Environment;
    status?: VenueStatus;
    ownerId?: string;
    query?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: unknown[]; page: number; limit: number; total: number }>;
  getVenue(venueId: string): Promise<unknown>;
  createVenue(input: {
    adminId: string;
    ownerId: string;
    correlationId: string;
    environment: Environment;
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
  }): Promise<unknown>;
  updateVenue(input: {
    adminId: string;
    venueId: string;
    correlationId: string;
    expectedVersion: number;
    legalName?: string;
    displayName?: string;
    timezone?: string;
    status?: VenueStatus;
    reason?: string;
  }): Promise<unknown>;
  listCourts(venueId: string): Promise<unknown[]>;
  getCourt(venueId: string, courtId: string): Promise<unknown>;
  createCourt(input: {
    adminId: string;
    venueId: string;
    correlationId: string;
    name: string;
    sportType: CourtSportType;
    surfaceType: string;
    capacity: number;
    bookingMode: CourtBookingMode;
    minBookingMinutes: number;
    bookingIncrementMinutes: number;
    fixedSlotDurationMinutes?: number | null;
    fixedSlotAnchorMinutes?: number | null;
  }): Promise<unknown>;
  updateCourt(input: {
    adminId: string;
    venueId: string;
    courtId: string;
    correlationId: string;
    expectedVersion: number;
    name?: string;
    surfaceType?: string;
    capacity?: number;
    status?: 'AVAILABLE' | 'UNAVAILABLE';
    reason?: string;
  }): Promise<unknown>;
}

export function createAdminVenueService(input: {
  database: DatabaseConnection;
  identityService: IdentityService;
  venueService: VenueService;
  now?: () => Date;
}): AdminVenueService {
  const now = input.now ?? (() => new Date());
  const venues = () => input.database.db.collection<VenueDocument>('venues');
  const courts = () => input.database.db.collection<CourtDocument>('courts');

  return {
    async listVenues(values) {
      const { page, limit } = pagination(values.page, values.limit);
      const filter: Document = {};
      if (values.environment) filter.environment = values.environment;
      if (values.status) filter.status = values.status;
      if (values.query?.trim()) {
        const escaped = values.query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { legal_name: { $regex: escaped, $options: 'i' } },
          { display_name: { $regex: escaped, $options: 'i' } },
        ];
      }
      if (values.ownerId) {
        const ownerId = oid(values.ownerId);
        const memberships = await input.database.db
          .collection('venue_owner_memberships')
          .find({ owner_id: ownerId, status: 'ACTIVE' })
          .project({ venue_id: 1 })
          .toArray();
        filter._id = { $in: memberships.map(({ venue_id }) => venue_id) };
      }
      const [items, total] = await Promise.all([
        venues().find(filter).sort({ created_at: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).toArray(),
        venues().countDocuments(filter),
      ]);
      return { items: items.map(presentVenue), page, limit, total };
    },
    async getVenue(venueId) {
      const venue = await venues().findOne({ _id: oid(venueId) });
      if (!venue) throw notFound('VENUE_NOT_FOUND', 'Venue not found');
      const owner = await input.database.db
        .collection('venue_owner_memberships')
        .findOne({ venue_id: venue._id, role: 'OWNER', status: 'ACTIVE' });
      return { ...presentVenue(venue), ownerId: owner?.owner_id?.toHexString() ?? null };
    },
    async createVenue(values) {
      const timestamp = now();
      const venueId = new ObjectId();
      let membershipId = '';
      await input.database.withTransaction(async ({ session }) => {
        await input.venueService.createInitialVenue({
          venueId,
          legalName: required(values.legalName, 'legalName'),
          displayName: required(values.displayName, 'displayName'),
          timezone: required(values.timezone, 'timezone'),
          address: values.address,
          latitude: values.latitude,
          longitude: values.longitude,
          environment: values.environment,
          createdAt: timestamp,
        }, session);
        if (!input.identityService.attachOwnerVenue) {
          throw new Error('Identity owner attachment capability is unavailable');
        }
        membershipId = (await input.identityService.attachOwnerVenue({
          ownerId: values.ownerId,
          venueId: venueId.toHexString(),
          createdAt: timestamp,
        }, session)).membershipId;
        await venues().updateOne(
          { _id: venueId },
          { $push: { audit_history: {
            event_type: 'VENUE_CREATED_BY_ADMIN',
            actor_type: 'ADMIN',
            actor_id: oid(values.adminId),
            correlation_id: required(values.correlationId, 'correlationId'),
            changed_fields: ['owner_id', 'environment'],
            occurred_at: timestamp,
          } } },
          { session },
        );
      });
      const venue = await venues().findOne({ _id: venueId });
      return { ...presentVenue(venue!), ownerId: values.ownerId, membershipId };
    },
    async updateVenue(values) {
      const venueId = oid(values.venueId);
      const existing = await venues().findOne({ _id: venueId });
      if (!existing) throw notFound('VENUE_NOT_FOUND', 'Venue not found');
      const changes: Document = {};
      if (values.legalName !== undefined) changes.legal_name = required(values.legalName, 'legalName');
      if (values.displayName !== undefined) changes.display_name = required(values.displayName, 'displayName');
      if (values.timezone !== undefined) changes.timezone = required(values.timezone, 'timezone');
      if (values.status !== undefined && values.status !== existing.status) {
        if (existing.status === 'PENDING' || values.status === 'PENDING') {
          throw conflict('VENUE_STATUS_TRANSITION_NOT_ALLOWED', 'Pending Venue activation must use onboarding approval');
        }
        required(values.reason, 'reason');
        if (existing.status === 'SUSPENDED' && values.status === 'ACTIVE') {
          const membership = await input.database.db.collection('venue_owner_memberships')
            .findOne({ venue_id: venueId, role: 'OWNER', status: 'ACTIVE' });
          const verification = membership
            ? await input.database.db.collection('kyc_verifications').findOne({
                subject_type: 'VENUE_OWNER',
                subject_id: membership.owner_id,
                verification_type: 'BUSINESS',
                status: 'VERIFIED',
                is_current: true,
                expires_at: { $gt: now() },
              })
            : null;
          if (!verification) throw conflict('VERIFIED_OWNER_KYC_REQUIRED', 'Current verified Owner BUSINESS KYC is required');
        }
        changes.status = values.status;
      }
      const fields = Object.keys(changes);
      if (fields.length === 0) throw bad('EMPTY_UPDATE', 'At least one change is required');
      const timestamp = now();
      const updated = await venues().findOneAndUpdate(
        { _id: venueId, version: values.expectedVersion },
        {
          $set: { ...changes, updated_at: timestamp },
          $inc: { version: 1 },
          $push: { audit_history: { $each: [{
            event_type: 'VENUE_UPDATED_BY_ADMIN',
            actor_type: 'ADMIN',
            actor_id: oid(values.adminId),
            correlation_id: required(values.correlationId, 'correlationId'),
            changed_fields: fields,
            ...(values.reason ? { reason: values.reason.trim() } : {}),
            occurred_at: timestamp,
          }], $slice: -100 } },
        },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('VENUE_VERSION_CONFLICT', 'Venue version is stale');
      return presentVenue(updated);
    },
    async listCourts(venueId) {
      const id = oid(venueId);
      if (!await venues().findOne({ _id: id })) throw notFound('VENUE_NOT_FOUND', 'Venue not found');
      return (await courts().find({ venue_id: id }).sort({ name: 1, _id: 1 }).toArray()).map(presentCourt);
    },
    async getCourt(venueId, courtId) {
      const court = await courts().findOne({ _id: oid(courtId), venue_id: oid(venueId) });
      if (!court) throw notFound('COURT_NOT_FOUND', 'Court not found');
      return presentCourt(court);
    },
    async createCourt(values) {
      const venueId = oid(values.venueId);
      if (!await venues().findOne({ _id: venueId })) throw notFound('VENUE_NOT_FOUND', 'Venue not found');
      validateDurations(values.minBookingMinutes, values.bookingIncrementMinutes);
      const timestamp = now();
      const court: CourtDocument = {
        _id: new ObjectId(),
        venue_id: venueId,
        name: required(values.name, 'name'),
        sport_type: values.sportType,
        surface_type: required(values.surfaceType, 'surfaceType'),
        capacity: positive(values.capacity, 'capacity'),
        status: 'AVAILABLE',
        booking_mode: values.bookingMode,
        min_booking_minutes: values.minBookingMinutes,
        booking_increment_minutes: values.bookingIncrementMinutes,
        operating_hours: { entries: [] },
        fixed_slot_duration_minutes: values.fixedSlotDurationMinutes ?? null,
        fixed_slot_anchor_minutes: values.fixedSlotAnchorMinutes ?? null,
        media: [],
        audit_history: [{
          event_type: 'COURT_CREATED_BY_ADMIN',
          actor_type: 'ADMIN',
          actor_id: oid(values.adminId),
          correlation_id: required(values.correlationId, 'correlationId'),
          changed_fields: ['name', 'sport_type', 'surface_type', 'capacity', 'booking_mode', 'status'],
          occurred_at: timestamp,
        }],
        version: 1,
        created_at: timestamp,
        updated_at: timestamp,
      };
      try { await courts().insertOne(court); } catch (error: unknown) {
        if (isDuplicate(error)) throw conflict('COURT_NAME_EXISTS', 'Court name already exists for this Venue');
        throw error;
      }
      return presentCourt(court);
    },
    async updateCourt(values) {
      const venueId = oid(values.venueId);
      const courtId = oid(values.courtId);
      const changes: Document = {};
      if (values.name !== undefined) changes.name = required(values.name, 'name');
      if (values.surfaceType !== undefined) changes.surface_type = required(values.surfaceType, 'surfaceType');
      if (values.capacity !== undefined) changes.capacity = positive(values.capacity, 'capacity');
      if (values.status !== undefined) {
        changes.status = values.status;
        if (values.status === 'UNAVAILABLE') required(values.reason, 'reason');
      }
      const fields = Object.keys(changes);
      if (!fields.length) throw bad('EMPTY_UPDATE', 'At least one change is required');
      const timestamp = now();
      let updated: CourtDocument | null;
      try {
        updated = await courts().findOneAndUpdate(
          { _id: courtId, venue_id: venueId, version: values.expectedVersion },
          {
            $set: { ...changes, updated_at: timestamp },
            $inc: { version: 1 },
            $push: { audit_history: { $each: [{
              event_type: 'COURT_UPDATED_BY_ADMIN',
              actor_type: 'ADMIN',
              actor_id: oid(values.adminId),
              correlation_id: required(values.correlationId, 'correlationId'),
              changed_fields: fields,
              ...(values.reason ? { reason: values.reason.trim() } : {}),
              occurred_at: timestamp,
            }], $slice: -100 } },
          },
          { returnDocument: 'after', collation: { locale: 'en', strength: 2 } },
        );
      } catch (error: unknown) {
        if (isDuplicate(error)) throw conflict('COURT_NAME_EXISTS', 'Court name already exists for this Venue');
        throw error;
      }
      if (!updated) {
        if (!await courts().findOne({ _id: courtId, venue_id: venueId })) throw notFound('COURT_NOT_FOUND', 'Court not found');
        throw conflict('COURT_VERSION_CONFLICT', 'Court version is stale');
      }
      return presentCourt(updated);
    },
  };
}

function presentVenue(value: VenueDocument) {
  return {
    venueId: value._id.toHexString(), legalName: value.legal_name,
    displayName: value.display_name, environment: value.environment,
    timezone: value.timezone, address: value.address, geo: value.geo,
    currency: value.currency, status: value.status, version: value.version,
    auditHistory: value.audit_history, createdAt: value.created_at.toISOString(),
    updatedAt: value.updated_at.toISOString(),
  };
}
function presentCourt(value: CourtDocument) {
  return {
    courtId: value._id.toHexString(), venueId: value.venue_id.toHexString(),
    name: value.name, sportType: value.sport_type, surfaceType: value.surface_type,
    capacity: value.capacity, status: value.status, bookingMode: value.booking_mode,
    minBookingMinutes: value.min_booking_minutes,
    bookingIncrementMinutes: value.booking_increment_minutes,
    operatingHours: value.operating_hours.entries, version: value.version,
    auditHistory: value.audit_history,
  };
}
function pagination(page = 1, limit = 20) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('INVALID_PAGINATION', 'page and limit are out of range');
  return { page, limit };
}
function oid(value: string) { if (!ObjectId.isValid(value)) throw bad('INVALID_ID', 'A supplied identifier is invalid'); return new ObjectId(value); }
function required(value: string | undefined, name: string) { const result = value?.trim(); if (!result) throw bad('INVALID_INPUT', `${name} is required`); return result; }
function positive(value: number, name: string) { if (!Number.isInteger(value) || value < 1) throw bad('INVALID_INPUT', `${name} must be a positive integer`); return value; }
function validateDurations(min: number, increment: number) { if (!Number.isInteger(min) || min < 60 || !Number.isInteger(increment) || increment < 5 || min % increment !== 0) throw bad('INVALID_COURT_DURATION', 'Court duration values are invalid'); }
function isDuplicate(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000; }
function bad(code: string, message: string) { return new AppError({ code, message, statusCode: 400 }); }
function conflict(code: string, message: string) { return new AppError({ code, message, statusCode: 409 }); }
function notFound(code: string, message: string) { return new AppError({ code, message, statusCode: 404 }); }
