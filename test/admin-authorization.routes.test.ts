import assert from 'node:assert/strict';
import { test } from 'node:test';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';

import adminOnboardingRoutes from '../src/modules/admin/onboarding/onboarding.routes.js';
import type { AdminOnboardingService } from '../src/modules/admin/onboarding/onboarding.service.js';
import kycRoutes from '../src/modules/identity/kyc/kyc.routes.js';
import type { KycService } from '../src/modules/identity/kyc/kyc.service.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import partnerAccessRoutes from '../src/modules/identity/partner/partner-access.routes.js';
import type { PartnerAccessService } from '../src/modules/identity/partner/partner-access.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const id = '687f00000000000000000091';

function opsAuth(): AdminAuthService {
  return {
    async authenticate() {
      return { actorType: 'ADMIN', adminId: id, role: 'OPS' };
    },
  } as unknown as AdminAuthService;
}

test('OPS cannot approve Venue onboarding', async () => {
  let called = false;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(adminOnboardingRoutes, {
    adminAuthService: opsAuth(),
    service: {
      async approveVenueOnboarding() {
        called = true;
      },
    } as AdminOnboardingService,
  });
  const response = await app.inject({
    method: 'POST',
    url: `/venues/${id}/approve`,
    headers: { authorization: 'Bearer ops-jwt' },
    payload: { ownerId: id },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
  await app.close();
});

test('SUPPORT and OPS cannot review KYC', async () => {
  let called = false;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(multipart);
  await app.register(kycRoutes, {
    adminAuthService: opsAuth(),
    ownerAccessService: {} as OwnerAccessService,
    service: {
      async review() {
        called = true;
      },
    } as unknown as KycService,
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `/admin/verifications/${id}/review`,
    headers: { authorization: 'Bearer ops-jwt' },
    payload: { status: 'VERIFIED' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
  await app.close();
});

test('OPS cannot issue Partner credentials', async () => {
  let called = false;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(partnerAccessRoutes, {
    adminAuthService: opsAuth(),
    service: {
      async issueKey() {
        called = true;
        throw new Error('must not be called');
      },
    } as unknown as PartnerAccessService,
  });
  const response = await app.inject({
    method: 'POST',
    url: `/admin/${id}/keys`,
    headers: { authorization: 'Bearer ops-jwt' },
    payload: {
      environment: 'SANDBOX',
      scopes: ['bookings:write'],
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
  await app.close();
});
