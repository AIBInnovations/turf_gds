import type { Db, Document } from 'mongodb';
import { initializeInventoryPersistence } from '../inventory/inventory.persistence.js';
import { initializePayoutAccountPersistence } from '../payout-accounts/payout-account.persistence.js';

const venueValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'legal_name',
      'display_name',
      'environment',
      'timezone',
      'address',
      'geo',
      'currency',
      'media',
      'status',
      'audit_history',
      'version',
      'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      legal_name: { bsonType: 'string', minLength: 2, maxLength: 200 },
      display_name: { bsonType: 'string', minLength: 2, maxLength: 200 },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      timezone: { bsonType: 'string' },
      address: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['line1', 'city', 'state', 'postal_code', 'country'],
        properties: {
          line1: { bsonType: 'string' },
          line2: { bsonType: 'string' },
          city: { bsonType: 'string' },
          state: { bsonType: 'string' },
          postal_code: { bsonType: 'string' },
          country: { bsonType: 'string', minLength: 2, maxLength: 2 },
        },
      },
      geo: {
        bsonType: 'object',
        required: ['type', 'coordinates'],
        properties: {
          type: { enum: ['Point'] },
          coordinates: {
            bsonType: 'array',
            minItems: 2,
            maxItems: 2,
            items: { bsonType: ['double', 'int', 'long', 'decimal'] },
          },
        },
      },
      currency: { enum: ['INR'] },
      media: {
        bsonType: 'array',
        maxItems: 20,
        items: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'provider',
            'storage_key',
            'resource_type',
            'delivery_type',
            'format',
            'bytes',
            'width',
            'height',
            'mime_type',
            'original_filename',
            'secure_url',
            'checksum',
            'created_at',
          ],
          properties: {
            provider: { enum: ['CLOUDINARY'] },
            storage_key: { bsonType: 'string' },
            resource_type: { bsonType: 'string' },
            delivery_type: { bsonType: 'string' },
            format: { bsonType: ['string', 'null'] },
            bytes: { bsonType: ['int', 'long'], minimum: 1 },
            width: { bsonType: ['int', 'long', 'null'] },
            height: { bsonType: ['int', 'long', 'null'] },
            mime_type: { bsonType: 'string' },
            original_filename: { bsonType: 'string' },
            secure_url: { bsonType: 'string' },
            checksum: { bsonType: ['string', 'null'] },
            created_at: { bsonType: 'date' },
          },
        },
      },
      status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
      audit_history: {
        bsonType: 'array',
        maxItems: 100,
        items: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'event_type',
            'actor_type',
            'actor_id',
            'correlation_id',
            'occurred_at',
          ],
          properties: {
            event_type: { bsonType: 'string' },
            actor_type: { enum: ['ADMIN', 'VENUE_OWNER'] },
            actor_id: { bsonType: 'objectId' },
            correlation_id: { bsonType: 'string' },
            changed_fields: {
              bsonType: 'array',
              items: { bsonType: 'string' },
            },
            reason: { bsonType: 'string', maxLength: 1_000 },
            occurred_at: { bsonType: 'date' },
          },
        },
      },
      version: { bsonType: 'int', minimum: 1 },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

const courtValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'venue_id',
      'name',
      'sport_type',
      'surface_type',
      'capacity',
      'status',
      'booking_mode',
      'min_booking_minutes',
      'booking_increment_minutes',
      'operating_hours',
      'fixed_slot_duration_minutes',
      'fixed_slot_anchor_minutes',
      'media',
      'audit_history',
      'version',
      'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      name: { bsonType: 'string', minLength: 2, maxLength: 120 },
      sport_type: {
        enum: [
          'FOOTBALL', 'CRICKET', 'BADMINTON', 'TENNIS', 'PICKLEBALL',
          'MULTI_SPORT', 'OTHER',
        ],
      },
      surface_type: { bsonType: 'string' },
      capacity: { bsonType: 'int', minimum: 1 },
      status: { enum: ['AVAILABLE', 'UNAVAILABLE'] },
      booking_mode: { enum: ['OPEN_TIME', 'FIXED_SLOT', 'BOTH'] },
      min_booking_minutes: {
        bsonType: 'int',
        minimum: 60,
        maximum: 1440,
      },
      booking_increment_minutes: {
        bsonType: 'int',
        minimum: 5,
        maximum: 1440,
      },
      operating_hours: {
        bsonType: 'object',
      },
      fixed_slot_duration_minutes: { bsonType: ['int', 'null'] },
      fixed_slot_anchor_minutes: { bsonType: ['int', 'null'] },
      media: {
        bsonType: 'array',
        maxItems: 20,
        items: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'provider',
            'storage_key',
            'resource_type',
            'delivery_type',
            'format',
            'bytes',
            'width',
            'height',
            'mime_type',
            'original_filename',
            'secure_url',
            'checksum',
            'created_at',
          ],
          properties: {
            provider: { enum: ['CLOUDINARY'] },
            storage_key: { bsonType: 'string' },
            resource_type: { bsonType: 'string' },
            delivery_type: { bsonType: 'string' },
            format: { bsonType: ['string', 'null'] },
            bytes: { bsonType: ['int', 'long'], minimum: 1 },
            width: { bsonType: ['int', 'long', 'null'] },
            height: { bsonType: ['int', 'long', 'null'] },
            mime_type: { bsonType: 'string' },
            original_filename: { bsonType: 'string' },
            secure_url: { bsonType: 'string' },
            checksum: { bsonType: ['string', 'null'] },
            created_at: { bsonType: 'date' },
          },
        },
      },
      audit_history: {
        bsonType: 'array',
        maxItems: 100,
        items: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'event_type',
            'actor_type',
            'actor_id',
            'correlation_id',
            'occurred_at',
          ],
          properties: {
            event_type: { bsonType: 'string' },
            actor_type: { enum: ['ADMIN', 'VENUE_OWNER'] },
            actor_id: { bsonType: 'objectId' },
            correlation_id: { bsonType: 'string' },
            changed_fields: {
              bsonType: 'array',
              items: { bsonType: 'string' },
            },
            reason: { bsonType: 'string', maxLength: 1_000 },
            occurred_at: { bsonType: 'date' },
          },
        },
      },
      version: { bsonType: 'int', minimum: 1 },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

async function ensureVenueCollection(db: Db): Promise<void> {
  const exists = await db
    .listCollections({ name: 'venues' }, { nameOnly: true })
    .hasNext();

  if (!exists) {
    await db.createCollection('venues', {
      validator: venueValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return;
  }

  await db.collection('venues').updateMany(
    { status: { $in: ['DRAFT', 'PENDING_APPROVAL'] } },
    {
      $set: { status: 'PENDING' },
      $unset: { approved_by: '', approved_at: '' },
    },
    { bypassDocumentValidation: true },
  );
  await db.collection('venues').updateMany(
    { $or: [{ approved_by: { $exists: true } }, { approved_at: { $exists: true } }] },
    { $unset: { approved_by: '', approved_at: '' } },
    { bypassDocumentValidation: true },
  );

  await db.command({
    collMod: 'venues',
    validator: venueValidator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

async function ensureCourtCollection(db: Db): Promise<void> {
  const exists = await db
    .listCollections({ name: 'courts' }, { nameOnly: true })
    .hasNext();

  if (!exists) {
    await db.createCollection('courts', {
      validator: courtValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return;
  }

  await db.collection('courts').updateMany(
    { status: { $in: ['ACTIVE', 'INACTIVE'] } },
    [{
      $set: {
        status: {
          $cond: [{ $eq: ['$status', 'ACTIVE'] }, 'AVAILABLE', 'UNAVAILABLE'],
        },
      },
    }],
    { bypassDocumentValidation: true },
  );

  await db.command({
    collMod: 'courts',
    validator: courtValidator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

export async function initializeVenuePersistence(db: Db): Promise<void> {
  await ensureVenueCollection(db);
  await ensureCourtCollection(db);
  await db.collection('venues').createIndex(
    { geo: '2dsphere' },
    { name: 'ix_venues_geo' },
  );
  await db.collection('courts').createIndex(
    { venue_id: 1, status: 1, booking_mode: 1 },
    { name: 'ix_courts_venue_status_mode' },
  );
  await db.collection('venues').createIndex(
    { environment: 1, status: 1 },
    { name: 'ix_venues_environment_status' },
  );
  await db.collection('courts').createIndex(
    { venue_id: 1, name: 1 },
    {
      unique: true,
      name: 'uq_courts_venue_name',
      collation: { locale: 'en', strength: 2 },
    },
  );
  await db.collection('courts').createIndex(
    { venue_id: 1, status: 1, booking_mode: 1 },
    { name: 'ix_courts_venue_status_mode' },
  );
  await initializeInventoryPersistence(db);
  await initializePayoutAccountPersistence(db);
}
