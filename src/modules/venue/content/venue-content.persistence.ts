import type { Db, Document } from 'mongodb';

const validator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'venue_id', 'locale', 'content', 'version',
      'updated_by_type', 'updated_by_id', 'created_at', 'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      locale: { bsonType: 'string', minLength: 2, maxLength: 35 },
      content: { bsonType: 'object' },
      version: { bsonType: 'int', minimum: 1 },
      updated_by_type: { enum: ['VENUE_OWNER'] },
      updated_by_id: { bsonType: 'objectId' },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeVenueContentPersistence(db: Db): Promise<void> {
  const name = 'venue_contents';
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
  } else {
    await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
  }
  await db.collection(name).createIndex(
    { venue_id: 1, locale: 1 },
    { unique: true, name: 'uq_venue_content_locale' },
  );
}
