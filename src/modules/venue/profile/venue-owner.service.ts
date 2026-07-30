import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { MediaStorage } from '../../../shared/media/cloudinary-media-storage.js';
import type { VenueRepository } from './venue.repository.js';
import type {
  AddressDocument,
  VenueDocument,
  VenueMediaDocument,
} from './venue.types.js';

const VENUE_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const VENUE_MEDIA_MAX_ITEMS = 20;
const VENUE_MEDIA_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
]);

export interface UpdateVenueProfileInput {
  actorOwnerId: string;
  venueId: string;
  correlationId: string;
  expectedVersion: number;
  legalName?: string;
  displayName?: string;
  timezone?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  latitude?: number;
  longitude?: number;
  currency?: string;
}

export interface VenueOwnerService {
  getProfile(input: {
    actorOwnerId: string;
    venueId: string;
  }): Promise<ReturnType<typeof presentVenue>>;
  updateProfile(
    input: UpdateVenueProfileInput,
  ): Promise<ReturnType<typeof presentVenue>>;
  addMedia(input: {
    actorOwnerId: string;
    venueId: string;
    correlationId: string;
    expectedVersion: number;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<ReturnType<typeof presentVenue>>;
}

export function createVenueOwnerService(input: {
  repository: VenueRepository;
  ownerAccessService: OwnerAccessService;
  mediaStorage: MediaStorage;
  now?: () => Date;
}): VenueOwnerService {
  const now = input.now ?? (() => new Date());

  async function getProfile(
    values: Parameters<VenueOwnerService['getProfile']>[0],
  ): ReturnType<VenueOwnerService['getProfile']> {
    await input.ownerAccessService.requireVenueMembership(
      values.actorOwnerId,
      values.venueId,
    );
    const venue = await input.repository.findById(
      toObjectId(values.venueId),
    );

    if (!venue) {
      throw venueNotFound();
    }

    return presentVenue(venue);
  }

  async function updateProfile(
    values: UpdateVenueProfileInput,
  ): ReturnType<VenueOwnerService['updateProfile']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_VENUE',
    );
    const venueId = toObjectId(values.venueId);
    const existing = await input.repository.findById(venueId);

    if (!existing) {
      throw venueNotFound();
    }

    const { changes, changedFields } = normalizeProfileChanges(values);
    const updated = await input.repository.updateProfile({
      venueId,
      expectedVersion: values.expectedVersion,
      actorOwnerId: toObjectId(values.actorOwnerId),
      correlationId: values.correlationId,
      changes,
      changedFields,
      now: now(),
    });

    if (!updated) {
      const current = await input.repository.findById(venueId);
      throw versionConflict(current?.version ?? existing.version);
    }

    return presentVenue(updated);
  }

