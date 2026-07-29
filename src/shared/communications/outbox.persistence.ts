import type { Db, Document } from 'mongodb';

const validator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'aggregate_type', 'aggregate_id', 'partner_id', 'venue_id',
      'environment', 'event_type', 'event_version', 'correlation_id',
      'payload', 'status', 'attempts', 'available_at', 'locked_by',
      'locked_until', 'webhook_endpoint_ids', 'published_at',
      'webhook_deliveries', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      aggregate_type: { bsonType: 'string' },
      aggregate_id: { bsonType: 'objectId' },
      partner_id: { bsonType: ['objectId', 'null'] },
      venue_id: { bsonType: ['objectId', 'null'] },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      event_type: { bsonType: 'string' },
      event_version: { bsonType: 'int', minimum: 1 },
      correlation_id: { bsonType: 'string' },
      payload: { bsonType: 'object' },
      status: { enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'] },
      attempts: { bsonType: 'int', minimum: 0 },
      available_at: { bsonType: 'date' },
      locked_by: { bsonType: ['string', 'null'] },
      locked_until: { bsonType: ['date', 'null'] },
      webhook_endpoint_ids: {
        bsonType: 'array',
        items: { bsonType: 'objectId' },
      },
      published_at: { bsonType: ['date', 'null'] },
      webhook_deliveries: { bsonType: 'array' },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeOutboxPersistence(db: Db): Promise<void> {
  const name = 'outbox_events';
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: name,
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db.collection(name).createIndex(
    { status: 1, available_at: 1, locked_until: 1 },
    { name: 'ix_outbox_dispatch' },
  );
  await db.collection(name).createIndex(
    { aggregate_type: 1, aggregate_id: 1, event_version: 1 },
    { unique: true, name: 'uq_outbox_aggregate_version' },
  );
}
