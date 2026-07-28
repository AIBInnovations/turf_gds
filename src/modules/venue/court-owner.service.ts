import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { MediaStorage } from '../../shared/media/cloudinary-media-storage.js';
import type { CourtRepository } from './court.repository.js';
import type {
  CourtBookingMode,
  CourtDocument,
  CourtOperatingHourDocument,
  CourtStatus,
} from './court.types.js';
import type { VenueRepository } from './venue.repository.js';
import type { VenueMediaDocument } from './venue.types.js';

const COURT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const COURT_MEDIA_MAX_ITEMS = 20;
const COURT_MEDIA_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
]);
const BOOKING_MODES = new Set<CourtBookingMode>([
  'OPEN_TIME',
  'FIXED_SLOT',
  'BOTH',
]);

export interface CreateCourtInput {
  actorOwnerId: string;
  venueId: string;
  correlationId: string;
  name: string;
  sportTypes: string[];
  bookingMode: CourtBookingMode;
  minBookingMinutes: number;
  bookingIncrementMinutes: number;
  timezone?: string;
}

export interface UpdateCourtInput {
  actorOwnerId: string;
  venueId: string;
  courtId: string;
  correlationId: string;
  expectedVersion: number;
  name?: string;
  sportTypes?: string[];
  bookingMode?: CourtBookingMode;
  minBookingMinutes?: number;
  bookingIncrementMinutes?: number;
  timezone?: string;
  status?: CourtStatus;
}

export interface CourtOwnerService {
  create(input: CreateCourtInput): Promise<ReturnType<typeof presentCourt>>;
  list(input: {
    actorOwnerId: string;
    venueId: string;
  }): Promise<Array<ReturnType<typeof presentCourt>>>;
  get(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
  }): Promise<ReturnType<typeof presentCourt>>;
  update(input: UpdateCourtInput): Promise<ReturnType<typeof presentCourt>>;
  addMedia(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
    correlationId: string;
    expectedVersion: number;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<ReturnType<typeof presentCourt>>;
  setOperatingHours(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
    correlationId: string;
    expectedVersion: number;
    operatingHours: Array<{
      dayOfWeek: number;
      opensAt: string;
      closesAt: string;
    }>;
  }): Promise<ReturnType<typeof presentCourt>>;
}

