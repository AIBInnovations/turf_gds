import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import type { IdentityRepository } from '../src/modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import type {
  OwnerSessionDocument,
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
} from '../src/modules/identity/owner/owner.types.js';
import type {
  CreateInitialVenueInput,
  VenueService,
} from '../src/modules/venue/profile/venue.service.js';
import {
  hashPassword,
  verifyPassword,
} from '../src/shared/auth/password.js';
import { hashSessionToken } from '../src/shared/auth/session-token.js';
import { AppError } from '../src/shared/errors/app-error.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';

const fixedNow = new Date('2026-07-28T08:00:00.000Z');
const authConfig: AppConfig['auth'] = {
  sessionTtlHours: 168,
  maxSessions: 5,
  maxLoginAttempts: 5,
  lockMinutes: 15,
  adminAccessTokenSecret: 'test-admin-secret-with-at-least-32-chars',
  adminAccessTokenTtlMinutes: 60,
  partnerCredentialMasterSecret:
    'test-partner-secret-with-at-least-32-chars',
  partnerHmacMaxSkewSeconds: 300,
};

interface FakeRepositoryState {
  duplicate: boolean;
  owner: VenueOwnerDocument | null;
  insertedOwner?: VenueOwnerDocument;
  createdVenue?: CreateInitialVenueInput;
  insertedMembership?: VenueOwnerMembershipDocument;
  appendedSession?: OwnerSessionDocument;
  membership?: VenueOwnerMembershipDocument;
  approvedOwner?: {
    ownerId: ObjectId;
    adminId: ObjectId;
    approvedAt: Date;
  };
}

function createFakeRepository(
  initialOwner: VenueOwnerDocument | null = null,
): {
  repository: IdentityRepository;
  venueService: VenueService;
  database: DatabaseConnection;
  state: FakeRepositoryState;
} {
  const state: FakeRepositoryState = {
    duplicate: false,
    owner: initialOwner,
  };

  const repository: IdentityRepository = {
    async ownerEmailExists() {
      return state.duplicate;
    },

    async insertOwner(owner) {
      state.insertedOwner = owner;
    },

    async insertOwnerMembership(membership) {
      state.insertedMembership = membership;
    },

    async findOwnerByEmail() {
      return state.owner;
    },

    async recordFailedLogin(
      _ownerId,
      maximumAttempts,
      lockedUntil,
      now,
    ) {
      if (!state.owner) {
        return;
      }

      state.owner.failed_login_count += 1;
      state.owner.updated_at = now;

      if (state.owner.failed_login_count >= maximumAttempts) {
        state.owner.locked_until = lockedUntil;
      }
    },

    async resetLoginFailures(_ownerId, now) {
      if (!state.owner) {
        return;
      }

      state.owner.failed_login_count = 0;
      state.owner.locked_until = null;
      state.owner.updated_at = now;
    },

    async appendSession(_ownerId, session) {
      if (!state.owner || state.owner.status === 'SUSPENDED') {
        return false;
      }

      state.appendedSession = session;
      state.owner.sessions.push(session);
      state.owner.failed_login_count = 0;
      state.owner.locked_until = null;
      return true;
    },

    async findOwnerBySessionTokenHash(tokenHash) {
      if (!state.owner) {
        return null;
      }

      return state.owner.sessions.some((session) => session.token_hash === tokenHash)
        ? state.owner
        : null;
    },

    async touchSession() {},

    async findMembershipByOwnerAndVenue(ownerId, venueId) {
      if (!state.membership) {
        return null;
      }

      if (
        state.membership.owner_id.equals(ownerId) &&
        state.membership.venue_id.equals(venueId)
      ) {
        return state.membership;
      }

      return null;
    },

    async approveOwner(ownerId, adminId, _correlationId, approvedAt) {
      state.approvedOwner = { ownerId, adminId, approvedAt };
      return state.owner?.status === 'ACTIVE';
    },
  };

  const venueService: VenueService = {
    async createInitialVenue(venue) {
      state.createdVenue = venue;
    },
    async approveVenue() {},
  };

  const database: DatabaseConnection = {
    db: undefined as never,
    async connect() {},
    async ping() {},
    async close() {},
    async withTransaction(operation) {
      return operation({
        db: undefined as never,
        session: undefined as never,
      });
    },
  };

  return { repository, venueService, database, state };
}

async function createOwner(
  password = 'correct-horse-battery',
): Promise<VenueOwnerDocument> {
  return {
    _id: new ObjectId('687f00000000000000000004'),
    legal_name: 'Turf Owner Private Limited',
    email: 'owner@example.com',
    phone_e164: '+919876543210',
    password_hash: await hashPassword(password),
    email_verified_at: null,
    kyc_status: 'PENDING',
    status: 'ACTIVE',
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    sessions: [],
    fcm_tokens: [],
    notifications: [],
    audit_history: [],
    approved_by: null,
    approved_at: null,
    created_at: fixedNow,
    updated_at: fixedNow,
  };
}

test('password hashes are salted and verifiable', async () => {
  const first = await hashPassword('correct-horse-battery');
  const second = await hashPassword('correct-horse-battery');

  assert.notEqual(first, second);
  assert.equal(
    await verifyPassword('correct-horse-battery', first),
    true,
  );
  assert.equal(await verifyPassword('incorrect-password', first), false);
});

