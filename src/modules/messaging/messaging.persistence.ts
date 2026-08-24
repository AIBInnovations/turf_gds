import type { Db, Document } from 'mongodb';

/**
 * `admin_messages` — one document per message, append-only.
 *
 * Body is capped at 8 KB: long enough for any operational note, short enough that a thread page
 * of 50 stays well inside a single response, and small enough that a runaway paste cannot fill
 * the collection.
 */

const validator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'thread_key',
      'recipient_type',
      'recipient_id',
      'direction',
      'sender_admin_id',
      'sender_name',
      'subject',
      'body',
      'read_at',
      'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      thread_key: { bsonType: 'string', minLength: 1, maxLength: 64 },
      recipient_type: { enum: ['PARTNER', 'VENUE_OWNER'] },
      recipient_id: { bsonType: 'objectId' },
      direction: { enum: ['OUTBOUND', 'INBOUND'] },
      sender_admin_id: { bsonType: ['objectId', 'null'] },
      sender_name: { bsonType: 'string', minLength: 1, maxLength: 200 },
      subject: { bsonType: 'string', maxLength: 200 },
      body: { bsonType: 'string', minLength: 1, maxLength: 8_192 },
      read_at: { bsonType: ['date', 'null'] },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

export async function initializeMessagingPersistence(db: Db): Promise<void> {
  const name = 'admin_messages';
  const exists = await db
    .listCollections({ name }, { nameOnly: true })
    .hasNext();

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

  // Every read is "this thread, newest first" or "these threads, newest first".
  await db
    .collection(name)
    .createIndex({ thread_key: 1, created_at: -1 }, { name: 'ix_messages_thread' });

  // The unread badge counts inbound replies nobody has opened yet.
  await db
    .collection(name)
    .createIndex(
      { direction: 1, read_at: 1, created_at: -1 },
      { name: 'ix_messages_unread' },
    );

  // A recipient reads only their own thread, and always newest first.
  await db
    .collection(name)
    .createIndex(
      { recipient_type: 1, recipient_id: 1, created_at: -1 },
      { name: 'ix_messages_recipient' },
    );
}
