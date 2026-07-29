import type { Db, Document } from 'mongodb';

function validator(required: string[], properties: Document, expr?: Document): Document {
  return {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', ...required],
      properties: { _id: { bsonType: 'objectId' }, ...properties },
    },
    ...(expr ? { $expr: expr } : {}),
  };
}

const bookingValidator = validator(
  [
    'slot_id', 'contract_id', 'partner_id', 'venue_id', 'court_id',
    'environment', 'booking_type', 'starts_at', 'ends_at',
    'external_booking_reference', 'confirm_idempotency_key',
    'customer_reference', 'partner_payment_reference', 'status',
    'gross_amount_minor', 'commission_amount_minor', 'tax_amount_minor',
    'venue_net_amount_minor', 'currency', 'cancellation_terms_snapshot',
    'confirmed_at', 'cancelled_at', 'audit_history', 'version',
    'created_at', 'updated_at',
  ],
  {
    slot_id: { bsonType: 'objectId' },
    contract_id: { bsonType: 'objectId' },
    partner_id: { bsonType: 'objectId' },
    venue_id: { bsonType: 'objectId' },
    court_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    booking_type: { enum: ['OPEN_TIME', 'FIXED_SLOT'] },
    starts_at: { bsonType: 'date' },
    ends_at: { bsonType: 'date' },
    external_booking_reference: { bsonType: ['string', 'null'] },
    confirm_idempotency_key: { bsonType: 'string' },
    customer_reference: { bsonType: ['string', 'null'] },
    partner_payment_reference: { bsonType: ['string', 'null'] },
    status: {
      enum: ['CONFIRMED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED'],
    },
    gross_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
    commission_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
    tax_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
    venue_net_amount_minor: { bsonType: ['int', 'long'] },
    currency: { enum: ['INR'] },
    cancellation_terms_snapshot: { bsonType: 'object' },
    confirmed_at: { bsonType: 'date' },
    cancelled_at: { bsonType: ['date', 'null'] },
    audit_history: { bsonType: 'array', maxItems: 100 },
    version: { bsonType: 'int', minimum: 1 },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
  { $lt: ['$starts_at', '$ends_at'] },
);

const cancellationValidator = validator(
  [
    'booking_id', 'requested_by_type', 'requested_by_id', 'reason_code',
    'reason_text', 'refund_percent', 'refund_amount_minor',
    'slot_disposition', 'idempotency_key', 'cancelled_at', 'created_at',
  ],
  {
    booking_id: { bsonType: 'objectId' },
    requested_by_type: { enum: ['PARTNER', 'VENUE', 'PLATFORM', 'SYSTEM'] },
    requested_by_id: { bsonType: ['objectId', 'null'] },
    reason_code: { bsonType: 'string' },
    reason_text: { bsonType: ['string', 'null'] },
    refund_percent: { bsonType: 'int', minimum: 0, maximum: 100 },
    refund_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
    slot_disposition: {
      enum: ['RELEASE_TO_INVENTORY', 'KEEP_UNAVAILABLE'],
    },
    idempotency_key: { bsonType: 'string' },
    cancelled_at: { bsonType: 'date' },
    created_at: { bsonType: 'date' },
  },
);

const idempotencyValidator = validator(
  [
    'partner_id', 'environment', 'idempotency_key', 'operation',
    'request_hash', 'response_status', 'response_body', 'resource_type',
    'resource_id', 'expires_at', 'created_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    idempotency_key: { bsonType: 'string' },
    operation: { bsonType: 'string' },
    request_hash: { bsonType: 'string' },
    response_status: { bsonType: 'int', minimum: 100, maximum: 599 },
    response_body: { bsonType: ['object', 'null'] },
    resource_type: { bsonType: ['string', 'null'] },
    resource_id: { bsonType: ['objectId', 'null'] },
    expires_at: { bsonType: 'date' },
    created_at: { bsonType: 'date' },
  },
);

async function ensure(db: Db, name: string, value: Document): Promise<void> {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, {
      validator: value,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: name,
      validator: value,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
}

export async function initializeBookingPersistence(db: Db): Promise<void> {
  await ensure(db, 'bookings', bookingValidator);
  await ensure(db, 'booking_cancellations', cancellationValidator);
  await ensure(db, 'api_idempotency_records', idempotencyValidator);
  await db.collection('bookings').createIndex(
    { partner_id: 1, environment: 1, confirm_idempotency_key: 1 },
    { unique: true, name: 'uq_booking_confirmation_idempotency' },
  );
  await db.collection('bookings').createIndex(
    { venue_id: 1, starts_at: -1, _id: -1 },
    { name: 'ix_booking_owner_list' },
  );
  await db.collection('booking_cancellations').createIndex(
    { booking_id: 1 },
    { unique: true, name: 'uq_booking_cancellation_booking' },
  );
  await db.collection('api_idempotency_records').createIndex(
    { partner_id: 1, environment: 1, idempotency_key: 1, operation: 1 },
    { unique: true, name: 'uq_api_idempotency_operation' },
  );
  await db.collection('api_idempotency_records').createIndex(
    { expires_at: 1 },
    { expireAfterSeconds: 0, name: 'ttl_api_idempotency' },
  );
}
