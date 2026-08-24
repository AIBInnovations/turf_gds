import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import type { AdminAuthRepository } from '../src/modules/identity/platform/auth.repository.js';
import { createAdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import type { AdminUserDocument } from '../src/modules/identity/platform/auth.types.js';
import type { OtpProvider } from '../src/modules/identity/owner/msg91-otp.provider.js';
import { hashPassword } from '../src/shared/auth/password.js';
import { AppError } from '../src/shared/errors/app-error.js';

/** Treats the "access token" as the verified phone's digits directly — see identity.service.test.ts. */
function createFakeOtpProvider(): OtpProvider {
  return {
    async verifyAccessToken({ accessToken }) {
      return { verifiedPhoneDigits: accessToken };
    },
  };
}

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

function createFixtureWithClock(
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
) {
  let currentNow = fixedNow;
  const admin: AdminUserDocument = {
    _id: new ObjectId('687f00000000000000000001'),
    email: 'admin@example.com',
    password_hash: '',
    display_name: 'Platform Admin',
    role: 'ADMIN',
    status,
    phone_e164: null,
    failed_login_count: 0,
    locked_until: null,
    fcm_tokens: [],
    audit_history: [],
    last_login_at: null,
    created_at: fixedNow,
    updated_at: fixedNow,
  };
  const repository: AdminAuthRepository = {
    async findByEmail(email) {
      return email === admin.email ? admin : null;
    },
    async findById(id) {
      return id.equals(admin._id) ? admin : null;
    },
    async findByPhone(phoneE164) {
      return admin.phone_e164 === phoneE164 ? admin : null;
    },
    async phoneExists(phoneE164) {
      return admin.phone_e164 === phoneE164;
    },
    async setPhone(_id, phoneE164, updatedAt) {
      admin.phone_e164 = phoneE164;
      admin.updated_at = updatedAt;
    },
    async recordLogin(_id, now) {
      admin.last_login_at = now;
      admin.failed_login_count = 0;
      admin.locked_until = null;
    },
    async recordFailedLogin(_id, maximumAttempts, lockedUntil) {
      admin.failed_login_count += 1;
      if (admin.failed_login_count >= maximumAttempts) {
        admin.locked_until = lockedUntil;
      }
    },
    async resetLoginFailures() {
      admin.failed_login_count = 0;
      admin.locked_until = null;
    },
    async createAdmin() {},
  };
  return {
    admin,
    setNow: (value: Date) => {
      currentNow = value;
    },
    service: createAdminAuthService({
      repository,
      authConfig,
      otpProvider: createFakeOtpProvider(),
      now: () => currentNow,
    }),
  };
}

async function createFixture(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') {
  const fixture = createFixtureWithClock(status);
  fixture.admin.password_hash = await hashPassword('correct-horse-battery');
  return fixture;
}

test('active admin login creates a verifiable access token', async () => {
  const fixture = await createFixture();
  const login = await fixture.service.login({
    email: 'ADMIN@EXAMPLE.COM',
    password: 'correct-horse-battery',
  });
  const context = await fixture.service.authenticate(login.accessToken);

  assert.equal(context.adminId, fixture.admin._id.toHexString());
  assert.equal(context.role, 'ADMIN');
  assert.equal(
    fixture.admin.last_login_at?.toISOString(),
    fixedNow.toISOString(),
  );
});

test('disabled admins cannot log in', async () => {
  const fixture = await createFixture('DISABLED');

  await assert.rejects(
    fixture.service.login({
      email: fixture.admin.email,
      password: 'correct-horse-battery',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'ADMIN_DISABLED',
  );
});

test('admin account locks after maxLoginAttempts consecutive wrong passwords', async () => {
  const fixture = await createFixture();

  for (let attempt = 0; attempt < authConfig.maxLoginAttempts; attempt += 1) {
    await assert.rejects(
      fixture.service.login({
        email: fixture.admin.email,
        password: 'wrong-password',
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'INVALID_CREDENTIALS',
    );
  }

  await assert.rejects(
    fixture.service.login({
      email: fixture.admin.email,
      password: 'correct-horse-battery',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'ADMIN_ACCOUNT_LOCKED' &&
      error.statusCode === 423,
  );
});

test('admin lockout naturally expires and resets the failure counter', async () => {
  const fixture = await createFixture();

  for (let attempt = 0; attempt < authConfig.maxLoginAttempts; attempt += 1) {
    await assert.rejects(
      fixture.service.login({
        email: fixture.admin.email,
        password: 'wrong-password',
      }),
    );
  }
  assert.ok(fixture.admin.locked_until);

  fixture.setNow(
    new Date(
      fixture.admin.locked_until!.getTime() + 60_000,
    ),
  );

  const login = await fixture.service.login({
    email: fixture.admin.email,
    password: 'correct-horse-battery',
  });
  assert.ok(login.accessToken);
  assert.equal(fixture.admin.failed_login_count, 0);
  assert.equal(fixture.admin.locked_until, null);
});

test('a successful login resets a sub-threshold failure counter', async () => {
  const fixture = await createFixture();

  await assert.rejects(
    fixture.service.login({
      email: fixture.admin.email,
      password: 'wrong-password',
    }),
  );
  assert.equal(fixture.admin.failed_login_count, 1);

  await fixture.service.login({
    email: fixture.admin.email,
    password: 'correct-horse-battery',
  });
  assert.equal(fixture.admin.failed_login_count, 0);
  assert.equal(fixture.admin.locked_until, null);
});

test('login for an unknown email stays enumeration-safe and does not touch lockout state', async () => {
  const fixture = await createFixture();

  await assert.rejects(
    fixture.service.login({
      email: 'nobody@example.com',
      password: 'correct-horse-battery',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVALID_CREDENTIALS',
  );
  assert.equal(fixture.admin.failed_login_count, 0);
  assert.equal(fixture.admin.locked_until, null);
});

test('setPhone attaches a verified phone to the caller’s own account', async () => {
  const fixture = await createFixture();

  await fixture.service.setPhone({
    adminId: fixture.admin._id.toHexString(),
    phoneE164: '+919876543210',
    accessToken: '919876543210',
  });

  assert.equal(fixture.admin.phone_e164, '+919876543210');
});

test('setPhone rejects a token verified for a different phone', async () => {
  const fixture = await createFixture();

  await assert.rejects(
    fixture.service.setPhone({
      adminId: fixture.admin._id.toHexString(),
      phoneE164: '+919876543210',
      accessToken: '919999999999',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PHONE_TOKEN_MISMATCH',
  );
  assert.equal(fixture.admin.phone_e164, null);
});

test('setPhone rejects a phone already linked to another admin', async () => {
  const fixture = await createFixture();
  fixture.admin.phone_e164 = '+919876543210';

  await assert.rejects(
    fixture.service.setPhone({
      adminId: fixture.admin._id.toHexString(),
      phoneE164: '+919876543210',
      accessToken: '919876543210',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PHONE_ALREADY_REGISTERED',
  );
});

test('otpLogin issues an access token for a verified phone', async () => {
  const fixture = await createFixture();
  fixture.admin.phone_e164 = '+919876543210';

  const result = await fixture.service.otpLogin({
    phoneE164: '+919876543210',
    accessToken: '919876543210',
  });
  const context = await fixture.service.authenticate(result.accessToken);

  assert.equal(context.adminId, fixture.admin._id.toHexString());
  assert.equal(fixture.admin.last_login_at?.toISOString(), fixedNow.toISOString());
});

test('otpLogin rejects a phone with no linked admin', async () => {
  const fixture = await createFixture();

  await assert.rejects(
    fixture.service.otpLogin({
      phoneE164: '+919876543210',
      accessToken: '919876543210',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PHONE_NOT_REGISTERED',
  );
});

test('otpLogin rejects a disabled admin even with a valid verification', async () => {
  const fixture = await createFixture('DISABLED');
  fixture.admin.phone_e164 = '+919876543210';

  await assert.rejects(
    fixture.service.otpLogin({
      phoneE164: '+919876543210',
      accessToken: '919876543210',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'ADMIN_DISABLED',
  );
});
