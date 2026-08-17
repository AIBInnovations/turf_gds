import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';

import { ObjectId } from 'mongodb';

import { createInventorySyncService } from '../src/modules/inventory-sync/inventory-sync.service.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const MASTER_SECRET = 'test-master-secret-with-at-least-32-chars';

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$nor') {
      const clauses = condition as Record<string, unknown>[];
      return !clauses.some((clause) => matchesFilter(doc, clause));
    }
    const value = doc[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof ObjectId)) {
      const operators = condition as Record<string, unknown>;
      return Object.entries(operators).every(([op, operand]) => {
        if (op === '$in') return (operand as unknown[]).some((item) => equalsValue(value, item));
        if (op === '$nin') return !(operand as unknown[]).some((item) => equalsValue(value, item));
        if (op === '$lt') return (value as Date).getTime() < (operand as Date).getTime();
        if (op === '$gt') return (value as Date).getTime() > (operand as Date).getTime();
        if (op === '$ne') return !equalsValue(value, operand);
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return equalsValue(value, condition);
  });
}

function equalsValue(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$inc) {
    for (const [key, amount] of Object.entries(update.$inc as Record<string, number>)) {
      doc[key] = ((doc[key] as number) ?? 0) + amount;
    }
  }
}

function createFakeDatabase(options: { forceCourtLockFailure?: () => boolean } = {}) {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const store = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const idOf = (doc: Record<string, unknown>) => (doc._id as ObjectId).toHexString();

  function makeCollection(name: string) {
    const map = store(name);
    return {
      async findOne(filter: Record<string, unknown>) {
        for (const doc of map.values()) if (matchesFilter(doc, filter)) return doc;
        return null;
      },
      async insertOne(doc: Record<string, unknown>) {
        map.set(idOf(doc), doc);
        return { insertedId: doc._id };
      },
      async updateOne(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        updateOptions: { upsert?: boolean } = {},
      ) {
        if (name === 'courts' && options.forceCourtLockFailure?.()) {
          return { modifiedCount: 0, upsertedCount: 0 };
        }
        for (const doc of map.values()) {
          if (matchesFilter(doc, filter)) {
            applyUpdate(doc, update);
            return { modifiedCount: 1, upsertedCount: 0 };
          }
        }
        if (updateOptions.upsert) {
          const inserted: Record<string, unknown> = {
            ...filter,
            ...(update.$setOnInsert as Record<string, unknown> | undefined),
          };
          applyUpdate(inserted, update);
          map.set(idOf(inserted), inserted);
          return { modifiedCount: 0, upsertedCount: 1 };
        }
        return { modifiedCount: 0, upsertedCount: 0 };
      },
      find(filter: Record<string, unknown> = {}) {
        const results = [...map.values()].filter((doc) => matchesFilter(doc, filter));
        const cursor = {
          sort: () => cursor,
          limit: () => cursor,
          toArray: async () => results,
        };
        return cursor;
      },
      async deleteMany(filter: Record<string, unknown>) {
        let deletedCount = 0;
        for (const [key, doc] of [...map.entries()]) {
          if (matchesFilter(doc, filter)) {
            map.delete(key);
            deletedCount += 1;
          }
        }
        return { deletedCount };
      },
    };
  }

  const db = { collection: (name: string) => makeCollection(name) };
  const database: DatabaseConnection = {
    db: db as never,
    async connect() {},
    async ping() {},
    async close() {},
    async withTransaction(operation) {
      return operation({ db: db as never, session: {} as never });
    },
  };
  return { database, store };
}

function seedVenueAndCourt(
  store: (name: string) => Map<string, Record<string, unknown>>,
  venueId: ObjectId,
  courtId: ObjectId,
  courtVersion = 1,
) {
  store('venues').set(venueId.toHexString(), { _id: venueId });
  store('courts').set(courtId.toHexString(), {
    _id: courtId,
    venue_id: venueId,
    version: courtVersion,
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
  });
}

async function setupConnector(service: ReturnType<typeof createInventorySyncService>, venueId: ObjectId, courtId: ObjectId) {
  const created = await service.createConnector({
    venueId: venueId.toHexString(),
    environment: 'SANDBOX',
    name: 'Reference PMS',
    adminId: new ObjectId().toHexString(),
  }) as { connectorId: string; webhookSecret: string };
  await service.mapCourt({
    connectorId: created.connectorId,
    courtId: courtId.toHexString(),
    externalCourtId: 'ext-court-1',
  });
  return created;
}

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

type ExternalEventType = 'AVAILABILITY_BLOCKED' | 'AVAILABILITY_RELEASED' | 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED';

function eventBody(overrides: Partial<{ eventId: string; version: number; type: ExternalEventType; startsAt: string; endsAt: string }> = {}) {
  return {
    eventId: overrides.eventId ?? 'evt-1',
    version: overrides.version ?? 1,
    type: overrides.type ?? 'AVAILABILITY_BLOCKED',
    externalCourtId: 'ext-court-1',
    startsAt: overrides.startsAt ?? '2026-08-10T10:00:00.000Z',
    endsAt: overrides.endsAt ?? '2026-08-10T11:00:00.000Z',
  };
}

