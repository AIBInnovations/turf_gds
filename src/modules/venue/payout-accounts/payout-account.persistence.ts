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
      'is_default', 'documents', 'version',
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
      is_default: { bsonType: 'bool' },
      documents: { bsonType: 'array', maxItems: 20, items: { bsonType: 'object', additionalProperties: false, required: ['document_id','document_type','provider','storage_key','secure_url','mime_type','original_filename','bytes','checksum','uploaded_at'], properties: {
        document_id:{bsonType:'objectId'},document_type:{bsonType:'string'},provider:{enum:['CLOUDINARY']},storage_key:{bsonType:'string'},secure_url:{bsonType:'string'},mime_type:{bsonType:'string'},original_filename:{bsonType:'string'},bytes:{bsonType:['int','long'],minimum:1},checksum:{bsonType:['string','null']},uploaded_at:{bsonType:'date'},
      } } },
      version: { bsonType: 'int', minimum: 1 },
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
    await db.collection(name).updateMany(
      { $or: [{ is_default: { $exists: false } }, { documents: { $exists: false } }, { version: { $exists: false } }] },
      [{ $set: { is_default: { $ifNull: ['$is_default', false] }, documents: { $ifNull: ['$documents', []] }, version: { $ifNull: ['$version', 1] } } }],
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
    { vault_account_token: 1 },
    { unique: true, name: 'uq_payout_vault_token' },
  );
  await db.collection(name).createIndex(
    { venue_id: 1, status: 1 },
    { name: 'ix_payout_accounts_venue_status' },
  );
  await db.collection(name).createIndex(
    { venue_id: 1, is_default: 1 },
    { unique: true, partialFilterExpression: { is_default: true }, name: 'uq_payout_default_per_venue' },
  );
}
