import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminOnboardingService } from '../src/modules/admin/onboarding/onboarding.service.js';
import type { KycService } from '../src/modules/identity/kyc/kyc.service.js';
import type { IdentityService } from '../src/modules/identity/owner/owner-auth.service.js';
import type { VenueService } from '../src/modules/venue/profile/venue.service.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const ownerId = '687f00000000000000000040';
const adminId = '687f00000000000000000041';
const venueId = '687f00000000000000000042';
const correlationId = 'request-1';

function createFixture(kycVerified: boolean) {
  let approvedInput:
    | Parameters<IdentityService['approveVenueOwner']>[0]
    | undefined;
  let approvedVenue:
    | Parameters<VenueService['approveVenue']>[0]
    | undefined;

  const identityService = {
    async registerVenueOwner() {
      throw new Error('not used');
    },
    async loginVenueOwner() {
      throw new Error('not used');
    },
    async validateOwnerSession() {
      throw new Error('not used');
    },
    async approveVenueOwner(input) {
      approvedInput = input;
    },
  } satisfies IdentityService;

  const venueService = {
    async createInitialVenue() {
      throw new Error('not used');
    },
    async approveVenue(input) {
      approvedVenue = input;
    },
  } satisfies VenueService;

  const kycService = {
    async createDraft() {
      throw new Error('not used');
    },
    async uploadDocument() {
      throw new Error('not used');
    },
    async submit() {
      throw new Error('not used');
    },
    async getCurrent() {
      throw new Error('not used');
    },
    async isVerified() {
      return kycVerified;
    },
    async review() {
      throw new Error('not used');
    },
  } satisfies KycService;

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

  return {
    service: createAdminOnboardingService({
      identityService,
      kycService,
      venueService,
      database,
    }),
    getApprovedInput: () => approvedInput,
    getApprovedVenue: () => approvedVenue,
  };
}

test('admin onboarding approves owner and venue with verified business KYC', async () => {
  const fixture = createFixture(true);

  await fixture.service.approveVenueOnboarding({
    ownerId,
    venueId,
    adminId,
    correlationId,
  });

  assert.deepEqual(fixture.getApprovedInput(), {
    ownerId,
    venueId,
    adminId,
    correlationId,
  });
  assert.deepEqual(fixture.getApprovedVenue(), {
    ownerId,
    venueId,
    adminId,
    correlationId,
  });
});

test('admin onboarding rejects approval without verified business KYC', async () => {
  const fixture = createFixture(false);

  await assert.rejects(
    fixture.service.approveVenueOnboarding({
      ownerId,
      venueId,
      adminId,
      correlationId,
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'OWNER_KYC_REQUIRED',
  );
  assert.equal(fixture.getApprovedInput(), undefined);
  assert.equal(fixture.getApprovedVenue(), undefined);
});
