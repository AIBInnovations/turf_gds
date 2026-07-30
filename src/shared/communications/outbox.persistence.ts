import type { Db, Document } from 'mongodb';

const attemptSchema: Document = {
  bsonType: 'object',
  additionalProperties: false,
  required: [
    'attempted_at', 'request_payload', 'redacted_headers', 'response_code',
    'response_payload', 'error', 'completed_at',
  ],
  properties: {
    attempted_at: { bsonType: 'date' },
    request_payload: { bsonType: 'string', maxLength: 16_384 },
    redacted_headers: { bsonType: 'object' },
    response_code: { bsonType: ['int', 'null'] },
    response_payload: { bsonType: ['string', 'null'], maxLength: 4_096 },
    error: { bsonType: ['string', 'null'], maxLength: 1_000 },
    completed_at: { bsonType: 'date' },
  },
};

const deliverySchema: Document = {
  bsonType: 'object',
  additionalProperties: false,
  required: [
    'endpoint_id', 'status', 'attempt_count', 'next_attempt_at', 'last_error',
    'delivered_at', 'attempts', 'created_at', 'updated_at',
  ],
  properties: {
    endpoint_id: { bsonType: 'objectId' },
    status: { enum: ['PENDING', 'RETRYING', 'DELIVERED', 'FAILED'] },
    attempt_count: { bsonType: 'int', minimum: 0, maximum: 8 },
    next_attempt_at: { bsonType: ['date', 'null'] },
    last_error: { bsonType: ['string', 'null'], maxLength: 1_000 },
    delivered_at: { bsonType: ['date', 'null'] },
    attempts: {
      bsonType: 'array',
      maxItems: 8,
      items: attemptSchema,
    },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
};

const validator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'aggregate_type', 'aggregate_id', 'partner_id', 'venue_id',
      'environment', 'event_type', 'event_version', 'correlation_id',
      'payload', 'status', 'attempts', 'available_at', 'locked_by',
      'locked_until', 'webhook_endpoint_ids',
      'published_at',
      'webhook_deliveries', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      aggregate_type: { bsonType: 'string', minLength: 1, maxLength: 100 },
      aggregate_id: { bsonType: 'objectId' },
      partner_id: { bsonType: ['objectId', 'null'] },
      venue_id: { bsonType: ['objectId', 'null'] },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      event_type: { bsonType: 'string', minLength: 1, maxLength: 100 },
      event_version: { bsonType: 'int', minimum: 1 },
      correlation_id: { bsonType: 'string', minLength: 1, maxLength: 200 },
      payload: { bsonType: 'object' },
      status: { enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'] },
      attempts: { bsonType: 'int', minimum: 0 },
      available_at: { bsonType: 'date' },
      locked_by: { bsonType: ['string', 'null'] },
      locked_until: { bsonType: ['date', 'null'] },
      webhook_endpoint_ids: {
        bsonType: 'array',
        maxItems: 20,
        uniqueItems: true,
        items: { bsonType: 'objectId' },
      },
      published_at: { bsonType: ['date', 'null'] },
      webhook_deliveries: {
        bsonType: 'array',
        maxItems: 20,
        items: deliverySchema,
      },
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
    await db.collection(name).updateMany(
      {},
      [
        {
          $set: {
            webhook_endpoint_ids: {
              $slice: [{ $ifNull: ['$webhook_endpoint_ids', []] }, 20],
            },
            webhook_deliveries: {
              $slice: [
                {
                  $map: {
                    input: { $ifNull: ['$webhook_deliveries', []] },
                    as: 'delivery',
                    in: {
                      $mergeObjects: [
                        '$$delivery',
                        {
                          attempts: {
                            $slice: [
                              { $ifNull: ['$$delivery.attempts', []] },
                              -8,
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
                -20,
              ],
            },
          },
        },
        { $unset: 'owner_notifications_published_at' },
      ],
      { bypassDocumentValidation: true },
    );
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
    {
      'webhook_deliveries.status': 1,
      'webhook_deliveries.next_attempt_at': 1,
    },
    { name: 'ix_outbox_webhook_delivery_due' },
  );
  const indexes = await db.collection(name).indexes();
  if (indexes.some(({ name: indexName }) =>
    indexName === 'uq_outbox_aggregate_version')) {
    await db.collection(name).dropIndex('uq_outbox_aggregate_version');
  }
  await db.collection(name).createIndex(
    {
      aggregate_type: 1,
      aggregate_id: 1,
      event_type: 1,
      correlation_id: 1,
    },
    { unique: true, name: 'uq_outbox_event_identity' },
  );
}
