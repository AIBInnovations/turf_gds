import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import {
  classifyOverlap,
  isLiveHold,
  type OverlapSlot,
} from '../src/modules/venue/inventory/slot-overlap.js';

const now = new Date('2026-08-01T12:00:00.000Z');
const past = new Date('2026-08-01T11:00:00.000Z');
const future = new Date('2026-08-01T13:00:00.000Z');
const courtId = new ObjectId('687f00000000000000000102');

function slot(overrides: Partial<OverlapSlot> = {}): OverlapSlot {
  return {
    _id: new ObjectId(),
    court_id: courtId,
    booking_type: 'FIXED_SLOT',
    starts_at: new Date('2026-08-01T18:00:00.000Z'),
    ends_at: new Date('2026-08-01T19:00:00.000Z'),
    status: 'AVAILABLE',
    hold_expires_at: null,
    consumed_by_slot_id: null,
    ...overrides,
  };
}

function ids(values: readonly OverlapSlot[]): string[] {
  return values.map((value) => value._id.toHexString()).sort();
}

test('classifyOverlap treats an available fixed slot as consumable, not blocking', () => {
  const fixed = slot();

  const result = classifyOverlap({
    slots: [fixed],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(ids(result.consumable), ids([fixed]));
  assert.equal(result.blocking.length, 0);
  assert.equal(result.stale.length, 0);
});

test('classifyOverlap blocks on booked, blocked, and live held inventory', () => {
  const booked = slot({ booking_type: 'OPEN_TIME', status: 'BOOKED' });
  const blocked = slot({ booking_type: 'OPEN_TIME', status: 'BLOCKED' });
  const liveHold = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: future,
  });
  const bookedFixed = slot({ status: 'BOOKED' });

  const result = classifyOverlap({
    slots: [booked, blocked, liveHold, bookedFixed],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(
    ids(result.blocking),
    ids([booked, blocked, liveHold, bookedFixed]),
  );
  assert.equal(result.consumable.length, 0);
});

test('classifyOverlap reports an expired open-time hold as stale rather than blocking', () => {
  const expired = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: past,
  });

  const result = classifyOverlap({
    slots: [expired],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(ids(result.stale), ids([expired]));
  assert.equal(result.blocking.length, 0);
});

test('classifyOverlap treats a hold with no expiry as live', () => {
  const unbounded = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: null,
  });

  assert.equal(isLiveHold(unbounded, now), true);
  assert.deepEqual(
    ids(classifyOverlap({ slots: [unbounded], now, perspective: 'OPEN_TIME' }).blocking),
    ids([unbounded]),
  );
});

test('classifyOverlap consumes a fixed slot whose own hold has expired', () => {
  const staleFixed = slot({ status: 'HELD', hold_expires_at: past });
  const liveFixed = slot({ status: 'HELD', hold_expires_at: future });

  const result = classifyOverlap({
    slots: [staleFixed, liveFixed],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(ids(result.consumable), ids([staleFixed]));
  assert.deepEqual(ids(result.blocking), ids([liveFixed]));
});

test('classifyOverlap reclaims a consumed fixed slot only when its consumer is present and stale', () => {
  const staleConsumer = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: past,
  });
  const reclaimable = slot({
    status: 'UNAVAILABLE',
    consumed_by_slot_id: staleConsumer._id,
  });

  const reclaimed = classifyOverlap({
    slots: [staleConsumer, reclaimable],
    now,
    perspective: 'OPEN_TIME',
  });
  assert.deepEqual(ids(reclaimed.consumable), ids([reclaimable]));

  const liveConsumer = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: future,
  });
  const heldDown = slot({
    status: 'UNAVAILABLE',
    consumed_by_slot_id: liveConsumer._id,
  });
  const live = classifyOverlap({
    slots: [liveConsumer, heldDown],
    now,
    perspective: 'OPEN_TIME',
  });
  assert.deepEqual(ids(live.blocking), ids([liveConsumer, heldDown]));
  assert.equal(live.consumable.length, 0);
});

test('classifyOverlap blocks a consumed fixed slot whose consumer is absent from the scan', () => {
  // Geometry: our interval overlaps the fixed slot, but the consuming open-time
  // slot sits outside our interval and so never appears in the scan. An unseen
  // consumer must be assumed live or we would sell a slot out from under it.
  const absentConsumer = new ObjectId();
  const consumed = slot({
    status: 'UNAVAILABLE',
    consumed_by_slot_id: absentConsumer,
  });

  const result = classifyOverlap({
    slots: [consumed],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(ids(result.blocking), ids([consumed]));
  assert.equal(result.consumable.length, 0);
});

test('classifyOverlap keeps a deliberately unavailable fixed slot blocking', () => {
  const keepUnavailable = slot({
    status: 'UNAVAILABLE',
    consumed_by_slot_id: null,
  });

  const result = classifyOverlap({
    slots: [keepUnavailable],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.deepEqual(ids(result.blocking), ids([keepUnavailable]));
  assert.equal(result.consumable.length, 0);
});

test('classifyOverlap ignores an inert available open-time leftover', () => {
  const leftover = slot({ booking_type: 'OPEN_TIME', status: 'AVAILABLE' });

  const result = classifyOverlap({
    slots: [leftover],
    now,
    perspective: 'OPEN_TIME',
  });

  assert.equal(result.blocking.length, 0);
  assert.equal(result.consumable.length, 0);
  assert.equal(result.stale.length, 0);
});

test('classifyOverlap from the fixed-slot perspective ignores other fixed slots', () => {
  const otherFixed = slot({ status: 'BOOKED' });
  const liveOpen = slot({
    booking_type: 'OPEN_TIME',
    status: 'HELD',
    hold_expires_at: future,
  });

  const result = classifyOverlap({
    slots: [otherFixed, liveOpen],
    now,
    perspective: 'FIXED_SLOT',
  });

  assert.deepEqual(ids(result.blocking), ids([liveOpen]));
  assert.equal(result.consumable.length, 0);
});

test('classifyOverlap excludes the claim target from its own classification', () => {
  const target = slot({ status: 'HELD', hold_expires_at: future });

  const result = classifyOverlap({
    slots: [target],
    now,
    perspective: 'FIXED_SLOT',
    excludeSlotId: target._id,
  });

  assert.equal(result.blocking.length, 0);
});