test('registration prepares owner, venue, and owner membership result', async () => {
  const fake = createFakeRepository();
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
    now: () => fixedNow,
  });

  const result = await service.registerVenueOwner({
    legalName: ' Turf Owner Private Limited ',
    email: ' OWNER@EXAMPLE.COM ',
    phoneE164: '+919876543210',
    password: 'correct-horse-battery',
    venue: {
      legalName: ' Green Arena Private Limited ',
      displayName: ' Green Arena ',
      timezone: 'Asia/Kolkata',
      address: {
        line1: 'MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'in',
      },
      latitude: 12.9716,
      longitude: 77.5946,
    },
  });

  assert.equal(result.ownerStatus, 'ACTIVE');
  assert.equal(result.venueStatus, 'PENDING');
  assert.equal(fake.state.insertedOwner?.email, 'owner@example.com');
  assert.notEqual(
    fake.state.insertedOwner?.password_hash,
    'correct-horse-battery',
  );
  assert.equal(fake.state.createdVenue?.longitude, 77.5946);
  assert.equal(fake.state.createdVenue?.latitude, 12.9716);
  assert.equal(fake.state.insertedMembership?.role, 'OWNER');
});

test('login returns a raw token but stores only its hash', async () => {
  const owner = await createOwner();
  const fake = createFakeRepository(owner);
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
    now: () => fixedNow,
  });

  const result = await service.loginVenueOwner({
    email: 'OWNER@EXAMPLE.COM',
    password: 'correct-horse-battery',
    ipAddress: '127.0.0.1',
    userAgent: 'identity-test',
  });

  assert.equal(result.owner.id, owner._id.toHexString());
  assert.ok(result.sessionToken.length >= 40);
  assert.notEqual(
    fake.state.appendedSession?.token_hash,
    result.sessionToken,
  );
  assert.equal(
    fake.state.appendedSession?.token_hash,
    hashSessionToken(result.sessionToken),
  );
});

test('repeated invalid passwords lock the owner account', async () => {
  const owner = await createOwner();
  const fake = createFakeRepository(owner);
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
    now: () => fixedNow,
  });

  for (let attempt = 0; attempt < authConfig.maxLoginAttempts; attempt += 1) {
    await assert.rejects(
      service.loginVenueOwner({
        email: owner.email,
        password: 'wrong-password',
        ipAddress: '127.0.0.1',
        userAgent: 'identity-test',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_CREDENTIALS',
    );
  }

  assert.equal(owner.failed_login_count, 5);
  assert.equal(
    owner.locked_until?.toISOString(),
    '2026-07-28T08:15:00.000Z',
  );

  await assert.rejects(
    service.loginVenueOwner({
      email: owner.email,
      password: 'correct-horse-battery',
      ipAddress: '127.0.0.1',
      userAgent: 'identity-test',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'ACCOUNT_LOCKED',
  );
});

test('session validation rejects expired or revoked sessions', async () => {
  const owner = await createOwner();
  const sessionToken = 'expiring-session-token';
  owner.sessions.push({
    token_hash: hashSessionToken(sessionToken),
    ip_hash: '127.0.0.1',
    user_agent: 'identity-test',
    expires_at: new Date('2026-07-27T08:00:00.000Z'),
    last_seen_at: fixedNow,
    revoked_at: null,
    created_at: fixedNow,
  });

  const fake = createFakeRepository(owner);
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
    now: () => fixedNow,
  });

  await assert.rejects(
    service.validateOwnerSession({ sessionToken }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVALID_SESSION',
  );
});

test('owner approval is delegated to the identity repository', async () => {
  const owner = await createOwner();
  const fake = createFakeRepository(owner);
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
    now: () => fixedNow,
  });
  const adminId = new ObjectId('687f00000000000000000005');
  const venueId = new ObjectId('687f00000000000000000006');
  fake.state.membership = {
    _id: new ObjectId('687f00000000000000000007'),
    owner_id: owner._id,
    venue_id: venueId,
    role: 'OWNER',
    status: 'ACTIVE',
    created_at: fixedNow,
  };

  await service.approveVenueOwner({
    ownerId: owner._id.toHexString(),
    venueId: venueId.toHexString(),
    adminId: adminId.toHexString(),
    correlationId: 'approve-owner',
  }, undefined as never);

  assert.equal(fake.state.approvedOwner?.ownerId.equals(owner._id), true);
  assert.equal(fake.state.approvedOwner?.adminId.equals(adminId), true);
  assert.equal(fake.state.approvedOwner?.approvedAt, fixedNow);
});

test('owner approval rejects malformed identifiers', async () => {
  const fake = createFakeRepository();
  const service = createIdentityService({
    repository: fake.repository,
    venueService: fake.venueService,
    database: fake.database,
    authConfig,
  });

  await assert.rejects(
    service.approveVenueOwner({
      ownerId: 'invalid-owner-id',
      venueId: 'invalid-venue-id',
      adminId: 'invalid-admin-id',
      correlationId: 'invalid-approval',
    }, undefined as never),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVALID_ID',
  );
});
