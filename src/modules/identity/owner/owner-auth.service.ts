import type { AppConfig } from '../../../config/env.js';
import { ObjectId, type ClientSession } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from '../../../shared/auth/password.js';
import {
  generateSessionToken,
  hashSessionToken,
} from '../../../shared/auth/session-token.js';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../../shared/errors/app-error.js';
import type { VenueService } from '../../venue/profile/venue.service.js';
import type { OtpProvider } from './msg91-otp.provider.js';
import type { IdentityRepository } from './owner-auth.repository.js';
import type {
  LoginVenueOwnerInput,
  OtpLoginVenueOwnerInput,
  RegisterVenueOwnerInput,
  VenueMembershipRole,
  VenueOwnerDocument,
  VenueOwnerStatus,
} from './owner.types.js';

export interface IdentityService {
  registerVenueOwner(input: RegisterVenueOwnerInput): Promise<{
    ownerId: string;
    venueId: string;
    membershipId: string;
    ownerStatus: 'ACTIVE';
    venueStatus: 'PENDING';
  }>;
  loginVenueOwner(input: LoginVenueOwnerInput): Promise<{
    sessionToken: string;
    expiresAt: string;
    owner: {
      id: string;
      legalName: string;
      email: string;
      status: 'ACTIVE';
    };
  }>;
  loginVenueOwnerWithOtp(input: OtpLoginVenueOwnerInput): Promise<{
    sessionToken: string;
    expiresAt: string;
    owner: {
      id: string;
      legalName: string;
      email: string;
      status: 'ACTIVE';
    };
  }>;
  validateOwnerSession(input: {
    sessionToken: string;
    venueId?: string;
  }): Promise<{
    ownerId: string;
    ownerStatus: VenueOwnerStatus;
    membership?: {
      id: string;
      role: VenueMembershipRole;
      venueId: string;
    } | null;
  }>;
  approveVenueOwner(
    input: {
      ownerId: string;
      venueId: string;
      adminId: string;
      correlationId: string;
    },
    session: ClientSession,
  ): Promise<void>;
  attachOwnerVenue?(
    input: {
      ownerId: string;
      venueId: string;
      createdAt: Date;
    },
    session: ClientSession,
  ): Promise<{ membershipId: string }>;
}