  async function addMedia(
    values: Parameters<VenueOwnerService['addMedia']>[0],
  ): ReturnType<VenueOwnerService['addMedia']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_VENUE',
    );
    const venueId = toObjectId(values.venueId);
    const existing = await input.repository.findById(venueId);

    if (!existing) {
      throw venueNotFound();
    }

    if (existing.media.length >= VENUE_MEDIA_MAX_ITEMS) {
      throw venueMediaLimitReached();
    }

    const mimeType = values.mimeType.toLowerCase();
    if (
      !VENUE_MEDIA_MIME_TYPES.has(mimeType) ||
      values.buffer.length === 0 ||
      values.buffer.length > VENUE_MEDIA_MAX_BYTES
    ) {
      throw new AppError({
        code: 'UNSUPPORTED_VENUE_MEDIA',
        message: 'The venue media type or size is not supported',
        statusCode: 400,
      });
    }

    const uploaded = await input.mediaStorage.uploadBuffer(values.buffer, {
      access: 'public',
      folder: `turf-gds/venues/${venueId.toHexString()}`,
      resourceType: 'auto',
      tags: ['venue', venueId.toHexString()],
    });
    const timestamp = now();
    const media: VenueMediaDocument = {
      provider: 'CLOUDINARY',
      storage_key: uploaded.publicId,
      resource_type: uploaded.resourceType,
      delivery_type: uploaded.deliveryType,
      format: uploaded.format ?? null,
      bytes: uploaded.bytes,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      mime_type: mimeType,
      original_filename: values.filename.slice(0, 255),
      secure_url: uploaded.secureUrl,
      checksum: uploaded.checksum ?? null,
      created_at: timestamp,
    };

    try {
      const updated = await input.repository.appendMedia({
        venueId,
        expectedVersion: values.expectedVersion,
        actorOwnerId: toObjectId(values.actorOwnerId),
        correlationId: values.correlationId,
        media,
        now: timestamp,
      });

      if (!updated) {
        const current = await input.repository.findById(venueId);
        if (
          current &&
          current.media.length >= VENUE_MEDIA_MAX_ITEMS
        ) {
          throw venueMediaLimitReached();
        }
        throw versionConflict(current?.version ?? existing.version);
      }

      return presentVenue(updated);
    } catch (error) {
      await input.mediaStorage
        .delete(
          uploaded.publicId,
          toDeletableResource(uploaded.resourceType),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  return { getProfile, updateProfile, addMedia };
}

function normalizeProfileChanges(input: UpdateVenueProfileInput): {
  changes: {
    legal_name?: string;
    display_name?: string;
    timezone?: string;
    address?: AddressDocument;
    geo?: { type: 'Point'; coordinates: [number, number] };
  };
  changedFields: string[];
} {
  if (input.currency !== undefined && input.currency !== 'INR') {
    throw new AppError({
      code: 'UNSUPPORTED_CURRENCY',
      message: 'Venue currency must be INR',
      statusCode: 400,
    });
  }

  if (
    (input.latitude === undefined) !==
    (input.longitude === undefined)
  ) {
    throw new AppError({
      code: 'VENUE_COORDINATES_REQUIRED',
      message: 'Latitude and longitude must be supplied together',
      statusCode: 400,
    });
  }

  const changes: ReturnType<typeof normalizeProfileChanges>['changes'] = {};
  const changedFields: string[] = [];

  if (input.legalName !== undefined) {
    changes.legal_name = nonBlank(input.legalName, 'legalName');
    changedFields.push('legal_name');
  }
  if (input.displayName !== undefined) {
    changes.display_name = nonBlank(input.displayName, 'displayName');
    changedFields.push('display_name');
  }
  if (input.timezone !== undefined) {
    const timezone = nonBlank(input.timezone, 'timezone');
    assertTimeZone(timezone);
    changes.timezone = timezone;
    changedFields.push('timezone');
  }
  if (input.address !== undefined) {
    changes.address = {
      line1: nonBlank(input.address.line1, 'address.line1'),
      ...(input.address.line2?.trim()
        ? { line2: input.address.line2.trim() }
        : {}),
      city: nonBlank(input.address.city, 'address.city'),
      state: nonBlank(input.address.state, 'address.state'),
      postal_code: nonBlank(
        input.address.postalCode,
        'address.postalCode',
      ),
      country: nonBlank(input.address.country, 'address.country')
        .toUpperCase(),
    };
    changedFields.push('address');
  }
  if (input.latitude !== undefined && input.longitude !== undefined) {
    changes.geo = {
      type: 'Point',
      coordinates: [input.longitude, input.latitude],
    };
    changedFields.push('geo');
  }

  if (changedFields.length === 0) {
    throw new AppError({
      code: 'VENUE_PROFILE_CHANGES_REQUIRED',
      message: 'At least one venue profile change is required',
      statusCode: 400,
    });
  }

  return { changes, changedFields };
}

function presentVenue(venue: VenueDocument) {
  return {
    id: venue._id.toHexString(),
    legalName: venue.legal_name,
    displayName: venue.display_name,
    environment: venue.environment,
    timezone: venue.timezone,
    address: {
      line1: venue.address.line1,
      ...(venue.address.line2 ? { line2: venue.address.line2 } : {}),
      city: venue.address.city,
      state: venue.address.state,
      postalCode: venue.address.postal_code,
      country: venue.address.country,
    },
    latitude: venue.geo.coordinates[1],
    longitude: venue.geo.coordinates[0],
    currency: venue.currency,
    media: venue.media.map((media) => ({
      storageKey: media.storage_key,
      resourceType: media.resource_type,
      format: media.format,
      bytes: media.bytes,
      width: media.width,
      height: media.height,
      mimeType: media.mime_type,
      originalFilename: media.original_filename,
      secureUrl: media.secure_url,
      checksum: media.checksum,
      createdAt: media.created_at.toISOString(),
    })),
    status: venue.status,
    version: venue.version,
    createdAt: venue.created_at.toISOString(),
    updatedAt: venue.updated_at.toISOString(),
  };
}

function nonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError({
      code: 'INVALID_VENUE_PROFILE',
      message: `${field} cannot be blank`,
      statusCode: 400,
    });
  }
  return normalized;
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new AppError({
      code: 'INVALID_TIMEZONE',
      message: 'Venue timezone must be a valid IANA timezone',
      statusCode: 400,
    });
  }
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

function venueNotFound(): AppError {
  return new AppError({
    code: 'VENUE_NOT_FOUND',
    message: 'Venue was not found',
    statusCode: 404,
  });
}

function versionConflict(currentVersion: number): AppError {
  return new AppError({
    code: 'VENUE_VERSION_CONFLICT',
    message: 'The Venue was changed by another request',
    statusCode: 409,
    details: { currentVersion },
  });
}

function venueMediaLimitReached(): AppError {
  return new AppError({
    code: 'VENUE_MEDIA_LIMIT_REACHED',
    message: `A Venue can contain at most ${VENUE_MEDIA_MAX_ITEMS} media items`,
    statusCode: 409,
  });
}

function toDeletableResource(
  value: string,
): 'image' | 'video' | 'raw' {
  return value === 'video' || value === 'raw' ? value : 'image';
}