test('receiveReferenceEvent CAS-locks the court and records COURT_LOCK_CONTENTION when the lock is contended', async () => {
  let forceLockFailure = false;
  const { database, store } = createFakeDatabase({ forceCourtLockFailure: () => forceLockFailure });
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  seedVenueAndCourt(store, venueId, courtId);
  const service = createInventorySyncService(database, MASTER_SECRET, () => new Date('2026-08-01T00:00:00.000Z'));
  const connector = await setupConnector(service, venueId, courtId);

  // Simulate another concurrent transaction winning the CAS lock on this court first.
  forceLockFailure = true;

  const body = eventBody();
  const raw = Buffer.from(JSON.stringify(body));
  const result = await service.receiveReferenceEvent({
    connectorId: connector.connectorId,
    signature: sign(raw, connector.webhookSecret),
    rawBody: raw,
    event: body,
  }) as { status: string };

  assert.equal(result.status, 'CONFLICT');
  const conflicts = [...store('inventory_conflicts').values()];
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.type, 'COURT_LOCK_CONTENTION');
});

test('receiveReferenceEvent applies successfully and bumps the court version when uncontended', async () => {
  const { database, store } = createFakeDatabase();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  seedVenueAndCourt(store, venueId, courtId, 5);
  const service = createInventorySyncService(database, MASTER_SECRET, () => new Date('2026-08-01T00:00:00.000Z'));
  const connector = await setupConnector(service, venueId, courtId);

  const body = eventBody();
  const raw = Buffer.from(JSON.stringify(body));
  const result = await service.receiveReferenceEvent({
    connectorId: connector.connectorId,
    signature: sign(raw, connector.webhookSecret),
    rawBody: raw,
    event: body,
  }) as { status: string };

  assert.equal(result.status, 'APPLIED');
  assert.equal(store('courts').get(courtId.toHexString())?.version, 6);
  assert.equal(store('slots').size, 1);
});

test('receiveReferenceEvent flags an overlapping BLOCKED slot from a different interval as a conflict', async () => {
  const { database, store } = createFakeDatabase();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  seedVenueAndCourt(store, venueId, courtId);
  const service = createInventorySyncService(database, MASTER_SECRET, () => new Date('2026-08-01T00:00:00.000Z'));
  const connector = await setupConnector(service, venueId, courtId);

  const existingSlotId = new ObjectId();
  store('slots').set(existingSlotId.toHexString(), {
    _id: existingSlotId,
    court_id: courtId,
    venue_id: venueId,
    environment: 'SANDBOX',
    booking_type: 'OPEN_TIME',
    starts_at: new Date('2026-08-10T10:30:00.000Z'),
    ends_at: new Date('2026-08-10T11:30:00.000Z'),
    status: 'BLOCKED',
    version: 1,
  });

  const body = eventBody();
  const raw = Buffer.from(JSON.stringify(body));
  const result = await service.receiveReferenceEvent({
    connectorId: connector.connectorId,
    signature: sign(raw, connector.webhookSecret),
    rawBody: raw,
    event: body,
  }) as { status: string };

  assert.equal(result.status, 'CONFLICT');
  const conflicts = [...store('inventory_conflicts').values()];
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.type, 'OVERLAPPING_CONFIRMED_BOOKING');
});

test('receiveReferenceEvent idempotently updates an existing slot for the exact same interval instead of flagging overlap', async () => {
  const { database, store } = createFakeDatabase();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  seedVenueAndCourt(store, venueId, courtId);
  const service = createInventorySyncService(database, MASTER_SECRET, () => new Date('2026-08-01T00:00:00.000Z'));
  const connector = await setupConnector(service, venueId, courtId);

  const existingSlotId = new ObjectId();
  store('slots').set(existingSlotId.toHexString(), {
    _id: existingSlotId,
    court_id: courtId,
    venue_id: venueId,
    environment: 'SANDBOX',
    booking_type: 'OPEN_TIME',
    starts_at: new Date('2026-08-10T10:00:00.000Z'),
    ends_at: new Date('2026-08-10T11:00:00.000Z'),
    status: 'BLOCKED',
    version: 1,
  });

  const body = eventBody();
  const raw = Buffer.from(JSON.stringify(body));
  const result = await service.receiveReferenceEvent({
    connectorId: connector.connectorId,
    signature: sign(raw, connector.webhookSecret),
    rawBody: raw,
    event: body,
  }) as { status: string };

  assert.equal(result.status, 'APPLIED');
  assert.equal(store('inventory_conflicts').size, 0);
  assert.equal(store('slots').size, 1);
});

test('pullReferenceInventory accepts a valid connector token and rejects an invalid one', async () => {
  const { database, store } = createFakeDatabase();
  const venueId = new ObjectId();
  const courtId = new ObjectId();
  seedVenueAndCourt(store, venueId, courtId);
  const service = createInventorySyncService(database, MASTER_SECRET, () => new Date('2026-08-01T00:00:00.000Z'));
  const connector = await setupConnector(service, venueId, courtId);

  const result = await service.pullReferenceInventory({
    connectorId: connector.connectorId,
    token: connector.webhookSecret,
  }) as { items: unknown[] };
  assert.ok(Array.isArray(result.items));

  await assert.rejects(
    service.pullReferenceInventory({
      connectorId: connector.connectorId,
      token: 'not-the-right-token',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVALID_CONNECTOR_AUTHENTICATION',
  );
});
