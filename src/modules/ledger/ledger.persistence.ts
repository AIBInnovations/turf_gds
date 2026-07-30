import type { Db, Document } from 'mongodb';

const ledgerEntryValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'booking_id', 'partner_id', 'venue_id', 'contract_id',
      'settlement_id', 'payout_id', 'reverses_entry_id', 'environment',
      'entry_type', 'direction', 'amount_minor', 'currency',
      'effective_at', 'correlation_id', 'metadata', 'created_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      booking_id: { bsonType: 'objectId' },
      partner_id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      contract_id: { bsonType: 'objectId' },
      settlement_id: { bsonType: ['objectId', 'null'] },
      payout_id: { bsonType: ['objectId', 'null'] },
      reverses_entry_id: { bsonType: ['objectId', 'null'] },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      entry_type: {
        enum: ['BOOKING', 'COMMISSION', 'TAX', 'REFUND', 'REVERSAL', 'ADJUSTMENT'],
      },
      direction: { enum: ['DEBIT', 'CREDIT'] },
      amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
      currency: { enum: ['INR'] },
      effective_at: { bsonType: 'date' },
      correlation_id: { bsonType: 'string' },
      metadata: { bsonType: ['object', 'null'] },
      created_at: { bsonType: 'date' },
    },
  },
};

export async function initializeLedgerPersistence(db: Db): Promise<void> {
  const name = 'ledger_entries';
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, {
      validator: ledgerEntryValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: name,
      validator: ledgerEntryValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db.collection(name).createIndex(
    { booking_id: 1, effective_at: 1 },
    { name: 'ix_ledger_booking' },
  );
  await db.collection(name).createIndex(
    { settlement_id: 1, venue_id: 1 },
    { name: 'ix_ledger_settlement_venue' },
  );
  await db.collection(name).createIndex(
    { payout_id: 1 },
    { name: 'ix_ledger_payout' },
  );
  await db.collection(name).createIndex(
    { partner_id: 1, environment: 1, settlement_id: 1, effective_at: 1 },
    { name: 'ix_ledger_unsettled_batch' },
  );
  await db.collection(name).createIndex(
    { reverses_entry_id: 1 },
    {
      partialFilterExpression: { reverses_entry_id: { $type: 'objectId' } },
      name: 'ix_ledger_reversal_reference',
    },
  );
  await db.collection(name).createIndex(
    { correlation_id: 1 },
    { name: 'ix_ledger_correlation' },
  );
  await db.collection(name).createIndex(
    {
      environment: 1,
      effective_at: 1,
      venue_id: 1,
      partner_id: 1,
      entry_type: 1,
    },
    { name: 'ix_ledger_admin_revenue_report' },
  );
}