export function createCourtOwnerService(input: {
  repository: CourtRepository;
  venueRepository: VenueRepository;
  ownerAccessService: OwnerAccessService;
  mediaStorage: MediaStorage;
  now?: () => Date;
}): CourtOwnerService {
  const now = input.now ?? (() => new Date());

  async function create(
    values: CreateCourtInput,
  ): ReturnType<CourtOwnerService['create']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_COURTS',
    );
    const venueId = toObjectId(values.venueId);
    const venue = await input.venueRepository.findById(venueId);

    if (!venue) {
      throw venueNotFound();
    }

    const timestamp = now();
    const court: CourtDocument = {
      _id: new ObjectId(),
      venue_id: venueId,
      name: normalizeName(values.name),
      sport_types: normalizeSportTypes(values.sportTypes),
      booking_mode: assertBookingMode(values.bookingMode),
      min_booking_minutes: values.minBookingMinutes,
      booking_increment_minutes: values.bookingIncrementMinutes,
      operating_hours: [],
      timezone: values.timezone
        ? normalizeTimeZone(values.timezone)
        : venue.timezone,
      media: [],
      status: 'ACTIVE',
      audit_history: [{
        event_type: 'COURT_CREATED',
        actor_type: 'VENUE_OWNER',
        actor_id: toObjectId(values.actorOwnerId),
        correlation_id: values.correlationId,
        changed_fields: [
          'name',
          'sport_types',
          'booking_mode',
          'min_booking_minutes',
          'booking_increment_minutes',
          'timezone',
          'status',
        ],
        occurred_at: timestamp,
      }],
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    };
    assertDurations(
      court.min_booking_minutes,
      court.booking_increment_minutes,
    );

    try {
      await input.repository.insert(court);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw duplicateCourtName();
      }
      throw error;
    }

    return presentCourt(court);
  }

  async function list(
    values: Parameters<CourtOwnerService['list']>[0],
  ): ReturnType<CourtOwnerService['list']> {
    await input.ownerAccessService.requireVenueMembership(
      values.actorOwnerId,
      values.venueId,
    );
    return (
      await input.repository.listByVenue(toObjectId(values.venueId))
    ).map(presentCourt);
  }

  async function get(
    values: Parameters<CourtOwnerService['get']>[0],
  ): ReturnType<CourtOwnerService['get']> {
    await input.ownerAccessService.requireVenueMembership(
      values.actorOwnerId,
      values.venueId,
    );
    const court = await input.repository.findByIdAndVenue(
      toObjectId(values.courtId),
      toObjectId(values.venueId),
    );

    if (!court) {
      throw courtNotFound();
    }
    return presentCourt(court);
  }

  async function update(
    values: UpdateCourtInput,
  ): ReturnType<CourtOwnerService['update']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_COURTS',
    );
    const venueId = toObjectId(values.venueId);
    const courtId = toObjectId(values.courtId);
    const existing = await input.repository.findByIdAndVenue(
      courtId,
      venueId,
    );

    if (!existing) {
      throw courtNotFound();
    }

    const { changes, changedFields } = normalizeCourtChanges(
      values,
      existing,
    );

    try {
      const updated = await input.repository.update({
        courtId,
        venueId,
        expectedVersion: values.expectedVersion,
        actorOwnerId: toObjectId(values.actorOwnerId),
        correlationId: values.correlationId,
        changes,
        changedFields,
        now: now(),
      });

      if (!updated) {
        const current = await input.repository.findByIdAndVenue(
          courtId,
          venueId,
        );
        throw courtVersionConflict(
          current?.version ?? existing.version,
        );
      }

      return presentCourt(updated);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw duplicateCourtName();
      }
      throw error;
    }
  }

  async function addMedia(
    values: Parameters<CourtOwnerService['addMedia']>[0],
  ): ReturnType<CourtOwnerService['addMedia']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_COURTS',
    );
    const venueId = toObjectId(values.venueId);
    const courtId = toObjectId(values.courtId);
    const existing = await input.repository.findByIdAndVenue(
      courtId,
      venueId,
    );

    if (!existing) {
      throw courtNotFound();
    }
    if (existing.media.length >= COURT_MEDIA_MAX_ITEMS) {
      throw courtMediaLimitReached();
    }

    const mimeType = values.mimeType.toLowerCase();
    if (
      !COURT_MEDIA_MIME_TYPES.has(mimeType) ||
      values.buffer.length === 0 ||
      values.buffer.length > COURT_MEDIA_MAX_BYTES
    ) {
      throw new AppError({
        code: 'UNSUPPORTED_COURT_MEDIA',
        message: 'The court media type or size is not supported',
        statusCode: 400,
      });
    }

    const uploaded = await input.mediaStorage.uploadBuffer(values.buffer, {
      access: 'public',
      folder: `turf-gds/venues/${venueId.toHexString()}/courts/${courtId.toHexString()}`,
      resourceType: 'auto',
      tags: ['court', courtId.toHexString()],
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
        courtId,
        venueId,
        expectedVersion: values.expectedVersion,
        actorOwnerId: toObjectId(values.actorOwnerId),
        correlationId: values.correlationId,
        media,
        now: timestamp,
      });

      if (!updated) {
        const current = await input.repository.findByIdAndVenue(
          courtId,
          venueId,
        );
        if (current && current.media.length >= COURT_MEDIA_MAX_ITEMS) {
          throw courtMediaLimitReached();
        }
        throw courtVersionConflict(
          current?.version ?? existing.version,
        );
      }

      return presentCourt(updated);
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

  async function setOperatingHours(
    values: Parameters<CourtOwnerService['setOperatingHours']>[0],
  ): ReturnType<CourtOwnerService['setOperatingHours']> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'MANAGE_AVAILABILITY',
    );
    const venueId = toObjectId(values.venueId);
    const courtId = toObjectId(values.courtId);
    const existing = await input.repository.findByIdAndVenue(
      courtId,
      venueId,
    );
    if (!existing) {
      throw courtNotFound();
    }

    const operatingHours = normalizeOperatingHours(
      values.operatingHours,
    );
    const updated = await input.repository.update({
      courtId,
      venueId,
      expectedVersion: values.expectedVersion,
      actorOwnerId: toObjectId(values.actorOwnerId),
      correlationId: values.correlationId,
      changes: { operating_hours: operatingHours },
      changedFields: ['operating_hours'],
      now: now(),
    });
    if (!updated) {
      const current = await input.repository.findByIdAndVenue(
        courtId,
        venueId,
      );
      throw courtVersionConflict(
        current?.version ?? existing.version,
      );
    }
    return presentCourt(updated);
  }

  return { create, list, get, update, addMedia, setOperatingHours };
}

