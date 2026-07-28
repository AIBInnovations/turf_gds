import type { AppConfig } from "../../../config/env.js";
import { ObjectId, type ClientSession } from "mongodb";

import type { DatabaseConnection } from "../../../shared/database/database-connection.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "../../../shared/auth/password.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../../../shared/auth/session-token.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { VenueService } from "../../venue/venue.service.js";
import type { IdentityRepository } from "./owner-auth.repository.js";
import type {
  LoginVenueOwnerInput,
  RegisterVenueOwnerInput,
  VenueMembershipRole,
  VenueOwnerStatus,
} from "./owner.types.js";

export interface IdentityService {
  registerVenueOwner(input: RegisterVenueOwnerInput): Promise<{
    ownerId: string;
    venueId: string;
    membershipId: string;
    ownerStatus: "PENDING";
    venueStatus: "PENDING_APPROVAL";
  }>;
  loginVenueOwner(input: LoginVenueOwnerInput): Promise<{
    sessionToken: string;
    expiresAt: string;
    owner: {
      id: string;
      legalName: string;
      email: string;
      status: "PENDING" | "ACTIVE";
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
  approveVenueOwner(input: {
    ownerId: string;
    venueId: string;
    adminId: string;
  }, session: ClientSession): Promise<void>;
}

export interface IdentityServiceDependencies {
  repository: IdentityRepository;
  venueService: VenueService;
  database: DatabaseConnection;
  authConfig: AppConfig["auth"];
  now?: () => Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createIdentityService(
  dependencies: IdentityServiceDependencies,
): IdentityService {
  const now = dependencies.now ?? (() => new Date());

  async function registerVenueOwner(
    input: RegisterVenueOwnerInput,
  ): ReturnType<IdentityService["registerVenueOwner"]> {
    const timestamp = now();
    const passwordHash = await hashPassword(input.password);
    const ownerId = new ObjectId();
    const venueId = new ObjectId();
    const membershipId = new ObjectId();

    try {
      await dependencies.database.withTransaction(async ({ session }) => {
        const email = normalizeEmail(input.email);
        const duplicate = await dependencies.repository.ownerEmailExists(
          email,
          session,
        );

        if (duplicate) {
          throw emailAlreadyRegistered();
        }

        await dependencies.repository.insertOwner(
          {
            _id: ownerId,
            legal_name: input.legalName.trim(),
            email,
            phone_e164: input.phoneE164.trim(),
            password_hash: passwordHash,
            email_verified_at: null,
            status: "PENDING",
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
            role: "OWNER",
            status: "ACTIVE",
            created_at: timestamp,
            updated_at: timestamp,
          },
          session,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw emailAlreadyRegistered();
      }

      throw error;
    }

    return {
      ownerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      membershipId: membershipId.toHexString(),
      ownerStatus: "PENDING",
      venueStatus: "PENDING_APPROVAL",
    };
  }

  async function loginVenueOwner(
    input: LoginVenueOwnerInput,
  ): ReturnType<IdentityService["loginVenueOwner"]> {
    const timestamp = now();
    const email = normalizeEmail(input.email);
    const owner = await dependencies.repository.findOwnerByEmail(email);

    if (!owner) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      throw invalidCredentials();
    }

    if (owner.status === "SUSPENDED") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        message: "This account is suspended",
        statusCode: 403,
      });
    }

    if (owner.locked_until && owner.locked_until > timestamp) {
      throw new AppError({
        code: "ACCOUNT_LOCKED",
        message: "Too many failed login attempts. Try again later",
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

    const sessionToken = generateSessionToken();
    const expiresAt = new Date(
      timestamp.getTime() +
        dependencies.authConfig.sessionTtlHours * 60 * 60_000,
    );
    const sessionCreated = await dependencies.repository.appendSession(
      owner._id,
      {
        token_hash: hashSessionToken(sessionToken),
        ip_address: input.ipAddress.slice(0, 64),
        user_agent: input.userAgent.slice(0, 512),
        created_at: timestamp,
        expires_at: expiresAt,
        revoked_at: null,
      },
      dependencies.authConfig.maxSessions,
      timestamp,
    );

    if (!sessionCreated) {
      throw new AppError({
        code: "ACCOUNT_UNAVAILABLE",
        message: "This account cannot start a session",
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
        status: owner.status,
      },
    };
  }

  async function validateOwnerSession(input: {
    sessionToken: string;
    venueId?: string;
  }): ReturnType<IdentityService["validateOwnerSession"]> {
    const timestamp = now();
    const tokenHash = hashSessionToken(input.sessionToken);
    const owner = await dependencies.repository.findOwnerBySessionTokenHash(
      tokenHash,
    );

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

    if (owner.status === "SUSPENDED") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        message: "This account is suspended",
        statusCode: 403,
      });
    }

    if (input.venueId) {
      const membership = await dependencies.repository.findMembershipByOwnerAndVenue(
        owner._id,
        new ObjectId(input.venueId),
      );

      if (!membership || membership.status !== "ACTIVE") {
        throw new AppError({
          code: "FORBIDDEN",
          message: "You are not authorized to access this venue",
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

  async function approveVenueOwner(input: {
    ownerId: string;
    venueId: string;
    adminId: string;
  }, session: ClientSession): Promise<void> {
    const ownerId = toObjectId(input.ownerId);
    const membership =
      await dependencies.repository.findMembershipByOwnerAndVenue(
        ownerId,
        toObjectId(input.venueId),
        session,
      );

    if (
      !membership ||
      membership.status !== "ACTIVE" ||
      membership.role !== "OWNER"
    ) {
      throw new AppError({
        code: "OWNER_VENUE_RELATION_REQUIRED",
        message: "An active OWNER membership is required",
        statusCode: 409,
      });
    }

    const approved = await dependencies.repository.approveOwner(
      ownerId,
      toObjectId(input.adminId),
      now(),
      session,
    );

    if (!approved) {
      throw new AppError({
        code: "OWNER_APPROVAL_NOT_ALLOWED",
        message: "The Venue Owner cannot be approved",
        statusCode: 409,
      });
    }
  }

  return {
    registerVenueOwner,
    loginVenueOwner,
    validateOwnerSession,
    approveVenueOwner,
  };
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: "INVALID_ID",
      message: "A supplied identifier is invalid",
      statusCode: 400,
    });
  }

  return new ObjectId(value);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11_000
  );
}

function emailAlreadyRegistered(): AppError {
  return new AppError({
    code: "EMAIL_ALREADY_REGISTERED",
    message: "An account with this email already exists",
    statusCode: 409,
  });
}

function invalidCredentials(): AppError {
  return new AppError({
    code: "INVALID_CREDENTIALS",
    message: "Email or password is incorrect",
    statusCode: 401,
  });
}

function invalidSession(): AppError {
  return new AppError({
    code: "INVALID_SESSION",
    message: "The provided session is invalid or has expired",
    statusCode: 401,
  });
}
