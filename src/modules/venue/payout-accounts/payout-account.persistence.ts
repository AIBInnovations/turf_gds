import type { Db, Document } from 'mongodb';

const validator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'venue_id', 'account_holder_name', 'vault_provider',
      'vault_account_token', 'account_last4', 'bank_name', 'ifsc_code',
      'status', 'verified_by', 'verified_at',
      'verification_failure_reason', 'verification_method',
      'audit_history', 'created_at', 'updated_at',
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
      verification_method: { enum: ['PENNY_DROP', 'MANUAL'] },
      audit_history: { bsonType: 'array', maxItems: 100 },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializePayoutAccountPersistence(db: Db): Promise<void> {
  const name = 'venue_payout_accounts';
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
    { vault_account_token: 1 },
    { unique: true, name: 'uq_payout_vault_token' },
  );
  await db.collection(name).createIndex(
    { venue_id: 1, status: 1 },
    { name: 'ix_payout_accounts_venue_status' },
  );
}
