import { ObjectId } from 'mongodb';

import { hashSessionToken } from '../../../shared/auth/session-token.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { IdentityService } from './owner-auth.service.js';
import type {
  VenueMembershipRole,
  VenuePermission,
} from './owner.types.js';
import type { OwnerAccessRepository } from './owner-access.repository.js';

export interface OwnerAccessService {
  authenticateOwner(token: string): Promise<{
    actorType: 'OWNER';
    ownerId: string;
    status: 'PENDING' | 'ACTIVE';
  }>;
  logout(ownerId: string, token: string): Promise<void>;
  getProfile(ownerId: string): Promise<{
    id: string;
    legalName: string;
    email: string;
    phoneE164: string;
    status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
    emailVerifiedAt: string | null;
    memberships: Array<{
      id: string;
      venueId: string;
      role: VenueMembershipRole;
      permissions: VenuePermission[];
    }>;
  }>;
  requirePermission(
    ownerId: string,
    venueId: string,
    permission: VenuePermission,
  ): Promise<void>;
  requireVenueMembership(
    ownerId: string,
    venueId: string,
  ): Promise<{
    membershipId: string;
    role: VenueMembershipRole;
  }>;
  listMembers(
    actingOwnerId: string,
    venueId: string,
  ): Promise<Array<{
    ownerId: string;
    legalName: string;
    email: string;
    role: VenueMembershipRole;
    status: 'ACTIVE';
  }>>;
  addMember(input: {
    actingOwnerId: string;
    venueId: string;
    memberOwnerId: string;
    role: Exclude<VenueMembershipRole, 'OWNER'>;
  }): Promise<{ membershipId: string; status: 'ACTIVE' }>;
  revokeMember(input: {
    actingOwnerId: string;
    venueId: string;
    memberOwnerId: string;
  }): Promise<void>;
}