function normalizeCourtChanges(
  input: UpdateCourtInput,
  existing: CourtDocument,
): {
  changes: {
    name?: string;
    sport_types?: string[];
    booking_mode?: CourtBookingMode;
    min_booking_minutes?: number;
    booking_increment_minutes?: number;
    timezone?: string;
    status?: CourtStatus;
  };
  changedFields: string[];
} {
  const changes: ReturnType<typeof normalizeCourtChanges>['changes'] = {};
  const changedFields: string[] = [];

  if (input.name !== undefined) {
    changes.name = normalizeName(input.name);
    changedFields.push('name');
  }
  if (input.sportTypes !== undefined) {
    changes.sport_types = normalizeSportTypes(input.sportTypes);
    changedFields.push('sport_types');
  }
  if (input.bookingMode !== undefined) {
    changes.booking_mode = assertBookingMode(input.bookingMode);
    changedFields.push('booking_mode');
  }
  if (input.minBookingMinutes !== undefined) {
    changes.min_booking_minutes = input.minBookingMinutes;
    changedFields.push('min_booking_minutes');
  }
  if (input.bookingIncrementMinutes !== undefined) {
    changes.booking_increment_minutes = input.bookingIncrementMinutes;
    changedFields.push('booking_increment_minutes');
  }
  if (input.timezone !== undefined) {
    changes.timezone = normalizeTimeZone(input.timezone);
    changedFields.push('timezone');
  }
  if (input.status !== undefined) {
    changes.status = input.status;
    changedFields.push('status');
  }

  if (changedFields.length === 0) {
    throw new AppError({
      code: 'COURT_CHANGES_REQUIRED',
      message: 'At least one Court change is required',
      statusCode: 400,
    });
  }

  assertDurations(
    changes.min_booking_minutes ?? existing.min_booking_minutes,
    changes.booking_increment_minutes ??
      existing.booking_increment_minutes,
  );
  return { changes, changedFields };
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > 120) {
    throw new AppError({
      code: 'INVALID_COURT_NAME',
      message: 'Court name must contain between 2 and 120 characters',
      statusCode: 400,
    });
  }
  return name;
}

function normalizeSportTypes(values: string[]): string[] {
  const sports = [
    ...new Set(
      values
        .map((value) =>
          value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
        )
        .filter(Boolean),
    ),
  ];
  if (sports.length === 0 || sports.length > 20) {
    throw new AppError({
      code: 'INVALID_SPORT_TYPES',
      message: 'At least one and at most 20 sport types are required',
      statusCode: 400,
    });
  }
  return sports;
}

function assertBookingMode(value: CourtBookingMode): CourtBookingMode {
  if (!BOOKING_MODES.has(value)) {
    throw new AppError({
      code: 'INVALID_BOOKING_MODE',
      message: 'Court booking mode is invalid',
      statusCode: 400,
    });
  }
  return value;
}

