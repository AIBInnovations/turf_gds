import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type {
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
  VenueMembershipRole,
  VenuePermission,
  VenueRolePermissionDocument,
} from './owner.types.js';

export interface OwnerAccessRepository {
  findOwnerById(ownerId: ObjectId): Promise<VenueOwnerDocument | null>;
  revokeSession(
    ownerId: ObjectId,
    tokenHash: string,
    now: Date,
  ): Promise<boolean>;
  listMemberships(
    ownerId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument[]>;
  findActiveMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null>;
  findMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null>;
  listVenueMemberships(
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument[]>;
  listPermissions(role: VenueMembershipRole): Promise<VenuePermission[]>;
  saveMembership(
    membership: VenueOwnerMembershipDocument,
  ): Promise<VenueOwnerMembershipDocument>;
  revokeMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
    now: Date,
  ): Promise<boolean>;
}

export function createOwnerAccessRepository(
  database: DatabaseConnection,
): OwnerAccessRepository {
  const owners = () =>
    database.db.collection<VenueOwnerDocument>('venue_owners');
  const memberships = () =>
    database.db.collection<VenueOwnerMembershipDocument>(
      'venue_owner_memberships',
    );
  const permissions = () =>
    database.db.collection<VenueRolePermissionDocument>(
      'venue_role_permissions',
    );

  async function findOwnerById(
    ownerId: ObjectId,
  ): Promise<VenueOwnerDocument | null> {
    return owners().findOne({ _id: ownerId });
  }

  async function revokeSession(
    ownerId: ObjectId,
    tokenHash: string,
    now: Date,
  ): Promise<boolean> {
    const result = await owners().updateOne(
      {
        _id: ownerId,
        sessions: {
          $elemMatch: { token_hash: tokenHash, revoked_at: null },
        },
      },
      {
        $set: {
          'sessions.$[session].revoked_at': now,
          updated_at: now,
        },
      },
      {
        arrayFilters: [
          {
            'session.token_hash': tokenHash,
            'session.revoked_at': null,
          },
        ],
      },
    );
    return result.modifiedCount > 0;
  }

  async function listMemberships(
    ownerId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument[]> {
    return memberships()
      .find({ owner_id: ownerId, status: 'ACTIVE' })
      .toArray();
  }

  async function findActiveMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null> {
    return memberships().findOne({
      owner_id: ownerId,
      venue_id: venueId,
      status: 'ACTIVE',
    });
  }

  async function findMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument | null> {
    return memberships().findOne({
      owner_id: ownerId,
      venue_id: venueId,
    });
  }

  async function listVenueMemberships(
    venueId: ObjectId,
  ): Promise<VenueOwnerMembershipDocument[]> {
    return memberships()
      .find({ venue_id: venueId, status: 'ACTIVE' })
      .sort({ created_at: 1, _id: 1 })
      .toArray();
  }

  async function listPermissions(
    role: VenueMembershipRole,
  ): Promise<VenuePermission[]> {
    const records = await permissions()
      .find({ role })
      .project<{ permission: VenuePermission }>({
        _id: 0,
        permission: 1,
      })
      .toArray();
    return records.map((record) => record.permission);
  }

  async function saveMembership(
    membership: VenueOwnerMembershipDocument,
  ): Promise<VenueOwnerMembershipDocument> {
    const result = await memberships().findOneAndUpdate(
      {
        owner_id: membership.owner_id,
        venue_id: membership.venue_id,
      },
      {
        $set: {
          role: membership.role,
          status: 'ACTIVE',
        },
        $setOnInsert: {
          _id: membership._id,
          created_at: membership.created_at,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return result ?? membership;
  }

  async function revokeMembership(
    ownerId: ObjectId,
    venueId: ObjectId,
    _now: Date,
  ): Promise<boolean> {
    const result = await memberships().updateOne(
      {
        owner_id: ownerId,
        venue_id: venueId,
        status: 'ACTIVE',
      },
      {
        $set: { status: 'REVOKED' },
      },
    );
    return result.modifiedCount > 0;
  }

  return {
    findOwnerById,
    revokeSession,
    listMemberships,
    findActiveMembership,
    findMembership,
    listVenueMemberships,
    listPermissions,
    saveMembership,
    revokeMembership,
  };
}
