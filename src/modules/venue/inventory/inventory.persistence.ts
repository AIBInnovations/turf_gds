import type {
  CreateIndexesOptions,
  Db,
  Document,
  IndexSpecification,
} from 'mongodb';

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

async function ensureIndex(
  db: Db,
  collectionName: string,
  keys: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  const collection = db.collection(collectionName);
  const existing = (await collection.listIndexes().toArray()).find(
    ({ name }) => name === options.name,
  );
  const differs =
    existing !== undefined &&
    (
      JSON.stringify(existing.key) !== JSON.stringify(keys) ||
      Boolean(existing.unique) !== Boolean(options.unique) ||
      JSON.stringify(existing.partialFilterExpression ?? null) !==
        JSON.stringify(options.partialFilterExpression ?? null)
    );
  if (differs) {
    await collection.dropIndex(options.name);
  }
  await collection.createIndex(keys, options);
}

const pricingRuleValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'court_id', 'name', 'day_of_week', 'start_time',
      'end_time', 'price_minor', 'currency', 'effective_from',
      'effective_to', 'priority', 'active', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      court_id: { bsonType: 'objectId' },
      name: { bsonType: 'string' },
      day_of_week: { bsonType: ['int', 'null'], minimum: 1, maximum: 7 },
      start_time: { bsonType: ['string', 'null'] },
      end_time: { bsonType: ['string', 'null'] },
      price_minor: { bsonType: ['int', 'long'], minimum: 0 },
      currency: { enum: ['INR'] },
      effective_from: { bsonType: 'date' },
      effective_to: { bsonType: ['date', 'null'] },
      priority: { bsonType: 'int' },
      active: { bsonType: 'bool' },
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
      '_id', 'court_id', 'venue_id', 'environment', 'booking_type', 'starts_at',
      'ends_at', 'price_minor', 'currency', 'status', 'hold_id',
      'hold_partner_id', 'hold_expires_at', 'hold_created_at',
      'booking_id', 'source', 'audit_history', 'version', 'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      court_id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      booking_type: { enum: ['OPEN_TIME', 'FIXED_SLOT'] },
      starts_at: { bsonType: 'date' },
      ends_at: { bsonType: 'date' },
      price_minor: { bsonType: ['int', 'long', 'null'], minimum: 0 },
      currency: { enum: ['INR'] },
      status: {
        enum: ['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'],
      },
      hold_id: { bsonType: ['string', 'null'] },
      hold_partner_id: { bsonType: ['objectId', 'null'] },
      hold_expires_at: { bsonType: ['date', 'null'] },
      hold_created_at: { bsonType: ['date', 'null'] },
      booking_id: { bsonType: ['objectId', 'null'] },
      source: {
        enum: ['SYSTEM_GENERATED', 'OWNER_DASHBOARD', 'ADMIN', 'BOOKING'],
      },
      audit_history: { bsonType: 'array', maxItems: 100 },
      version: { bsonType: 'int', minimum: 1 },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeInventoryPersistence(db: Db): Promise<void> {
  await ensure(db, 'pricing_rules', pricingRuleValidator);
  await ensure(db, 'slots', slotValidator);

  await ensureIndex(db, 'pricing_rules',
    { court_id: 1, active: 1, priority: -1 },
    { name: 'ix_pricing_court_status_priority' },
  );
  await ensureIndex(db, 'slots',
    { court_id: 1, environment: 1, starts_at: 1, ends_at: 1 },
    { name: 'ix_slots_overlap' },
  );
  await ensureIndex(db, 'slots',
    { court_id: 1, environment: 1, booking_type: 1, starts_at: 1, ends_at: 1 },
    { unique: true, name: 'uq_slots_court_mode_interval' },
  );
  await ensureIndex(db, 'slots',
    { status: 1, hold_expires_at: 1 },
    { name: 'ix_slots_expired_holds' },
  );
  await ensureIndex(db, 'slots',
    { venue_id: 1, environment: 1, status: 1, starts_at: 1, ends_at: 1 },
    { name: 'ix_slots_admin_inventory_health' },
  );
  await ensureIndex(db, 'slots',
    { hold_id: 1 },
    {
      unique: true,
      partialFilterExpression: { hold_id: { $type: 'string' } },
      name: 'uq_slots_hold_id',
    },
  );
  await ensureIndex(db, 'slots',
    { booking_id: 1 },
    {
      unique: true,
      partialFilterExpression: { booking_id: { $type: 'objectId' } },
      name: 'uq_slots_booking_id',
    },
  );
}
