/**
 * Repairs inventory that predates cross-booking-mode slot consumption.
 *
 * Before consumption existed, an OPEN_TIME slot could be placed over an
 * AVAILABLE FIXED_SLOT covering the same court and interval. Both stayed
 * sellable, so the same court hour could be booked twice.
 *
 * Two classes of damage, and only one is safe to fix automatically:
 *
 *   Class 1 — an AVAILABLE (or expired-HELD) fixed slot still sitting under a
 *   live open-time slot. Nobody has bought it yet, so it is simply consumed.
 *   Idempotent, and safe against live traffic because each court is repaired
 *   under its version CAS inside a transaction.
 *
 *   Class 2 — a HELD or BOOKED fixed slot under a live open-time slot. This is
 *   an already-materialised double booking, potentially with two CONFIRMED
 *   bookings and two sets of ledger postings. It is reported, never repaired:
 *   resolving it means refunds and ledger reversals, which must go through the
 *   audited cancellation endpoints rather than a script.
 *
 * Run with: npm run db:repair-inventory
 */
import { loadConfig } from '../config/env.js';
import { MongoDatabaseConnection } from '../shared/database/database-connection.js';
import type { SlotDocument } from '../modules/venue/inventory/inventory.types.js';
import type { CourtDocument } from '../modules/venue/courts/court.types.js';
import { consumeFixedSlots } from '../modules/venue/inventory/slot-consumption.js';
import {
  classifyOverlap,
  queryOverlappingSlots,
} from '../modules/venue/inventory/slot-overlap.js';

const database = new MongoDatabaseConnection(loadConfig().mongodb);
const now = new Date();

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

try {
  await database.connect();
  const slots = database.db.collection<SlotDocument>('slots');
  const courts = database.db.collection<CourtDocument>('courts');

  // Every open-time slot that currently occupies its interval.
  const consumers = await slots
    .find({
      booking_type: 'OPEN_TIME',
      $or: [
        { status: { $in: ['BOOKED', 'BLOCKED', 'UNAVAILABLE'] } },
        { status: 'HELD', hold_expires_at: { $gt: now } },
        { status: 'HELD', hold_expires_at: null },
      ],
    })
    .sort({ _id: 1 })
    .toArray();

  write(`Scanning ${consumers.length} live open-time slots`);

  let consumedTotal = 0;
  let repairedConsumers = 0;
  const conflicts: Array<Record<string, string | number>> = [];

  for (const consumer of consumers) {
    const overlapping = await queryOverlappingSlots(database.db, {
      courtId: consumer.court_id,
      environment: consumer.environment,
      startsAt: consumer.starts_at,
      endsAt: consumer.ends_at,
    });

    // Class 2 first: a sold fixed slot under this consumer is unrepairable.
    for (const slot of overlapping) {
      if (
        slot.booking_type === 'FIXED_SLOT' &&
        (slot.status === 'BOOKED' ||
          (slot.status === 'HELD' &&
            (slot.hold_expires_at === null || slot.hold_expires_at > now)))
      ) {
        conflicts.push({
          venueId: slot.venue_id.toHexString(),
          courtId: slot.court_id.toHexString(),
          environment: slot.environment,
          interval: `${slot.starts_at.toISOString()}/${slot.ends_at.toISOString()}`,
          openTimeSlotId: consumer._id.toHexString(),
          openTimeBookingId: consumer.booking_id?.toHexString() ?? 'none',
          fixedSlotId: slot._id.toHexString(),
          fixedSlotStatus: slot.status,
          fixedBookingId: slot.booking_id?.toHexString() ?? 'none',
        });
      }
    }

    const consumable = classifyOverlap({
      slots: overlapping,
      now,
      perspective: 'OPEN_TIME',
      excludeSlotId: consumer._id,
    }).consumable;
    if (consumable.length === 0) continue;

    await database.withTransaction(async ({ session }) => {
      const court = await courts.findOne(
        { _id: consumer.court_id },
        { session },
      );
      if (!court) return;
      // Take the Court mutex so a concurrent booking cannot interleave.
      const locked = await courts.updateOne(
        { _id: court._id, version: court.version },
        { $inc: { version: 1 }, $set: { updated_at: now } },
        { session },
      );
      if (locked.modifiedCount !== 1) return;

      const consumed = await consumeFixedSlots({
        db: database.db,
        courtId: consumer.court_id,
        environment: consumer.environment,
        consumerSlotId: consumer._id,
        fixedSlotIds: consumable.map((value) => value._id),
        staleConsumerIds: [],
        actorType: 'SYSTEM',
        actorId: null,
        reason: 'Repaired legacy mixed-mode inventory',
        correlationId: `consume-repair:${consumer._id.toHexString()}`,
        now,
        session,
      });
      consumedTotal += consumed;
      repairedConsumers += 1;
    });
  }

  write(
    `Repaired ${consumedTotal} fixed slots under ${repairedConsumers} open-time slots`,
  );

  if (conflicts.length === 0) {
    write('No materialised double bookings found.');
  } else {
    write('');
    write(
      `ACTION REQUIRED: ${conflicts.length} materialised double booking(s).`,
    );
    write(
      'Resolve each through the Partner or Owner cancellation endpoint so ' +
        'refunds and ledger reversals are posted through the audited path. ' +
        'Do not delete these rows directly.',
    );
    for (const conflict of conflicts) {
      write(JSON.stringify(conflict));
    }
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
