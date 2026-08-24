import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { OtpProvider } from './msg91-otp.provider.js';
import type {
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
} from './owner.types.js';

/**
 * Owner-initiated account closure.
 *
 * Deliberately a *closure*, not a delete. The ledger is append-only, settlements and payouts are
 * money the platform owes real counterparties, and the SRS requires two years of audit retention —
 * so removing the rows would destroy records the business is obliged to keep, and would leave
 * partner-originated bookings pointing at a venue that no longer exists.
 *
 * What closing does instead: suspends the owner so no session or login can succeed, drops every
 * session and push token, overwrites the personal contact fields, revokes the venue memberships
 * and suspends any venue left without an owner. Bookings, settlements, payouts and ledger entries
 * are untouched.
 *
 * Nothing here needs a schema migration: `status` already permits `SUSPENDED`, and the closure is
 * recorded in `audit_history`, which the collection validator declares as an untyped array. The
 * validator sets `additionalProperties: false`, so a new top-level field would have been rejected.
 */

export interface ClosureBlocker {
  code: 'UPCOMING_BOOKINGS' | 'OPEN_SETTLEMENTS' | 'PENDING_PAYOUTS';
  message: string;
  count: number;
}

export interface OwnerAccountClosureService {
  /** Read-only: what currently prevents closure. Drives the UI before anything destructive. */
  checkBlockers(ownerId: string): Promise<ClosureBlocker[]>;
  closeAccount(input: {
    ownerId: string;
    /**
     * Re-proven by the owner right before this irreversible action — possession of a live
     * session is not enough on its own. A fresh MSG91 access token for the account's own
     * phone number, obtained by the client re-running send/verify OTP immediately before
     * calling this.
     */
    accessToken: string;
    reason?: string;
  }): Promise<{
    closedAt: string;
    venuesSuspended: number;
  }>;
}

/** Placeholders that satisfy the collection validator while carrying no personal data. */
const CLOSED_NAME = 'Closed account';
const CLOSED_PHONE = '+000000000000';

