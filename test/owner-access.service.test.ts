import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { IdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import type { OwnerAccessRepository } from '../src/modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type {
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
} from '../src/modules/identity/owner/owner.types.js';
import { AppError } from '../src/shared/errors/app-error.js';

const ownerId = new ObjectId('687f00000000000000000030');
const venueId = new ObjectId('687f00000000000000000031');
const memberOwnerId = new ObjectId('687f00000000000000000033');

function ownerDocument(
  id: ObjectId,
  overrides: Partial<VenueOwnerDocument> = {},
): VenueOwnerDocument {
  const timestamp = new Date('2026-07-28T08:00:00.000Z');
  return {
    _id: id,
    legal_name: 'Venue Team Member',
    email: `${id.toHexString()}@example.com`,
    phone_e164: '+919876543210',
    password_hash: 'password-hash',
    email_verified_at: null,
    status: 'ACTIVE',
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    sessions: [],
    fcm_tokens: [],
    notifications: [],
    approved_by: null,
    approved_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function createService(options: {
  memberExists?: boolean;
  existingMemberRole?: 'OWNER' | 'MANAGER' | 'STAFF';
} = {}) {
  const membership: VenueOwnerMembershipDocument = {
    _id: new ObjectId('687f00000000000000000032'),
    owner_id: ownerId,
    venue_id: venueId,
    role: 'MANAGER',
    status: 'ACTIVE',
    created_at: new Date(),
    updated_at: new Date(),
  };
  let savedMembership: VenueOwnerMembershipDocument | undefined;
  const owners = new Map<string, VenueOwnerDocument>([
    [ownerId.toHexString(), ownerDocument(ownerId)],
  ]);
  if (options.memberExists !== false) {
    owners.set(memberOwnerId.toHexString(), ownerDocument(memberOwnerId));
  }

  const repository: OwnerAccessRepository = {
    async findOwnerById(id) {
      return owners.get(id.toHexString()) ?? null;
    },
    async revokeSession() {
      return true;
    },
    async listMemberships() {
      return [membership];
    },
    async findActiveMembership(owner, venue) {
      return owner.equals(ownerId) && venue.equals(venueId)
        ? membership
        : null;
    },
    async findMembership(owner, venue) {
      if (
        owner.equals(memberOwnerId) &&
        venue.equals(venueId) &&
        options.existingMemberRole
      ) {
        return {
          ...membership,
          owner_id: memberOwnerId,
          role: options.existingMemberRole,
        };
      }
      return null;
    },
    async listVenueMemberships(venue) {
      return venue.equals(venueId) ? [membership] : [];
    },
    async listPermissions() {
      return ['MANAGE_VENUE', 'MANAGE_MEMBERS', 'VIEW_BOOKINGS'];
    },
    async saveMembership(value) {
      savedMembership = value;
      return value;
    },
    async revokeMembership() {
      return true;
    },
  };
  const identityService = {
    async registerVenueOwner() {
      throw new Error('not used');
    },
    async loginVenueOwner() {
      throw new Error('not used');
    },
    async validateOwnerSession() {
      return {
        ownerId: ownerId.toHexString(),
        ownerStatus: 'ACTIVE',
        membership: null,
      };
    },
    async approveVenueOwner() {},
  } satisfies IdentityService;
  return {
    service: createOwnerAccessService({ identityService, repository }),
    getSavedMembership: () => savedMembership,
  };
}

test('requirePermission accepts assigned role permissions', async () => {
  const { service } = createService();

  await service.requirePermission(
    ownerId.toHexString(),
    venueId.toHexString(),
    'MANAGE_VENUE',
  );
});

test('requirePermission rejects permissions missing from the role', async () => {
  const { service } = createService();

  await assert.rejects(
    service.requirePermission(
      ownerId.toHexString(),
      venueId.toHexString(),
      'VIEW_FINANCE',
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
});

test('addMember rejects a nonexistent Venue Owner', async () => {
  const { service } = createService({ memberExists: false });

  await assert.rejects(
    service.addMember({
      actingOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      memberOwnerId: memberOwnerId.toHexString(),
      role: 'MANAGER',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'OWNER_NOT_FOUND',
  );
});

test('addMember never overwrites the canonical OWNER membership', async () => {
  const { service } = createService({ existingMemberRole: 'OWNER' });

  await assert.rejects(
    service.addMember({
      actingOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      memberOwnerId: memberOwnerId.toHexString(),
      role: 'STAFF',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'OWNER_MEMBERSHIP_IMMUTABLE',
  );
});

test('addMember creates a scoped membership for an existing owner', async () => {
  const { service, getSavedMembership } = createService();

  await service.addMember({
    actingOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    memberOwnerId: memberOwnerId.toHexString(),
    role: 'STAFF',
  });

  assert.equal(getSavedMembership()?.owner_id.equals(memberOwnerId), true);
  assert.equal(getSavedMembership()?.venue_id.equals(venueId), true);
  assert.equal(getSavedMembership()?.role, 'STAFF');
});

test('member management rejects an owner from another venue', async () => {
  const { service } = createService();
  const otherOwnerId = new ObjectId('687f00000000000000000034');

  await assert.rejects(
    service.addMember({
      actingOwnerId: otherOwnerId.toHexString(),
      venueId: venueId.toHexString(),
      memberOwnerId: memberOwnerId.toHexString(),
      role: 'STAFF',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PERMISSION_DENIED',
  );
});

test('revokeMember never revokes the canonical OWNER membership', async () => {
  const { service } = createService({ existingMemberRole: 'OWNER' });

  await assert.rejects(
    service.revokeMember({
      actingOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      memberOwnerId: memberOwnerId.toHexString(),
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'OWNER_MEMBERSHIP_IMMUTABLE',
  );
});