export interface IdentityServiceDependencies {
  repository: IdentityRepository;
  venueService: VenueService;
  database: DatabaseConnection;
  authConfig: AppConfig['auth'];
  otpProvider: OtpProvider;
  /**
   * Optional so the service can still be constructed without it (tests, and the wiring order in
   * app.ts). When present, registration proposes the platform's standard terms straight away.
   */
  agreementService?: {
    proposeStandard(input: {
      venueId: string;
      ownerId: string;
      venueName: string;
      correlationId: string;
    }): Promise<boolean>;
  };
  now?: () => Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createIdentityService(
  dependencies: IdentityServiceDependencies,
): IdentityService {
  const now = dependencies.now ?? (() => new Date());

  /**
   * Confirms an MSG91 access token really was issued for `phoneE164`, not replayed from a
   * different phone's verification. Shared by every entry point that accepts an access token
   * instead of a password (register, OTP login, account closure).
   */
  async function verifyPhoneAccessToken(
    phoneE164: string,
    accessToken: string,
  ): Promise<void> {
    const { verifiedPhoneDigits } =
      await dependencies.otpProvider.verifyAccessToken({ accessToken });
    if (verifiedPhoneDigits !== phoneE164.replace(/\D/g, '')) {
      throw new AppError({
        code: 'PHONE_TOKEN_MISMATCH',
        message: 'That verification does not match this phone number',
        statusCode: 401,
      });
    }
  }

  async function registerVenueOwner(
    input: RegisterVenueOwnerInput,
  ): ReturnType<IdentityService['registerVenueOwner']> {
    const timestamp = now();
    const phoneE164 = input.phoneE164.trim();

    // Exactly one credential path — the route schema's `oneOf` should already guarantee this,
    // but the service re-checks rather than trusting the transport layer alone.
    if (Boolean(input.password) === Boolean(input.accessToken)) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Provide exactly one of password or accessToken',
        statusCode: 400,
      });
    }

    const passwordHash = input.accessToken
      ? // OTP-registered owners have no password. The validator still requires a non-null
        // password_hash, so this stores a random value nobody knows and no code path ever
        // verifies against — it exists only to satisfy the schema until that requirement is
        // dropped once every client has moved off password auth.
        await hashPassword(randomBytes(32).toString('hex'))
      : await hashPassword(input.password as string);

    if (input.accessToken) {
      await verifyPhoneAccessToken(phoneE164, input.accessToken);
    }

    const ownerId = new ObjectId();
    const venueId = new ObjectId();
    const membershipId = new ObjectId();

    try {
      await dependencies.database.withTransaction(async ({ session }) => {
        const email = normalizeEmail(input.email);
        // Sequential, not Promise.all: a MongoDB ClientSession only permits one command in
        // flight at a time — two operations racing on the same transaction session corrupt its
        // command ordering and the transaction fails with a driver-level conflict.
        const emailDuplicate = await dependencies.repository.ownerEmailExists(
          email,
          session,
        );
        if (emailDuplicate) {
          throw emailAlreadyRegistered();
        }
        const phoneDuplicate = await dependencies.repository.ownerPhoneExists(
          phoneE164,
          session,
        );
        if (phoneDuplicate) {
          throw phoneAlreadyRegistered();
        }

        await dependencies.repository.insertOwner(
          {
            _id: ownerId,
            legal_name: input.legalName.trim(),
            email,
            phone_e164: phoneE164,
            password_hash: passwordHash,
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
            created_at: timestamp,
            updated_at: timestamp,
          },
          session,
        );
        await dependencies.venueService.createInitialVenue(
          {
            venueId,
            legalName: input.venue.legalName,
            displayName: input.venue.displayName,
            timezone: input.venue.timezone,
            address: {
              line1: input.venue.address.line1,
              ...(input.venue.address.line2
                ? { line2: input.venue.address.line2 }
                : {}),
              city: input.venue.address.city,
              state: input.venue.address.state,
              postalCode: input.venue.address.postalCode,
              country: input.venue.address.country,
            },
            longitude: input.venue.longitude,
            latitude: input.venue.latitude,
            createdAt: timestamp,
          },
          session,
        );
        await dependencies.repository.insertOwnerMembership(
          {
            _id: membershipId,
            owner_id: ownerId,
            venue_id: venueId,
            role: 'OWNER',
            status: 'ACTIVE',
            created_at: timestamp,
          },
          session,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw duplicateKeyField(error) === 'phone_e164'
          ? phoneAlreadyRegistered()
          : emailAlreadyRegistered();
      }

      throw error;
    }

    /**
     * Offer the standard agreement immediately, so the owner meets it on their first sign-in
     * rather than waiting for an admin to draft one. Without this the onboarding gate had
     * nothing to show and fell straight through to KYC — which is how venues ended up with
     * verified owners, no agreement, and an approval the admin could not complete.
     *
     * Deliberately outside the transaction above and never awaited for its result: the account
     * exists either way, and an admin can always propose terms by hand.
     */
    await dependencies.agreementService?.proposeStandard({
      venueId: venueId.toHexString(),
      ownerId: ownerId.toHexString(),
      venueName: input.venue.displayName,
      correlationId: `register:${ownerId.toHexString()}`,
    });

    return {
      ownerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      membershipId: membershipId.toHexString(),
      ownerStatus: 'ACTIVE',
      venueStatus: 'PENDING',
    };
  }

  async function loginVenueOwner(
    input: LoginVenueOwnerInput,
  ): ReturnType<IdentityService['loginVenueOwner']> {
    const timestamp = now();
    const email = normalizeEmail(input.email);
    const owner = await dependencies.repository.findOwnerByEmail(email);

    if (!owner) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      throw invalidCredentials();
    }

    if (owner.status === 'SUSPENDED') {
      throw new AppError({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is suspended',
        statusCode: 403,
      });
    }

    if (owner.locked_until && owner.locked_until > timestamp) {
      throw new AppError({
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed login attempts. Try again later',
        statusCode: 423,
        details: { lockedUntil: owner.locked_until.toISOString() },
      });
    }

    if (owner.locked_until && owner.locked_until <= timestamp) {
      await dependencies.repository.resetLoginFailures(owner._id, timestamp);
    }

    const passwordMatches = await verifyPassword(
      input.password,
      owner.password_hash,
    );

    if (!passwordMatches) {
      const lockedUntil = new Date(
        timestamp.getTime() + dependencies.authConfig.lockMinutes * 60_000,
      );
      await dependencies.repository.recordFailedLogin(
        owner._id,
        dependencies.authConfig.maxLoginAttempts,
        lockedUntil,
        timestamp,
      );
      throw invalidCredentials();
    }

    return issueSession(owner, input.ipAddress, input.userAgent, timestamp);
  }

  /**
   * Shared by every path that has already proven who the owner is (password match, or a
   * verified OTP access token) and just needs a session. Not exported — every credential check
   * happens in the caller first.
   */
  async function issueSession(
    owner: VenueOwnerDocument,
    ipAddress: string,
    userAgent: string,
    timestamp: Date,
  ): Promise<{
    sessionToken: string;
    expiresAt: string;
    owner: { id: string; legalName: string; email: string; status: 'ACTIVE' };
  }> {
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(
      timestamp.getTime() +
        dependencies.authConfig.sessionTtlHours * 60 * 60_000,
    );
    const sessionCreated = await dependencies.repository.appendSession(
      owner._id,
      {
        token_hash: hashSessionToken(sessionToken),
        ip_hash: createHash('sha256').update(ipAddress.slice(0, 64)).digest('hex'),
        user_agent: userAgent.slice(0, 512),
        expires_at: expiresAt,
        last_seen_at: timestamp,
        revoked_at: null,
        created_at: timestamp,
      },
      dependencies.authConfig.maxSessions,
      timestamp,
    );

    if (!sessionCreated) {
      throw new AppError({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'This account cannot start a session',
        statusCode: 403,
      });
    }

    return {
      sessionToken,
      expiresAt: expiresAt.toISOString(),
      owner: {
        id: owner._id.toHexString(),
        legalName: owner.legal_name,
        email: owner.email,
        status: 'ACTIVE',
      },
    };
  }

  async function loginVenueOwnerWithOtp(
    input: OtpLoginVenueOwnerInput,
  ): ReturnType<IdentityService['loginVenueOwnerWithOtp']> {
    const timestamp = now();
    const phoneE164 = input.phoneE164.trim();

    // Verify with MSG91 before touching the database — there is no owner-guessing timing
    // surface here the way there is for password login, since the expensive step (the outbound
    // call to MSG91) runs unconditionally either way.
    await verifyPhoneAccessToken(phoneE164, input.accessToken);

    const owner = await dependencies.repository.findOwnerByPhone(phoneE164);
    if (!owner) {
      throw phoneNotRegistered();
    }

    if (owner.status === 'SUSPENDED') {
      throw new AppError({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is suspended',
        statusCode: 403,
      });
    }

    // No password-guessing surface to lock out here, but an existing lock (e.g. from the
    // password path, still live during the migration) still applies as defense in depth.
    if (owner.locked_until && owner.locked_until > timestamp) {
      throw new AppError({
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed login attempts. Try again later',
        statusCode: 423,
        details: { lockedUntil: owner.locked_until.toISOString() },
      });
    }
    if (owner.locked_until && owner.locked_until <= timestamp) {
      await dependencies.repository.resetLoginFailures(owner._id, timestamp);
    }

    return issueSession(owner, input.ipAddress, input.userAgent, timestamp);
  }

  async function validateOwnerSession(input: {
    sessionToken: string;
    venueId?: string;
  }): ReturnType<IdentityService['validateOwnerSession']> {
    const timestamp = now();
    const tokenHash = hashSessionToken(input.sessionToken);
    const owner =
      await dependencies.repository.findOwnerBySessionTokenHash(tokenHash);

    if (!owner) {
      throw invalidSession();
    }

    const session = owner.sessions.find(
      (candidate) => candidate.token_hash === tokenHash,
    );

    if (!session) {
      throw invalidSession();
    }

    if (session.revoked_at || session.expires_at <= timestamp) {
      throw invalidSession();
    }

    if (owner.status === 'SUSPENDED') {
      throw new AppError({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is suspended',
        statusCode: 403,
      });
    }

    await dependencies.repository.touchSession(owner._id, tokenHash, timestamp);

    if (input.venueId) {
      const membership =
        await dependencies.repository.findMembershipByOwnerAndVenue(
          owner._id,
          new ObjectId(input.venueId),
        );

      if (!membership || membership.status !== 'ACTIVE') {
        throw new AppError({
          code: 'FORBIDDEN',
          message: 'You are not authorized to access this venue',
          statusCode: 403,
        });
      }

      return {
        ownerId: owner._id.toHexString(),
        ownerStatus: owner.status,
        membership: {
          id: membership._id.toHexString(),
          role: membership.role,
          venueId: membership.venue_id.toHexString(),
        },
      };
    }

    return {
      ownerId: owner._id.toHexString(),
      ownerStatus: owner.status,
      membership: null,
    };
  }

  async function approveVenueOwner(
    input: {
      ownerId: string;
      venueId: string;
      adminId: string;
      correlationId: string;
    },
    session: ClientSession,
  ): Promise<void> {
    const ownerId = toObjectId(input.ownerId);
    const membership =
      await dependencies.repository.findMembershipByOwnerAndVenue(
        ownerId,
        toObjectId(input.venueId),
        session,
      );

    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      membership.role !== 'OWNER'
    ) {
      throw new AppError({
        code: 'OWNER_VENUE_RELATION_REQUIRED',
        message: 'An active OWNER membership is required',
        statusCode: 409,
      });
    }

    const approved = await dependencies.repository.approveOwner(
      ownerId,
      toObjectId(input.adminId),
      input.correlationId,
      now(),
      session,
    );

    if (!approved) {
      throw new AppError({
        code: 'OWNER_APPROVAL_NOT_ALLOWED',
        message: 'The Venue Owner cannot be approved',
        statusCode: 409,
      });
    }
  }

  async function attachOwnerVenue(
    input: {
      ownerId: string;
      venueId: string;
      createdAt: Date;
    },
    session: ClientSession,
  ): Promise<{ membershipId: string }> {
    const ownerId = toObjectId(input.ownerId);
    const venueId = toObjectId(input.venueId);
    const owner = await dependencies.repository.findOwnerById?.(
      ownerId,
      session,
    );
    if (!owner || owner.status !== 'ACTIVE') {
      throw new AppError({
        code: 'ACTIVE_OWNER_REQUIRED',
        message: 'An active Venue Owner is required',
        statusCode: 409,
      });
    }
    if (
      await dependencies.repository.findMembershipByOwnerAndVenue(
        ownerId,
        venueId,
        session,
      )
    ) {
      throw new AppError({
        code: 'OWNER_MEMBERSHIP_EXISTS',
        message: 'The owner already belongs to this Venue',
        statusCode: 409,
      });
    }
    const membershipId = new ObjectId();
    await dependencies.repository.insertOwnerMembership(
      {
        _id: membershipId,
        owner_id: ownerId,
        venue_id: venueId,
        role: 'OWNER',
        status: 'ACTIVE',
        created_at: input.createdAt,
      },
      session,
    );
    return { membershipId: membershipId.toHexString() };
  }

  return {
    registerVenueOwner,
    loginVenueOwner,
    loginVenueOwnerWithOtp,
    validateOwnerSession,
    approveVenueOwner,
    attachOwnerVenue,
  };
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'INVALID_ID',
      message: 'A supplied identifier is invalid',
      statusCode: 400,
    });
  }

  return new ObjectId(value);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}

