import type { ClientSession, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type {
  OwnerSessionDocument,
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
} from './owner/owner.types.js';

export interface IdentityRepository {
  ownerEmailExists(email: string, session: ClientSession): Promise<boolean>;
  insertOwner(
    owner: VenueOwnerDocument,
    session: ClientSession,
  ): Promise<void>;
  insertOwnerMembership(
    membership: VenueOwnerMembershipDocument,
    session: ClientSession,
  ): Promise<void>;
  findOwnerByEmail(email: string): Promise<VenueOwnerDocument | null>;
  recordFailedLogin(
    ownerId: ObjectId,
    maximumAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<void>;
  resetLoginFailures(ownerId: ObjectId, now: Date): Promise<void>;
  appendSession(
    ownerId: ObjectId,
    session: OwnerSessionDocument,
    maximumSessions: number,
    now: Date,
  ): Promise<boolean>;
  findOwnerBySessionTokenHash(tokenHash: string): Promise<VenueOwnerDocument | null>;
  findMembershipByOwnerAndVenue(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null>;
}

export function createIdentityRepository(
  database: DatabaseConnection,
): IdentityRepository {
  const owners = () =>
    database.db.collection<VenueOwnerDocument>('venue_owners');
  const memberships = () =>
    database.db.collection<VenueOwnerMembershipDocument>(
      'venue_owner_memberships',
    );

  async function ownerEmailExists(
    email: string,
    session: ClientSession,
  ): Promise<boolean> {
    const owner = await owners().findOne(
      { email },
      { session, projection: { _id: 1 } },
    );
    return owner !== null;
  }

  async function insertOwner(
    owner: VenueOwnerDocument,
    session: ClientSession,
  ): Promise<void> {
    await owners().insertOne(owner, { session });
  }

  async function insertOwnerMembership(
    membership: VenueOwnerMembershipDocument,
    session: ClientSession,
  ): Promise<void> {
    await memberships().insertOne(membership, { session });
  }

  async function findOwnerByEmail(
    email: string,
  ): Promise<VenueOwnerDocument | null> {
    return owners().findOne({ email });
  }

  async function recordFailedLogin(
    ownerId: ObjectId,
    maximumAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<void> {
    await owners().updateOne(
      { _id: ownerId },
      [
        {
          $set: {
            failed_login_count: { $add: ['$failed_login_count', 1] },
            locked_until: {
              $cond: [
                {
                  $gte: [
                    { $add: ['$failed_login_count', 1] },
                    maximumAttempts,
                  ],
                },
                lockedUntil,
                '$locked_until',
              ],
            },
            updated_at: now,
          },
        },
      ],
    );
  }

  async function resetLoginFailures(
    ownerId: ObjectId,
    now: Date,
  ): Promise<void> {
    await owners().updateOne(
      { _id: ownerId },
      {
        $set: {
          failed_login_count: 0,
          locked_until: null,
          updated_at: now,
        },
      },
    );
  }

  async function appendSession(
    ownerId: ObjectId,
    ownerSession: OwnerSessionDocument,
    maximumSessions: number,
    now: Date,
  ): Promise<boolean> {
    const updated = await owners().findOneAndUpdate(
      {
        _id: ownerId,
        status: 'ACTIVE',
      },
      [
        {
          $set: {
            sessions: {
              $slice: [
                {
                  $concatArrays: [
                    {
                      $filter: {
                        input: '$sessions',
                        as: 'session',
                        cond: {
                          $and: [
                            { $gt: ['$$session.expires_at', now] },
                            { $eq: ['$$session.revoked_at', null] },
                          ],
                        },
                      },
                    },
                    [ownerSession],
                  ],
                },
                -maximumSessions,
              ],
            },
            failed_login_count: 0,
            locked_until: null,
            last_login_at: now,
            updated_at: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );

    return updated !== null;
  }

  async function findOwnerBySessionTokenHash(
    tokenHash: string,
  ): Promise<VenueOwnerDocument | null> {
    return owners().findOne({ 'sessions.token_hash': tokenHash });
  }

  async function findMembershipByOwnerAndVenue(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null> {
    return memberships().findOne({ owner_id: ownerId, venue_id: venueId });
  }

  return {
    ownerEmailExists,
    insertOwner,
    insertOwnerMembership,
    findOwnerByEmail,
    recordFailedLogin,
    resetLoginFailures,
    appendSession,
    findOwnerBySessionTokenHash,
    findMembershipByOwnerAndVenue,
  };
}
