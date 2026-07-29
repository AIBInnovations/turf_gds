import type { Db, Document } from 'mongodb';

const contractValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'partner_id', 'venue_id', 'status', 'settlement_cycle',
      'settlement_lag_days', 'commission_rate_bps', 'tax_rate_bps',
      'allowed_booking_modes', 'cancellation_terms',
      'resale_cutoff_minutes', 'refund_rules', 'terms_version',
      'effective_from', 'effective_to', 'audit_history', 'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      partner_id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] },
      settlement_cycle: { enum: ['T_PLUS_N', 'WEEKLY', 'MONTHLY'] },
      settlement_lag_days: { bsonType: 'int', minimum: 0 },
      commission_rate_bps: {
        bsonType: 'int', minimum: 0, maximum: 10_000,
      },
      tax_rate_bps: { bsonType: 'int', minimum: 0, maximum: 10_000 },
      allowed_booking_modes: {
        enum: ['OPEN_TIME', 'FIXED_SLOT', 'BOTH'],
      },
      cancellation_terms: { bsonType: 'object' },
      resale_cutoff_minutes: { bsonType: 'int', minimum: 0 },
      refund_rules: { bsonType: 'object' },
      terms_version: { bsonType: 'int', minimum: 1 },
      effective_from: { bsonType: 'date' },
      effective_to: { bsonType: ['date', 'null'] },
      audit_history: { bsonType: 'array' },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
  $expr: {
    $or: [
      { $eq: ['$effective_to', null] },
      { $gt: ['$effective_to', '$effective_from'] },
    ],
  },
};

export async function initializeContractPersistence(db: Db): Promise<void> {
  const name = 'partner_venue_contracts';
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, {
      validator: contractValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: name,
      validator: contractValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db.collection(name).createIndex(
    { partner_id: 1, venue_id: 1, effective_from: 1 },
    { unique: true, name: 'uq_contract_partner_venue_effective' },
  );
  await db.collection(name).createIndex(
    { partner_id: 1, venue_id: 1, status: 1, effective_from: -1 },
    { name: 'ix_contract_effective_lookup' },
  );
}
