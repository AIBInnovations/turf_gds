import type { Db, Document } from 'mongodb';

async function ensure(
  db: Db,
  name: string,
  validator: Document,
): Promise<void> {
  const exists = await db
    .listCollections({ name }, { nameOnly: true })
    .hasNext();
  if (!exists) {
    await db.createCollection(name, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return;
  }
  await db.command({
    collMod: name,
    validator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

const pricingRuleValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'court_id', 'name', 'days_of_week', 'starts_time',
      'ends_time', 'amount_minor', 'currency', 'effective_from',
      'effective_to', 'priority', 'status', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      court_id: { bsonType: 'objectId' },
      name: { bsonType: 'string' },
      days_of_week: {
        bsonType: 'array',
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
        items: { bsonType: 'int', minimum: 1, maximum: 7 },
      },
      starts_time: { bsonType: 'string' },
      ends_time: { bsonType: 'string' },
      amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
      currency: { enum: ['INR'] },
      effective_from: { bsonType: 'date' },
      effective_to: { bsonType: ['date', 'null'] },
      priority: { bsonType: 'int' },
      status: { enum: ['ACTIVE', 'INACTIVE'] },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

const slotValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'court_id', 'environment', 'booking_mode', 'starts_at',
      'ends_at', 'price_amount_minor', 'currency', 'status', 'hold_id',
      'hold_partner_id', 'hold_expires_at', 'hold_created_at',
      'generation_source', 'audit_history', 'version', 'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      court_id: { bsonType: 'objectId' },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      booking_mode: { enum: ['OPEN_TIME', 'FIXED_SLOT'] },
      starts_at: { bsonType: 'date' },
      ends_at: { bsonType: 'date' },
      price_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
      currency: { enum: ['INR'] },
      status: {
        enum: ['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'],
      },
      hold_id: { bsonType: ['string', 'null'] },
      hold_partner_id: { bsonType: ['objectId', 'null'] },
      hold_expires_at: { bsonType: ['date', 'null'] },
      hold_created_at: { bsonType: ['date', 'null'] },
      generation_source: { bsonType: 'string' },
      audit_history: { bsonType: 'array', maxItems: 100 },
      version: { bsonType: 'int', minimum: 1 },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

const contentValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'venue_id', 'content', 'version', 'updated_by_type',
      'updated_by_id', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      content: { bsonType: 'object' },
      version: { bsonType: 'int', minimum: 1 },
      updated_by_type: { enum: ['ADMIN_USER', 'VENUE_OWNER'] },
      updated_by_id: { bsonType: 'objectId' },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

const payoutAccountValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'venue_id', 'account_holder_name', 'vault_provider',
      'vault_account_token', 'account_last4', 'bank_name', 'ifsc_code',
      'status', 'verified_by', 'verified_at',
      'verification_failure_reason', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      account_holder_name: { bsonType: 'string' },
      vault_provider: { bsonType: 'string' },
      vault_account_token: { bsonType: 'string' },
      account_last4: { bsonType: 'string', pattern: '^[0-9]{4}$' },
      bank_name: { bsonType: 'string' },
      ifsc_code: { bsonType: 'string' },
      status: { enum: ['PENDING', 'VERIFIED', 'DISABLED'] },
      verified_by: { bsonType: ['objectId', 'null'] },
      verified_at: { bsonType: ['date', 'null'] },
      verification_failure_reason: { bsonType: ['string', 'null'] },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeInventoryPersistence(db: Db): Promise<void> {
  await ensure(db, 'pricing_rules', pricingRuleValidator);
  await ensure(db, 'slots', slotValidator);
  await ensure(db, 'venue_contents', contentValidator);
  await ensure(db, 'venue_payout_accounts', payoutAccountValidator);

  await db.collection('pricing_rules').createIndex(
    { court_id: 1, status: 1, priority: -1 },
    { name: 'ix_pricing_court_status_priority' },
  );
  await db.collection('slots').createIndex(
    { court_id: 1, environment: 1, starts_at: 1, ends_at: 1 },
    { name: 'ix_slots_overlap' },
  );
  await db.collection('slots').createIndex(
    { court_id: 1, environment: 1, booking_mode: 1, starts_at: 1, ends_at: 1 },
    { unique: true, name: 'uq_slots_court_mode_interval' },
  );
  await db.collection('slots').createIndex(
    { status: 1, hold_expires_at: 1 },
    { name: 'ix_slots_expired_holds' },
  );
  await db.collection('venue_contents').createIndex(
    { venue_id: 1 },
    { unique: true, name: 'uq_venue_content' },
  );
  await db.collection('venue_payout_accounts').createIndex(
    { vault_account_token: 1 },
    { unique: true, name: 'uq_payout_vault_token' },
  );
  await db.collection('venue_payout_accounts').createIndex(
    { venue_id: 1, status: 1 },
    { name: 'ix_payout_accounts_venue_status' },
  );
}
