import {
  ObjectId,
  type ClientSession,
  type Db,
  type Document,
} from 'mongodb';

export interface AuditEventDocument {
  _id: ObjectId;
  aggregate_type: 'BOOKING' | 'SLOT';
  aggregate_id: ObjectId;
  environment: 'SANDBOX' | 'PRODUCTION';
  event_type: string;
  actor_type: string;
  actor_id: ObjectId | null;
  correlation_id: string;
  changes: Record<string, unknown>;
  occurred_at: Date;
  retain_until: Date;
  created_at: Date;
}

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id', 'aggregate_type', 'aggregate_id', 'environment', 'event_type',
      'actor_type', 'actor_id', 'correlation_id', 'changes', 'occurred_at',
      'retain_until', 'created_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      aggregate_type: { enum: ['BOOKING', 'SLOT'] },
      aggregate_id: { bsonType: 'objectId' },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      event_type: { bsonType: 'string' },
      actor_type: { bsonType: 'string' },
      actor_id: { bsonType: ['objectId', 'null'] },
      correlation_id: { bsonType: 'string' },
      changes: { bsonType: 'object' },
      occurred_at: { bsonType: 'date' },
      retain_until: { bsonType: 'date' },
      created_at: { bsonType: 'date' },
    },
  },
};

export async function initializeAuditPersistence(db: Db): Promise<void> {
  const exists = await db
    .listCollections({ name: 'audit_events' }, { nameOnly: true })
    .hasNext();
  if (!exists) {
    await db.createCollection('audit_events', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: 'audit_events',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db.collection('audit_events').createIndex(
    { aggregate_type: 1, aggregate_id: 1, occurred_at: -1 },
    { name: 'ix_audit_aggregate_history' },
  );
  await db.collection('audit_events').createIndex(
    {
      aggregate_type: 1,
      aggregate_id: 1,
      event_type: 1,
      correlation_id: 1,
      occurred_at: 1,
    },
    { unique: true, name: 'uq_audit_event_identity' },
  );
  await db.collection('audit_events').createIndex(
    { retain_until: 1 },
    { expireAfterSeconds: 0, name: 'ttl_audit_retention' },
  );
  await backfillEmbeddedAudit(db, 'bookings', 'BOOKING');
  await backfillEmbeddedAudit(db, 'slots', 'SLOT');
}

export async function archiveAuditEvent(input: {
  db: Db;
  aggregateType: AuditEventDocument['aggregate_type'];
  aggregateId: ObjectId;
  environment: AuditEventDocument['environment'];
  event: Document;
  session?: ClientSession;
}): Promise<void> {
  const occurredAt =
    input.event.occurred_at instanceof Date
      ? input.event.occurred_at
      : new Date();
  const retainUntil = new Date(occurredAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 2);
  await input.db.collection<AuditEventDocument>('audit_events').updateOne(
    {
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: String(input.event.event_type),
      correlation_id: String(input.event.correlation_id),
      occurred_at: occurredAt,
    },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        environment: input.environment,
        event_type: String(input.event.event_type),
        actor_type: String(input.event.actor_type),
        actor_id:
          input.event.actor_id instanceof ObjectId
            ? input.event.actor_id
            : null,
        correlation_id: String(input.event.correlation_id),
        changes: auditChanges(input.event),
        occurred_at: occurredAt,
        retain_until: retainUntil,
        created_at: new Date(),
      },
    },
    {
      upsert: true,
      ...(input.session ? { session: input.session } : {}),
    },
  );
}

async function backfillEmbeddedAudit(
  db: Db,
  collectionName: string,
  aggregateType: AuditEventDocument['aggregate_type'],
): Promise<void> {
  const exists = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!exists) return;
  const cursor = db.collection(collectionName).find(
    { 'audit_history.0': { $exists: true } },
    { projection: { _id: 1, environment: 1, audit_history: 1 } },
  );
  for await (const value of cursor) {
    if (
      !(value._id instanceof ObjectId) ||
      !['SANDBOX', 'PRODUCTION'].includes(value.environment) ||
      !Array.isArray(value.audit_history)
    ) {
      continue;
    }
    for (const event of value.audit_history) {
      await archiveAuditEvent({
        db,
        aggregateType,
        aggregateId: value._id,
        environment: value.environment,
        event,
      });
    }
  }
}

function auditChanges(event: Document): Record<string, unknown> {
  if (event.changes && typeof event.changes === 'object') {
    return event.changes as Record<string, unknown>;
  }
  return {
    previous_status: event.previous_status ?? null,
    new_status: event.new_status ?? null,
    reason: event.reason ?? null,
  };
}
