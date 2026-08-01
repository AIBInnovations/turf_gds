import assert from 'node:assert/strict';
import { test } from 'node:test';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';

import kycRoutes from '../src/modules/identity/kyc/kyc.routes.js';
import type { KycService } from '../src/modules/identity/kyc/kyc.service.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000050';
const verificationId = '687f00000000000000000051';

function createFixture() {
  const calls: {
    createDraft?: Parameters<KycService['createDraft']>[0];
    getCurrent?: Parameters<KycService['getCurrent']>[0];
  } = {};

  const ownerAccessService: OwnerAccessService = {
    async authenticateOwner() {
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
    async logout() {},
    async getProfile() {
      throw new Error('not used');
    },
    async requirePermission() {},
    async requireVenueMembership() {
      return {
        membershipId: '687f00000000000000000054',
        role: 'OWNER',
      };
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };
  const adminAuthService: AdminAuthService = {
    async login() {
      throw new Error('not used');
    },
    async authenticate() {
      return {
        actorType: 'ADMIN',
        adminId: '687f00000000000000000052',
        role: 'ADMIN',
      };
    },
    async bootstrapAdmin() {
      throw new Error('not used');
    },
  };
  const kycService: KycService = {
    async createDraft(input) {
      calls.createDraft = input;
      return {
        id: verificationId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        verificationType: 'BUSINESS',
        status: 'PENDING',
        isCurrent: true,
        reviewedAt: null,
        rejectionReason: null,
        expiresAt: null,
      };
    },
    async uploadDocument() {
      return {
        documentId: '687f00000000000000000053',
        status: 'PENDING',
      };
    },
    async updateDocumentDetails(){},
    async listDocuments(){return[];},
    async submit() {},
    async getCurrent(input) {
      calls.getCurrent = input;
      return {
        id: verificationId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        verificationType: 'BUSINESS',
        status: 'PENDING',
        isCurrent: true,
        reviewedAt: null,
        rejectionReason: null,
        expiresAt: null,
      };
    },
    async isVerified() {
      return false;
    },
    async review() {},
  };

  return { calls, ownerAccessService, adminAuthService, kycService };
}

async function buildRouteTestApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(multipart);
  await app.register(kycRoutes, {
    service: fixture.kycService,
    ownerAccessService: fixture.ownerAccessService,
    adminAuthService: fixture.adminAuthService,
  });
  return app;
}

test('owner KYC routes require a Bearer session', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'POST',
    url: '/owner/verifications',
    payload: { verificationType: 'BUSINESS' },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('KYC draft creation derives the subject from authentication', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'POST',
    url: '/owner/verifications',
    headers: { authorization: 'Bearer valid-owner-token' },
    payload: { verificationType: 'BUSINESS' },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(fixture.calls.createDraft, {
    subjectType: 'VENUE_OWNER',
    subjectId: ownerId,
    verificationType: 'BUSINESS',
  });
  await app.close();
});

test('current KYC lookup is isolated to the authenticated owner', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'GET',
    url: '/owner/verifications/current/BUSINESS',
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.getCurrent, {
    subjectType: 'VENUE_OWNER',
    subjectId: ownerId,
    verificationType: 'BUSINESS',
  });
  await app.close();
});

test('owner KYC routes reject malformed identifiers', async () => {
  const fixture = createFixture();
  const app = await buildRouteTestApp(fixture);

  const response = await app.inject({
    method: 'POST',
    url: '/owner/verifications/not-an-id/submit',
    headers: { authorization: 'Bearer valid-owner-token' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});