export function createOwnerAccessService(input: {
  identityService: IdentityService;
  repository: OwnerAccessRepository;
  now?: () => Date;
}): OwnerAccessService {
  const now = input.now ?? (() => new Date());

  async function authenticateOwner(
    token: string,
  ): ReturnType<OwnerAccessService['authenticateOwner']> {
    const session = await input.identityService.validateOwnerSession({
      sessionToken: token,
    });

    if (session.ownerStatus === 'SUSPENDED') {
      throw invalidSession();
    }

    return {
      actorType: 'OWNER',
      ownerId: session.ownerId,
      status: session.ownerStatus,
    };
  }

  async function logout(ownerId: string, token: string): Promise<void> {
    const id = toObjectId(ownerId, invalidSession);
    const revoked = await input.repository.revokeSession(
      id,
      hashSessionToken(token),
      now(),
    );

    if (!revoked) {
      throw invalidSession();
    }
  }

  async function getProfile(
    ownerId: string,
  ): ReturnType<OwnerAccessService['getProfile']> {
    const id = toObjectId(ownerId, invalidSession);
    const [owner, memberships] = await Promise.all([
      input.repository.findOwnerById(id),
      input.repository.listMemberships(id),
    ]);

    if (!owner) {
      throw invalidSession();
    }

    const membershipViews = await Promise.all(
      memberships.map(async (membership) => ({
        id: membership._id.toHexString(),
        venueId: membership.venue_id.toHexString(),
        role: membership.role,
        permissions: await input.repository.listPermissions(
          membership.role,
        ),
      })),
    );

    return {
      id: owner._id.toHexString(),
      legalName: owner.legal_name,
      email: owner.email,
      phoneE164: owner.phone_e164,
      status: owner.status,
      emailVerifiedAt: owner.email_verified_at?.toISOString() ?? null,
      memberships: membershipViews,
    };
  }

  async function requirePermission(
    ownerId: string,
    venueId: string,
    permission: VenuePermission,
  ): Promise<void> {
    const membership = await input.repository.findActiveMembership(
      toObjectId(ownerId, permissionDenied),
      toObjectId(venueId, permissionDenied),
    );

    if (!membership) {
      throw permissionDenied();
    }

    const permissions = await input.repository.listPermissions(
      membership.role,
    );

    if (!permissions.includes(permission)) {
      throw permissionDenied();
    }
  }

  async function requireVenueMembership(
    ownerId: string,
    venueId: string,
  ): ReturnType<OwnerAccessService['requireVenueMembership']> {
    const membership = await input.repository.findActiveMembership(
      toObjectId(ownerId, permissionDenied),
      toObjectId(venueId, permissionDenied),
    );

    if (!membership) {
      throw permissionDenied();
    }

    return {
      membershipId: membership._id.toHexString(),
      role: membership.role,
    };
  }

  async function addMember(
    values: Parameters<OwnerAccessService['addMember']>[0],
  ): ReturnType<OwnerAccessService['addMember']> {
    await requirePermission(
      values.actingOwnerId,
      values.venueId,
      'MANAGE_MEMBERS',
    );

    if (values.memberOwnerId === values.actingOwnerId) {
      throw new AppError({
        code: 'MEMBERSHIP_SELF_CHANGE_NOT_ALLOWED',
        message: 'You cannot change your own venue membership',
        statusCode: 409,
      });
    }

    const memberOwnerId = toObjectId(values.memberOwnerId, ownerNotFound);
    const venueId = toObjectId(values.venueId, permissionDenied);
    const [memberOwner, existingMembership] = await Promise.all([
      input.repository.findOwnerById(memberOwnerId),
      input.repository.findMembership(memberOwnerId, venueId),
    ]);

    if (!memberOwner) {
      throw ownerNotFound();
    }

    if (memberOwner.status === 'SUSPENDED') {
      throw new AppError({
        code: 'MEMBER_ACCOUNT_SUSPENDED',
        message: 'A suspended Venue Owner cannot be assigned to a venue',
        statusCode: 409,
      });
    }

    if (existingMembership?.role === 'OWNER') {
      throw new AppError({
        code: 'OWNER_MEMBERSHIP_IMMUTABLE',
        message: 'The OWNER membership cannot be changed',
        statusCode: 409,
      });
    }

    const timestamp = now();
    const membership = await input.repository.saveMembership({
      _id: new ObjectId(),
      owner_id: memberOwnerId,
      venue_id: venueId,
      role: values.role,
      status: 'ACTIVE',
      created_at: timestamp,
      updated_at: timestamp,
    });
    return {
      membershipId: membership._id.toHexString(),
      status: 'ACTIVE',
    };
  }

  async function listMembers(
    actingOwnerId: string,
    venueId: string,
  ): ReturnType<OwnerAccessService['listMembers']> {
    await requirePermission(
      actingOwnerId,
      venueId,
      'MANAGE_MEMBERS',
    );

    const memberships = await input.repository.listVenueMemberships(
      toObjectId(venueId, permissionDenied),
    );
    const members = await Promise.all(
      memberships.map(async (membership) => {
        const owner = await input.repository.findOwnerById(
          membership.owner_id,
        );

        if (!owner) {
          throw new AppError({
            code: 'MEMBERSHIP_DATA_INTEGRITY_ERROR',
            message: 'A venue membership references a missing owner',
            statusCode: 500,
          });
        }

        return {
          ownerId: owner._id.toHexString(),
          legalName: owner.legal_name,
          email: owner.email,
          role: membership.role,
          status: 'ACTIVE' as const,
        };
      }),
    );

    return members;
  }

  async function revokeMember(
    values: Parameters<OwnerAccessService['revokeMember']>[0],
  ): Promise<void> {
    await requirePermission(
      values.actingOwnerId,
      values.venueId,
      'MANAGE_MEMBERS',
    );

    if (values.memberOwnerId === values.actingOwnerId) {
      throw new AppError({
        code: 'MEMBERSHIP_CANNOT_BE_REVOKED',
        message: 'You cannot revoke your own membership',
        statusCode: 409,
      });
    }

    const memberOwnerId = toObjectId(
      values.memberOwnerId,
      ownerNotFound,
    );
    const venueId = toObjectId(values.venueId, permissionDenied);
    const membership = await input.repository.findMembership(
      memberOwnerId,
      venueId,
    );

    if (membership?.role === 'OWNER') {
      throw new AppError({
        code: 'OWNER_MEMBERSHIP_IMMUTABLE',
        message: 'The OWNER membership cannot be revoked',
        statusCode: 409,
      });
    }

    const revoked = await input.repository.revokeMembership(
      memberOwnerId,
      venueId,
      now(),
    );

    if (!revoked) {
      throw new AppError({
        code: 'MEMBERSHIP_NOT_FOUND',
        message: 'Active membership was not found',
        statusCode: 404,
      });
    }
  }

  return {
    authenticateOwner,
    logout,
    getProfile,
    requirePermission,
    requireVenueMembership,
    listMembers,
    addMember,
    revokeMember,
  };
}

function toObjectId(
  value: string,
  errorFactory: () => AppError,
): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw errorFactory();
  }
  return new ObjectId(value);
}

function invalidSession(): AppError {
  return new AppError({
    code: 'INVALID_SESSION',
    message: 'The session is invalid, expired, or revoked',
    statusCode: 401,
  });
}

function permissionDenied(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    message: 'You do not have permission for this venue',
    statusCode: 403,
  });
}

function ownerNotFound(): AppError {
  return new AppError({
    code: 'OWNER_NOT_FOUND',
    message: 'Venue Owner was not found',
    statusCode: 404,
  });
}
