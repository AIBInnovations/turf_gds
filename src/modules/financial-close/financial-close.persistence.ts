import type { Db, Document } from 'mongodb';

function schema(required: string[], properties: Document): Document {
  return {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', ...required],
      properties: { _id: { bsonType: 'objectId' }, ...properties },
    },
  };
}

const money = { bsonType: ['int', 'long'] };
const nullableDate = { bsonType: ['date', 'null'] };
const environment = { enum: ['SANDBOX', 'PRODUCTION'] };

const settlement = schema(
  [
    'partner_id', 'environment', 'period_start', 'period_end',
    'cycle', 'due_at', 'status', 'gross_amount_minor',
    'commission_amount_minor', 'tax_amount_minor', 'refund_amount_minor',
    'net_amount_minor', 'currency', 'audit_history', 'created_at',
    'completed_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment,
    period_start: { bsonType: 'date' },
    period_end: { bsonType: 'date' },
    cycle: { enum: ['T_PLUS_N', 'WEEKLY', 'MONTHLY'] },
    due_at: { bsonType: 'date' },
    status: {
      enum: [
        'DRAFT', 'PENDING_FUNDS', 'RECONCILING', 'RECONCILED',
        'COMPLETED', 'FAILED', 'REVERSED',
      ],
    },
    gross_amount_minor: money,
    commission_amount_minor: money,
    tax_amount_minor: money,
    refund_amount_minor: money,
    net_amount_minor: money,
    currency: { enum: ['INR'] },
    audit_history: { bsonType: 'array', maxItems: 100 },
    created_at: { bsonType: 'date' },
    completed_at: nullableDate,
  },
);

const reconciliation = schema(
  [
    'settlement_id', 'environment', 'reconciled_by', 'reported_amount_minor',
    'bank_reference', 'evidence_uri', 'status', 'reconciled_at', 'notes',
    'attempt_history', 'audit_history', 'created_at',
  ],
  {
    settlement_id: { bsonType: 'objectId' },
    environment,
    reconciled_by: { bsonType: ['objectId', 'null'] },
    reported_amount_minor: money,
    bank_reference: { bsonType: ['string', 'null'] },
    evidence_uri: { bsonType: ['string', 'null'] },
    status: { enum: ['PENDING', 'MATCHED', 'MISMATCH', 'RESOLVED'] },
    reconciled_at: nullableDate,
    notes: { bsonType: ['string', 'null'] },
    attempt_history: { bsonType: 'array', maxItems: 100 },
    audit_history: { bsonType: 'array', maxItems: 100 },
    created_at: { bsonType: 'date' },
  },
);

const payout = schema(
  [
    'settlement_id', 'venue_id', 'payout_account_id', 'environment',
    'amount_minor', 'currency', 'status', 'idempotency_key',
    'bank_reference', 'failure_reason', 'initiated_at', 'paid_at',
    'audit_history', 'created_at', 'updated_at',
  ],
  {
    settlement_id: { bsonType: 'objectId' },
    venue_id: { bsonType: 'objectId' },
    payout_account_id: { bsonType: 'objectId' },
    environment,
    amount_minor: money,
    currency: { enum: ['INR'] },
    status: { enum: ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED'] },
    idempotency_key: { bsonType: 'string' },
    bank_reference: { bsonType: ['string', 'null'] },
    failure_reason: { bsonType: ['string', 'null'] },
    initiated_at: nullableDate,
    paid_at: nullableDate,
    audit_history: { bsonType: 'array', maxItems: 100 },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const invoice = schema(
  [
    'settlement_id', 'environment', 'invoice_number', 'type',
    'subtotal_minor', 'tax_amount_minor', 'total_minor',
    'currency', 'status', 'document_uri', 'issued_at', 'created_at',
  ],
  {
    settlement_id: { bsonType: 'objectId' },
    environment,
    invoice_number: { bsonType: 'string' },
    type: { enum: ['TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
    subtotal_minor: money,
    tax_amount_minor: money,
    total_minor: money,
    currency: { enum: ['INR'] },
    status: { enum: ['DRAFT', 'ISSUED', 'VOID'] },
    document_uri: { bsonType: ['string', 'null'] },
    issued_at: nullableDate,
    created_at: { bsonType: 'date' },
  },
);

async function ensure(db: Db, name: string, validator: Document): Promise<void> {
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
}

export async function initializeFinancialClosePersistence(db: Db): Promise<void> {
  await migrateLegacyFinancialCloseFields(db);
  await ensure(db, 'settlements', settlement);
  await ensure(db, 'reconciliations', reconciliation);
  await ensure(db, 'payouts', payout);
  await ensure(db, 'invoices', invoice);
  await db.collection('settlements').createIndex(
    { partner_id: 1, environment: 1, period_start: 1, period_end: 1 },
    { unique: true, name: 'uq_settlement_period' },
  );
  await dropIndexIfPresent(
    db,
    'reconciliations',
    'uq_reconciliation_settlement',
  );
  await db.collection('reconciliations').createIndex(
    { settlement_id: 1, bank_reference: 1 },
    {
      unique: true,
      partialFilterExpression: { bank_reference: { $type: 'string' } },
      name: 'uq_reconciliation_bank_reference',
    },
  );
  await db.collection('payouts').createIndex(
    { idempotency_key: 1 },
    { unique: true, name: 'uq_payout_idempotency' },
  );
  await db.collection('payouts').createIndex(
    { settlement_id: 1, venue_id: 1 },
    { unique: true, name: 'uq_payout_settlement_venue' },
  );
  await db.collection('payouts').createIndex(
    { environment: 1, bank_reference: 1 },
    {
      unique: true,
      partialFilterExpression: { bank_reference: { $type: 'string' } },
      name: 'uq_payout_environment_bank_reference',
    },
  );
  await db.collection('invoices').createIndex(
    { invoice_number: 1 },
    { unique: true, name: 'uq_invoice_number' },
  );
  await db.collection('invoices').createIndex(
    { settlement_id: 1, type: 1 },
    { unique: true, name: 'uq_invoice_settlement_type' },
  );
}

async function migrateLegacyFinancialCloseFields(db: Db): Promise<void> {
  if (
    await db
      .listCollections({ name: 'settlements' }, { nameOnly: true })
      .hasNext()
  ) {
    await db.command({ collMod: 'settlements', validationLevel: 'off' });
    await db.collection('settlements').updateMany(
      { settlement_cycle: { $exists: true }, cycle: { $exists: false } },
      { $rename: { settlement_cycle: 'cycle' } },
    );
  }
  if (
    await db
      .listCollections({ name: 'invoices' }, { nameOnly: true })
      .hasNext()
  ) {
    await db.command({ collMod: 'invoices', validationLevel: 'off' });
    await db.collection('invoices').updateMany(
      {
        $or: [
          { subtotal_amount_minor: { $exists: true } },
          { total_amount_minor: { $exists: true } },
        ],
      },
      {
        $rename: {
          subtotal_amount_minor: 'subtotal_minor',
          total_amount_minor: 'total_minor',
        },
      },
    );
  }
}

async function dropIndexIfPresent(
  db: Db,
  collectionName: string,
  indexName: string,
): Promise<void> {
  const exists = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!exists) return;
  const indexes = await db.collection(collectionName).indexes();
  if (indexes.some(({ name }) => name === indexName)) {
    await db.collection(collectionName).dropIndex(indexName);
  }
}