/** Best-effort: reads which unique index a duplicate-key error tripped, from the driver's own
    `keyPattern`/`keyValue` on the error object. Falls back to email if it can't tell. */
function duplicateKeyField(error: unknown): 'phone_e164' | 'email' {
  if (typeof error === 'object' && error !== null) {
    const keyPattern = (error as { keyPattern?: Record<string, unknown> })
      .keyPattern;
    if (keyPattern && 'phone_e164' in keyPattern) return 'phone_e164';
  }
  return 'email';
}

function emailAlreadyRegistered(): AppError {
  return new AppError({
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'An account with this email already exists',
    statusCode: 409,
  });
}

function phoneAlreadyRegistered(): AppError {
  return new AppError({
    code: 'PHONE_ALREADY_REGISTERED',
    message: 'An account with this phone number already exists',
    statusCode: 409,
  });
}

function phoneNotRegistered(): AppError {
  return new AppError({
    code: 'PHONE_NOT_REGISTERED',
    message: 'No account is registered with this phone number',
    statusCode: 404,
  });
}

function invalidCredentials(): AppError {
  return new AppError({
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect',
    statusCode: 401,
  });
}

function invalidSession(): AppError {
  return new AppError({
    code: 'INVALID_SESSION',
    message: 'The provided session is invalid or has expired',
    statusCode: 401,
  });
}
