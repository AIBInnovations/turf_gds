import { ObjectId } from 'mongodb';

import type { AppConfig } from '../../../config/env.js';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from '../../../shared/auth/password.js';
import {
  createAdminJwt,
  verifyAdminJwt,
} from '../../../shared/auth/admin-jwt.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { AdminRole } from './auth.types.js';
import type { AdminAuthRepository } from './auth.repository.js';

export interface AdminAuthService {
  login(input: { email: string; password: string }): Promise<{
    accessToken: string;
    expiresAt: string;
    admin: {
      id: string;
      email: string;
      displayName: string;
      role: AdminRole;
    };
  }>;
  authenticate(token: string): Promise<{
    actorType: 'ADMIN';
    adminId: string;
    role: AdminRole;
  }>;
  bootstrapAdmin(input: {
    email: string;
    password: string;
    displayName: string;
    role: AdminRole;
  }): Promise<{ adminId: string }>;
}

export function createAdminAuthService(input: {
  repository: AdminAuthRepository;
  authConfig: AppConfig['auth'];
  now?: () => Date;
}): AdminAuthService {
  const now = input.now ?? (() => new Date());

  async function login(
    credentials: Parameters<AdminAuthService['login']>[0],
  ): ReturnType<AdminAuthService['login']> {
    const email = credentials.email.trim().toLowerCase();
    const admin = await input.repository.findByEmail(email);

    if (!admin) {
      await verifyPassword(credentials.password, DUMMY_PASSWORD_HASH);
      throw invalidAdminCredentials();
    }

    if (admin.status !== 'ACTIVE') {
      throw new AppError({
        code: 'ADMIN_DISABLED',
        message: 'This admin account is disabled',
        statusCode: 403,
      });
    }

    if (
      !(await verifyPassword(credentials.password, admin.password_hash))
    ) {
      throw invalidAdminCredentials();
    }

    const timestamp = now();
    const issuedAt = Math.floor(timestamp.getTime() / 1_000);
    const expiresAt = new Date(
      timestamp.getTime() +
        input.authConfig.adminAccessTokenTtlMinutes * 60_000,
    );
    const accessToken = createAdminJwt(
      {
        sub: admin._id.toHexString(),
        actor: 'ADMIN',
        role: admin.role,
        iat: issuedAt,
        exp: Math.floor(expiresAt.getTime() / 1_000),
      },
      input.authConfig.adminAccessTokenSecret,
    );
    await input.repository.recordLogin(admin._id, timestamp);

    return {
      accessToken,
      expiresAt: expiresAt.toISOString(),
      admin: {
        id: admin._id.toHexString(),
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role,
      },
    };
  }

  async function authenticate(
    token: string,
  ): ReturnType<AdminAuthService['authenticate']> {
    const payload = verifyAdminJwt(
      token,
      input.authConfig.adminAccessTokenSecret,
      Math.floor(now().getTime() / 1_000),
    );

    if (!payload || !ObjectId.isValid(payload.sub)) {
      throw invalidAdminToken();
    }

    const admin = await input.repository.findById(
      new ObjectId(payload.sub),
    );

    if (!admin || admin.status !== 'ACTIVE' || admin.role !== payload.role) {
      throw invalidAdminToken();
    }

    return {
      actorType: 'ADMIN',
      adminId: admin._id.toHexString(),
      role: admin.role,
    };
  }

  async function bootstrapAdmin(
    values: Parameters<AdminAuthService['bootstrapAdmin']>[0],
  ): ReturnType<AdminAuthService['bootstrapAdmin']> {
    if (values.password.length < 12 || values.password.length > 128) {
      throw new AppError({
        code: 'INVALID_ADMIN_PASSWORD',
        message: 'Admin passwords must contain between 12 and 128 characters',
        statusCode: 400,
      });
    }

    const timestamp = now();
    const id = new ObjectId();

    try {
      await input.repository.createAdmin({
        _id: id,
        email: values.email.trim().toLowerCase(),
        password_hash: await hashPassword(values.password),
        display_name: values.displayName.trim(),
        role: values.role,
        status: 'ACTIVE',
        fcm_tokens: [],
        audit_history: [],
        last_login_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11_000
      ) {
        throw new AppError({
          code: 'ADMIN_ALREADY_EXISTS',
          message: 'An admin with this email already exists',
          statusCode: 409,
        });
      }
      throw error;
    }

    return { adminId: id.toHexString() };
  }

  return { login, authenticate, bootstrapAdmin };
}

function invalidAdminCredentials(): AppError {
  return new AppError({
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect',
    statusCode: 401,
  });
}

function invalidAdminToken(): AppError {
  return new AppError({
    code: 'INVALID_ADMIN_TOKEN',
    message: 'The admin access token is invalid or expired',
    statusCode: 401,
  });
}
