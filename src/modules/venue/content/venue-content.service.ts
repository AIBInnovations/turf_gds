import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { VenueContentRepository } from './venue-content.repository.js';
import type { VenueContentDocument } from './venue-content.types.js';
import type { OwnerEventPublisher } from '../../../shared/communications/owner-event-publisher.js';

export interface VenueContentService {
  get(input: { actorOwnerId: string; venueId: string; locale?: string }): Promise<object>;
  put(input: {
    actorOwnerId: string;
    venueId: string;
    locale?: string;
    version?: number;
    content: Record<string, unknown>;
    correlationId: string;
  }): Promise<object>;
}

export function createVenueContentService(input: {
  repository: VenueContentRepository;
  ownerAccessService: OwnerAccessService;
  events?: OwnerEventPublisher;
  now?: () => Date;
}): VenueContentService {
  const now = input.now ?? (() => new Date());
  return {
    async get(values) {
      await input.ownerAccessService.requireVenueMembership(values.actorOwnerId, values.venueId);
      const locale = normalizeLocale(values.locale);
      const value = await input.repository.find(oid(values.venueId), locale);
      return value ? present(value) : { venueId: values.venueId, locale, content: {}, version: 0 };
    },
    async put(values) {
      await input.ownerAccessService.requirePermission(values.actorOwnerId, values.venueId, 'MANAGE_VENUE');
      validateContent(values.content);
      const venueId = oid(values.venueId);
      const ownerId = oid(values.actorOwnerId);
      const locale = normalizeLocale(values.locale);
      const existing = await input.repository.find(venueId, locale);
      const expected = existing ? values.version! : null;
      if (existing && (!Number.isInteger(values.version) || values.version !== existing.version)) {
        throw conflict();
      }
      if (!existing && values.version !== undefined && values.version !== 0) throw conflict();
      const timestamp = now();
      const document: VenueContentDocument = {
        _id: existing?._id ?? new ObjectId(), venue_id: venueId, locale,
        content: values.content, version: existing?.version ?? 1,
        updated_by_type: 'VENUE_OWNER', updated_by_id: ownerId,
        created_at: existing?.created_at ?? timestamp, updated_at: timestamp,
      };
      const saved = await input.repository.save({ document, expectedVersion: expected });
      if (!saved) throw conflict();
      await input.events?.publish({aggregateType:'VENUE',aggregateId:saved._id,venueId,eventType:'VENUE_UPDATED',eventVersion:saved.version,correlationId:values.correlationId,payload:{venueId:values.venueId,locale,changedFields:['content']},now:saved.updated_at});
      return present(saved);
    },
  };
}

function validateContent(content: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(content));
  if (bytes > 256 * 1024) throw new AppError({ code: 'VENUE_CONTENT_TOO_LARGE', message: 'Venue content must not exceed 256 KiB', statusCode: 413 });
  for (const key of Object.keys(content)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw new AppError({ code: 'INVALID_VENUE_CONTENT_KEY', message: `Invalid venue content key: ${key}`, statusCode: 400 });
    }
  }
}

function present(value: VenueContentDocument) {
  return { venueId: value.venue_id.toHexString(), locale: value.locale, content: value.content, version: value.version, updatedAt: value.updated_at.toISOString() };
}
function normalizeLocale(value = 'en-IN') { const locale = value.trim(); if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new AppError({ code: 'INVALID_LOCALE', message: 'locale is invalid', statusCode: 400 }); return locale; }
function oid(value: string) { if (!ObjectId.isValid(value)) throw new AppError({ code: 'INVALID_ID', message: 'Identifier is invalid', statusCode: 400 }); return new ObjectId(value); }
function conflict() { return new AppError({ code: 'VENUE_CONTENT_VERSION_CONFLICT', message: 'Venue content changed concurrently', statusCode: 409 }); }