function assertDurations(
  minimumMinutes: number,
  incrementMinutes: number,
): void {
  if (
    !Number.isInteger(minimumMinutes) ||
    minimumMinutes < 60 ||
    minimumMinutes > 1440 ||
    !Number.isInteger(incrementMinutes) ||
    incrementMinutes < 5 ||
    incrementMinutes > minimumMinutes ||
    minimumMinutes % incrementMinutes !== 0
  ) {
    throw new AppError({
      code: 'INVALID_COURT_DURATION',
      message:
        'Minimum booking must be at least 60 minutes and divisible by its increment',
      statusCode: 400,
    });
  }
}

function normalizeOperatingHours(
  values: Array<{
    dayOfWeek: number;
    opensAt: string;
    closesAt: string;
  }>,
): CourtOperatingHourDocument[] {
  const days = new Set<number>();
  const normalized = values.map((value) => {
    if (
      !Number.isInteger(value.dayOfWeek) ||
      value.dayOfWeek < 1 ||
      value.dayOfWeek > 7 ||
      days.has(value.dayOfWeek)
    ) {
      throw new AppError({
        code: 'INVALID_OPERATING_DAY',
        message: 'Operating-hour days must be unique integers from 1 to 7',
        statusCode: 400,
      });
    }
    if (
      !isTime(value.opensAt) ||
      !isTime(value.closesAt) ||
      value.opensAt >= value.closesAt
    ) {
      throw new AppError({
        code: 'INVALID_OPERATING_HOURS',
        message: 'Opening time must be before closing time',
        statusCode: 400,
      });
    }
    days.add(value.dayOfWeek);
    return {
      day_of_week: value.dayOfWeek,
      opens_at: value.opensAt,
      closes_at: value.closesAt,
    };
  });
  return normalized.sort((a, b) => a.day_of_week - b.day_of_week);
}

function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeTimeZone(value: string): string {
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new AppError({
      code: 'INVALID_TIMEZONE',
      message: 'Court timezone must be a valid IANA timezone',
      statusCode: 400,
    });
  }
  return timezone;
}

function presentCourt(court: CourtDocument) {
  return {
    id: court._id.toHexString(),
    venueId: court.venue_id.toHexString(),
    name: court.name,
    sportTypes: court.sport_types,
    bookingMode: court.booking_mode,
    minBookingMinutes: court.min_booking_minutes,
    bookingIncrementMinutes: court.booking_increment_minutes,
    operatingHours: court.operating_hours.map((hours) => ({
      dayOfWeek: hours.day_of_week,
      opensAt: hours.opens_at,
      closesAt: hours.closes_at,
    })),
    timezone: court.timezone,
    media: court.media.map((media) => ({
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
    status: court.status,
    version: court.version,
    createdAt: court.created_at.toISOString(),
    updatedAt: court.updated_at.toISOString(),
  };
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

function courtNotFound(): AppError {
  return new AppError({
    code: 'COURT_NOT_FOUND',
    message: 'Court was not found for this Venue',
    statusCode: 404,
  });
}

function duplicateCourtName(): AppError {
  return new AppError({
    code: 'COURT_NAME_ALREADY_EXISTS',
    message: 'A Court with this name already exists for the Venue',
    statusCode: 409,
  });
}

function courtVersionConflict(currentVersion: number): AppError {
  return new AppError({
    code: 'COURT_VERSION_CONFLICT',
    message: 'The Court was changed by another request',
    statusCode: 409,
    details: { currentVersion },
  });
}

function courtMediaLimitReached(): AppError {
  return new AppError({
    code: 'COURT_MEDIA_LIMIT_REACHED',
    message: `A Court can contain at most ${COURT_MEDIA_MAX_ITEMS} media items`,
    statusCode: 409,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}

function toDeletableResource(
  value: string,
): 'image' | 'video' | 'raw' {
  return value === 'video' || value === 'raw' ? value : 'image';
}
