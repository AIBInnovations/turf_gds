import type { ClientSession, Db, ObjectId } from 'mongodb';

import { archiveAuditEvent } from '../../../shared/audit/audit.persistence.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { SlotAuditDocument, SlotDocument } from './inventory.types.js';

export const SLOT_CONSUMED_EVENT = 'SLOT_CONSUMED_BY_OPEN_TIME';
export const SLOT_RESTORED_EVENT = 'SLOT_RESTORED_FROM_OPEN_TIME';

interface ConsumptionActor {
  actorType: SlotAuditDocument['actor_type'];
  actorId: ObjectId | null;
  reason: string;
  correlationId: string;
}

/**
 * Mark overlapping FIXED_SLOTs as consumed by an OPEN_TIME slot.
 *
 * FIXED_SLOT inventory is generated wall-to-wall across operating hours, so an
 * open-time booking on a BOTH-mode court necessarily sits on top of part of the
 * grid. Without this, both the open-time slot and the fixed slots underneath it
 * stay sellable and the same court hour is booked twice.
 *
 * Must run inside the caller's transaction, under the Court version lock, using
 * ids produced by `classifyOverlap` from a read taken under that same lock.
 */
export async function consumeFixedSlots(
  input: {
    db: Db;
    courtId: ObjectId;
    environment: SlotDocument['environment'];
    consumerSlotId: ObjectId;
    /** From `classifyOverlap().consumable`. */
    fixedSlotIds: readonly ObjectId[];
    /** From `classifyOverlap().stale` — consumers whose holds have expired. */
    staleConsumerIds: readonly ObjectId[];
    now: Date;
    session: ClientSession;
  } & ConsumptionActor,
): Promise<number> {
  if (input.fixedSlotIds.length === 0) return 0;

  const event: SlotAuditDocument = {
    event_type: SLOT_CONSUMED_EVENT,
    actor_type: input.actorType,
    actor_id: input.actorId,
    // Batched: the previous status differs per document.
    previous_status: null,
    new_status: 'UNAVAILABLE',
    reason: `${input.reason} (open-time slot ${input.consumerSlotId.toHexString()})`,
    correlation_id: input.correlationId,
    occurred_at: input.now,
  };

  // The filter re-asserts every premise the classifier relied on, so a
  // concurrent writer that changed one of these slots between the read and this
  // write produces a short modifiedCount instead of a silent overwrite.
  const result = await input.db.collection<SlotDocument>('slots').updateMany(
    {
      _id: { $in: [...input.fixedSlotIds] },
      court_id: input.courtId,
      environment: input.environment,
      booking_type: 'FIXED_SLOT',
      booking_id: null,
      $or: [
        { status: 'AVAILABLE', consumed_by_slot_id: null },
        {
          status: 'HELD',
          consumed_by_slot_id: null,
          hold_expires_at: { $lte: input.now },
        },
        ...(input.staleConsumerIds.length > 0
          ? [
              {
                status: 'UNAVAILABLE' as const,
                consumed_by_slot_id: { $in: [...input.staleConsumerIds] },
              },
            ]
          : []),
      ],
    },
    {
      $set: {
        status: 'UNAVAILABLE',
        consumed_by_slot_id: input.consumerSlotId,
        hold_id: null,
        hold_partner_id: null,
        hold_expires_at: null,
        hold_created_at: null,
        updated_at: input.now,
      },
      $inc: { version: 1 },
      $push: { audit_history: { $each: [event], $slice: -100 } },
    },
    { session: input.session },
  );

  if (result.modifiedCount !== input.fixedSlotIds.length) {
    throw new AppError({
      code: 'INVENTORY_CONSUMPTION_CONFLICT',
      message: 'Overlapping fixed inventory changed concurrently',
      statusCode: 409,
    });
  }

  for (const id of input.fixedSlotIds) {
    await archiveAuditEvent({
      db: input.db,
      aggregateType: 'SLOT',
      aggregateId: id,
      environment: input.environment,
      event,
      session: input.session,
    });
  }

  return result.modifiedCount;
}

/**
 * Return every FIXED_SLOT consumed by `consumerSlotId` to AVAILABLE.
 *
 * Filters on the consumer id rather than on status, which is what makes this
 * safe without a Court lock: if a concurrent hold has already stolen these
 * slots, `consumed_by_slot_id` now points elsewhere and this matches nothing —
 * the correct outcome. It also guarantees a slot that is UNAVAILABLE for any
 * other reason is never resurrected.
 */
export async function restoreConsumedFixedSlots(
  input: {
    db: Db;
    courtId: ObjectId;
    consumerSlotId: ObjectId;
    now: Date;
    session: ClientSession;
  } & ConsumptionActor,
): Promise<number> {
  const slots = input.db.collection<SlotDocument>('slots');
  const consumed = await slots
    .find(
      { court_id: input.courtId, consumed_by_slot_id: input.consumerSlotId },
      { session: input.session },
    )
    .project<{ _id: ObjectId; environment: SlotDocument['environment'] }>({
      _id: 1,
      environment: 1,
    })
    .toArray();

  if (consumed.length === 0) return 0;

  const event: SlotAuditDocument = {
    event_type: SLOT_RESTORED_EVENT,
    actor_type: input.actorType,
    actor_id: input.actorId,
    previous_status: 'UNAVAILABLE',
    new_status: 'AVAILABLE',
    reason: `${input.reason} (open-time slot ${input.consumerSlotId.toHexString()})`,
    correlation_id: input.correlationId,
    occurred_at: input.now,
  };

  const result = await slots.updateMany(
    {
      _id: { $in: consumed.map((value) => value._id) },
      consumed_by_slot_id: input.consumerSlotId,
    },
    {
      $set: {
        status: 'AVAILABLE',
        consumed_by_slot_id: null,
        updated_at: input.now,
      },
      $inc: { version: 1 },
      $push: { audit_history: { $each: [event], $slice: -100 } },
    },
    { session: input.session },
  );

  if (result.modifiedCount !== consumed.length) {
    throw new AppError({
      code: 'INVENTORY_RESTORATION_CONFLICT',
      message: 'Consumed fixed inventory changed concurrently',
      statusCode: 409,
    });
  }

  for (const value of consumed) {
    await archiveAuditEvent({
      db: input.db,
      aggregateType: 'SLOT',
      aggregateId: value._id,
      environment: value.environment,
      event,
      session: input.session,
    });
  }

  return result.modifiedCount;
}
