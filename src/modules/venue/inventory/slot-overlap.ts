import type { ClientSession, Db, ObjectId } from 'mongodb';

import type { SlotDocument } from './inventory.types.js';

/**
 * Upper bound on slots read for one interval. A booking interval is at most a
 * single operating day, so it can overlap only a handful of generated slots;
 * the limit exists to stop a pathological grid from loading an unbounded set.
 */
export const OVERLAP_SCAN_LIMIT = 200;

/** The fields {@link classifyOverlap} needs. */
export type OverlapSlot = Pick<
  SlotDocument,
  | '_id'
  | 'court_id'
  | 'booking_type'
  | 'starts_at'
  | 'ends_at'
  | 'status'
  | 'hold_expires_at'
  | 'consumed_by_slot_id'
>;

export interface OverlapQuery {
  courtId: ObjectId;
  environment: SlotDocument['environment'];
  startsAt: Date;
  endsAt: Date;
}

export interface OverlapClassification<T extends OverlapSlot> {
  /** Occupies the interval. The caller must reject. */
  blocking: T[];
  /** FIXED_SLOTs an OPEN_TIME writer may consume. */
  consumable: T[];
  /** Expired OPEN_TIME holds. Ignored, but their ids unstick consumed slots. */
  stale: T[];
}

const OVERLAP_PROJECTION = {
  _id: 1,
  court_id: 1,
  booking_type: 1,
  starts_at: 1,
  ends_at: 1,
  status: 1,
  hold_expires_at: 1,
  consumed_by_slot_id: 1,
} as const;

/**
 * Every slot overlapping the interval, regardless of booking type or status.
 *
 * Deliberately takes no `status` filter and no `now`: encoding "what blocks"
 * in the query is what let the read and write paths drift apart, and what let
 * an AVAILABLE FIXED_SLOT stay invisible to an OPEN_TIME writer. All policy
 * lives in {@link classifyOverlap}.
 */
export function queryOverlappingSlots(
  db: Db,
  query: OverlapQuery,
  session?: ClientSession,
): Promise<SlotDocument[]> {
  return db
    .collection<SlotDocument>('slots')
    .find(
      {
        court_id: query.courtId,
        environment: query.environment,
        starts_at: { $lt: query.endsAt },
        ends_at: { $gt: query.startsAt },
      },
      { ...(session ? { session } : {}) },
    )
    .limit(OVERLAP_SCAN_LIMIT)
    .toArray();
}

/** The read-side batched form: one query for many courts, projected. */
export function queryOverlappingSlotsForCourts(
  db: Db,
  query: {
    courtIds: readonly ObjectId[];
    environment: SlotDocument['environment'];
    startsAt: Date;
    endsAt: Date;
  },
): Promise<OverlapSlot[]> {
  if (query.courtIds.length === 0) return Promise.resolve([]);
  return db
    .collection<SlotDocument>('slots')
    .find({
      court_id: { $in: [...query.courtIds] },
      environment: query.environment,
      starts_at: { $lt: query.endsAt },
      ends_at: { $gt: query.startsAt },
    })
    .project<OverlapSlot>(OVERLAP_PROJECTION)
    .toArray();
}

/** A HELD slot only occupies its interval until its hold expires. */
export function isLiveHold(slot: OverlapSlot, now: Date): boolean {
  if (slot.status !== 'HELD') return false;
  // A null expiry is treated as live: it cannot be reaped, so it never clears.
  return slot.hold_expires_at === null || slot.hold_expires_at > now;
}

/**
 * Split overlapping slots into what blocks a writer, what it may consume, and
 * which expired holds it may steal from.
 *
 * `perspective` is the kind of slot the caller is trying to place:
 *
 * - `OPEN_TIME` — an open-time hold, owner block, or direct booking. An
 *   AVAILABLE FIXED_SLOT is *consumable*, not blocking: the caller marks it
 *   UNAVAILABLE in the same transaction so the underlying grid cannot be sold
 *   twice.
 * - `FIXED_SLOT` — claiming one specific generated slot. Only live OPEN_TIME
 *   slots block; other FIXED_SLOTs are ignored, preserving today's
 *   fixed-vs-fixed semantics. Pass `excludeSlotId` so the target does not
 *   classify itself.
 */
export function classifyOverlap<T extends OverlapSlot>(input: {
  slots: readonly T[];
  now: Date;
  perspective: 'OPEN_TIME' | 'FIXED_SLOT';
  excludeSlotId?: ObjectId;
}): OverlapClassification<T> {
  const result: OverlapClassification<T> = {
    blocking: [],
    consumable: [],
    stale: [],
  };

  const considered = input.excludeSlotId
    ? input.slots.filter((slot) => !slot._id.equals(input.excludeSlotId!))
    : input.slots;

  // An UNAVAILABLE fixed slot may only be stolen when its consumer is both
  // present in this scan and already expired. A consumer can overlap the fixed
  // slot without overlapping *our* interval, in which case it is absent here —
  // and an absent consumer must be assumed live, or we would sell a slot out
  // from under a live booking.
  const staleConsumerIds = new Set(
    considered
      .filter(
        (slot) =>
          slot.booking_type === 'OPEN_TIME' &&
          slot.status === 'HELD' &&
          !isLiveHold(slot, input.now),
      )
      .map((slot) => slot._id.toHexString()),
  );

  for (const slot of considered) {
    if (slot.booking_type === 'OPEN_TIME') {
      if (slot.status === 'AVAILABLE') continue; // inert leftover
      if (slot.status === 'HELD') {
        if (isLiveHold(slot, input.now)) result.blocking.push(slot);
        else result.stale.push(slot);
        continue;
      }
      result.blocking.push(slot);
      continue;
    }

    // FIXED_SLOT.
    if (input.perspective === 'FIXED_SLOT') continue;

    if (slot.status === 'AVAILABLE') {
      result.consumable.push(slot);
      continue;
    }
    if (slot.status === 'HELD') {
      if (isLiveHold(slot, input.now)) result.blocking.push(slot);
      else result.consumable.push(slot);
      continue;
    }
    if (
      slot.status === 'UNAVAILABLE' &&
      slot.consumed_by_slot_id !== null &&
      staleConsumerIds.has(slot.consumed_by_slot_id.toHexString())
    ) {
      result.consumable.push(slot);
      continue;
    }
    // BOOKED, BLOCKED, or UNAVAILABLE with no reclaimable consumer.
    result.blocking.push(slot);
  }

  return result;
}