export function createOwnerAccountClosureService(input: {
  database: DatabaseConnection;
  otpProvider: OtpProvider;
  now?: () => Date;
}): OwnerAccountClosureService {
  const now = input.now ?? (() => new Date());
  const db = () => input.database.db;

  const owners = () => db().collection<VenueOwnerDocument>('venue_owners');
  const memberships = () =>
    db().collection<VenueOwnerMembershipDocument>('venue_owner_memberships');

  function oid(value: string): ObjectId {
    if (!ObjectId.isValid(value)) {
      throw new AppError({
        code: 'INVALID_ID',
        message: 'Identifier is invalid',
        statusCode: 400,
      });
    }
    return new ObjectId(value);
  }

  /** Venues this owner holds the canonical OWNER membership on. */
  async function ownedVenueIds(ownerId: ObjectId): Promise<ObjectId[]> {
    const rows = await memberships()
      .find({ owner_id: ownerId, role: 'OWNER', status: 'ACTIVE' })
      .toArray();
    return rows.map((row) => row.venue_id);
  }

  /**
   * Blocker reads reach across into the booking and financial-close collections. They are
   * strictly read-only — closure never writes outside identity — but the alternative was
   * closing an account that still owes a customer a pitch or a partner a settlement.
   */
  async function checkBlockers(ownerIdRaw: string): Promise<ClosureBlocker[]> {
    const ownerId = oid(ownerIdRaw);
    const venueIds = await ownedVenueIds(ownerId);
    if (venueIds.length === 0) return [];

    const [upcoming, settlements, payouts] = await Promise.all([
      db()
        .collection('bookings')
        .countDocuments({
          venue_id: { $in: venueIds },
          status: 'CONFIRMED',
          starts_at: { $gte: now() },
        }),
      db()
        .collection('settlements')
        .countDocuments({
          venue_id: { $in: venueIds },
          status: { $nin: ['COMPLETED', 'REVERSED', 'FAILED'] },
        })
        .catch(() => 0),
      db()
        .collection('payouts')
        .countDocuments({
          venue_id: { $in: venueIds },
          status: { $in: ['PENDING', 'PROCESSING'] },
        })
        .catch(() => 0),
    ]);

    const blockers: ClosureBlocker[] = [];
    if (upcoming > 0) {
      blockers.push({
        code: 'UPCOMING_BOOKINGS',
        count: upcoming,
        message: `${upcoming} confirmed booking${upcoming === 1 ? '' : 's'} still to be played. Cancel or complete them first.`,
      });
    }
    if (settlements > 0) {
      blockers.push({
        code: 'OPEN_SETTLEMENTS',
        count: settlements,
        message: `${settlements} settlement${settlements === 1 ? '' : 's'} not yet closed out.`,
      });
    }
    if (payouts > 0) {
      blockers.push({
        code: 'PENDING_PAYOUTS',
        count: payouts,
        message: `${payouts} payout${payouts === 1 ? '' : 's'} still owed to you.`,
      });
    }
    return blockers;
  }

  async function closeAccount(values: {
    ownerId: string;
    accessToken: string;
    reason?: string;
  }): Promise<{ closedAt: string; venuesSuspended: number }> {
    const ownerId = oid(values.ownerId);

    const account = await owners().findOne({ _id: ownerId });
    if (!account) {
      throw new AppError({
        code: 'OWNER_NOT_FOUND',
        message: 'Owner not found',
        statusCode: 404,
      });
    }
    const { verifiedPhoneDigits } = await input.otpProvider.verifyAccessToken({
      accessToken: values.accessToken,
    });
    if (verifiedPhoneDigits !== account.phone_e164.replace(/\D/g, '')) {
      throw new AppError({
        code: 'PHONE_TOKEN_MISMATCH',
        message: 'That verification does not match this account',
        statusCode: 401,
      });
    }

    // Re-checked inside the request rather than trusted from the client: the UI's earlier read
    // could be minutes old, and a booking taken in between must still block.
    const blockers = await checkBlockers(values.ownerId);
    if (blockers.length > 0) {
      throw new AppError({
        code: 'ACCOUNT_CLOSURE_BLOCKED',
        message: 'This account still has outstanding commitments',
        statusCode: 409,
        details: { blockers },
      });
    }

    const timestamp = now();
    let venuesSuspended = 0;

    await input.database.withTransaction(async ({ session }) => {
      const owner = await owners().findOne({ _id: ownerId }, { session });
      if (!owner) {
        throw new AppError({
          code: 'OWNER_NOT_FOUND',
          message: 'Owner not found',
          statusCode: 404,
        });
      }
      if (owner.status === 'SUSPENDED') {
        throw new AppError({
          code: 'ACCOUNT_ALREADY_CLOSED',
          message: 'This account is already closed',
          statusCode: 409,
        });
      }

      const venueIds = await memberships()
        .find({ owner_id: ownerId, role: 'OWNER', status: 'ACTIVE' }, { session })
        .toArray()
        .then((rows) => rows.map((row) => row.venue_id));

      await owners().updateOne(
        { _id: ownerId },
        {
          $set: {
            status: 'SUSPENDED',
            // Overwritten rather than emptied: the validator requires all three, and a unique
            // index covers email — the owner id keeps the placeholder unique per account and
            // frees the real address for re-registration.
            legal_name: CLOSED_NAME,
            email: `closed+${ownerId.toHexString()}@turfgang.invalid`,
            phone_e164: CLOSED_PHONE,
            sessions: [],
            fcm_tokens: [],
            updated_at: timestamp,
          },
          $push: {
            audit_history: {
              $each: [
                {
                  event_type: 'ACCOUNT_CLOSED',
                  actor_type: 'VENUE_OWNER',
                  actor_id: ownerId,
                  reason: values.reason ?? null,
                  occurred_at: timestamp,
                },
              ],
              // The validator caps this array at 100; trimming the oldest keeps a long-lived
              // account from failing its own closure write.
              $slice: -100,
            },
          },
        },
        { session },
      );

      await memberships().updateMany(
        { owner_id: ownerId, status: 'ACTIVE' },
        { $set: { status: 'REVOKED' } },
        { session },
      );

      // A venue whose only owner has gone must stop taking bookings, or it stays in partner
      // search with nobody able to honour it.
      for (const venueId of venueIds) {
        const others = await memberships().countDocuments(
          { venue_id: venueId, role: 'OWNER', status: 'ACTIVE', owner_id: { $ne: ownerId } },
          { session },
        );
        if (others > 0) continue;

        const result = await db()
          .collection('venues')
          .updateOne(
            { _id: venueId, status: { $ne: 'SUSPENDED' } },
            {
              $set: { status: 'SUSPENDED', updated_at: timestamp },
              $inc: { version: 1 },
            },
            { session },
          );
        venuesSuspended += result.modifiedCount;
      }
    });

    return { closedAt: timestamp.toISOString(), venuesSuspended };
  }

  return { checkBlockers, closeAccount };
}
