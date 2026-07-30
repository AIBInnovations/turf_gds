import { ObjectId, type ClientSession } from 'mongodb';

import { AppError } from '../../../shared/errors/app-error.js';
import type { VenueRepository } from './venue.repository.js';

export interface CreateInitialVenueInput {
  venueId: ObjectId;
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
  environment?: 'SANDBOX' | 'PRODUCTION';
  createdAt: Date;
}

export interface VenueService {
  createInitialVenue(
    input: CreateInitialVenueInput,
    session: ClientSession,
  ): Promise<void>;
  approveVenue(
    input: {
      venueId: string;
      adminId: string;
      correlationId: string;
    },
    session: ClientSession,
  ): Promise<void>;
}

export function createVenueService(input: {
  repository: VenueRepository;
  now?: () => Date;
}): VenueService {
  const now = input.now ?? (() => new Date());

  async function createInitialVenue(
    values: CreateInitialVenueInput,
    session: ClientSession,
  ): Promise<void> {
    await input.repository.insertInitialVenue(
      {
        _id: values.venueId,
        legal_name: values.legalName.trim(),
        display_name: values.displayName.trim(),
        environment: values.environment ?? 'PRODUCTION',
        timezone: values.timezone.trim(),
        address: {
          line1: values.address.line1.trim(),
          ...(values.address.line2
            ? { line2: values.address.line2.trim() }
            : {}),
          city: values.address.city.trim(),
          state: values.address.state.trim(),
          postal_code: values.address.postalCode.trim(),
          country: values.address.country.trim().toUpperCase(),
        },
        geo: {
          type: 'Point',
          coordinates: [values.longitude, values.latitude],
        },
        currency: 'INR',
        media: [],
        status: 'PENDING',
        audit_history: [],
        version: 1,
        created_at: values.createdAt,
        updated_at: values.createdAt,
      },
      session,
    );
  }

  async function approveVenue(
    values: Parameters<VenueService['approveVenue']>[0],
    session: ClientSession,
  ): Promise<void> {
    const approved = await input.repository.approveVenue({
      venueId: toObjectId(values.venueId),
      adminId: toObjectId(values.adminId),
      correlationId: values.correlationId,
      now: now(),
      session,
    });

    if (!approved) {
      throw new AppError({
        code: 'VENUE_APPROVAL_NOT_ALLOWED',
        message: 'The Venue cannot be approved',
        statusCode: 409,
      });
    }
  }

  return { createInitialVenue, approveVenue };
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'INVALID_ID',
      message: 'A supplied identifier is invalid',
      statusCode: 400,
    });
  }

  return new ObjectId(value);
}
