import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import venueOperationsRoutes from '../src/modules/venue/venue-operations.routes.js';
import type { VenueOperationsService } from '../src/modules/venue/venue-operations.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000110';
const venueId = '687f00000000000000000111';
const courtId = '687f00000000000000000112';
const slotId = '687f00000000000000000113';

function createFixture() {
  const calls: Record<string, unknown> = {};
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
        membershipId: '687f00000000000000000114',
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
  const service: VenueOperationsService = {
    async createPricingRule(input) {
      calls.createPricingRule = input;
      return { id: 'rule-id' };
    },
    async listPricingRules(input) {
      calls.listPricingRules = input;
      return [];
    },
    async updatePricingRule(input) {
      calls.updatePricingRule = input;
      return { id: input.pricingRuleId };
    },
    async generateFixedSlots(input) {
      calls.generateFixedSlots = input;
      return { created: 2 };
    },
    async listInventory(input) {
      calls.listInventory = input;
      return [];
    },
    async blockAvailability(input) {
      calls.blockAvailability = input;
      return { id: input.slotId ?? slotId };
    },
    async releaseAvailability(input) {
      calls.releaseAvailability = input;
      return { id: input.slotId, status: 'AVAILABLE' };
    },
    async addPayoutAccount(input) {
      calls.addPayoutAccount = input;
      return { id: 'account-id', status: 'PENDING' };
    },
    async listPayoutAccounts(input) {
      calls.listPayoutAccounts = input;
      return [];
    },
    async searchAvailability() {
      return [];
    },
  };
  return { calls, ownerAccessService, service };
}

async function buildApp(fixture: ReturnType<typeof createFixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(venueOperationsRoutes, {
    service: fixture.service,
    ownerAccessService: fixture.ownerAccessService,
  });
  return app;
}

test('Venue operations routes require a Venue Owner session', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const response = await app.inject(
    `/${venueId}/courts/${courtId}/pricing-rules`,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
});

test('pricing and slot generation routes derive owner and correlation context', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const headers = { authorization: 'Bearer owner-session' };
  const pricingResponse = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts/${courtId}/pricing-rules`,
    headers,
    payload: {
      name: 'Standard',
      dayOfWeek: 1,
      startTime: '06:00',
      endTime: '22:00',
      priceMinor: 150000,
      currency: 'INR',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      priority: 1,
    },
  });
  const generateResponse = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts/${courtId}/slots/generate`,
    headers,
    payload: { dateFrom: '2026-07-28', dateTo: '2026-07-29' },
  });

  assert.equal(pricingResponse.statusCode, 201);
  assert.equal(generateResponse.statusCode, 200);
  const pricingCall = fixture.calls.createPricingRule as Record<
    string,
    unknown
  >;
  const generationCall = fixture.calls.generateFixedSlots as Record<
    string,
    unknown
  >;
  assert.equal(pricingCall.actorOwnerId, ownerId);
  assert.equal(pricingCall.venueId, venueId);
  assert.equal(generationCall.courtId, courtId);
  assert.equal(typeof generationCall.correlationId, 'string');
  await app.close();
});

test('inventory block schema requires exactly one fixed or open-time shape', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const headers = { authorization: 'Bearer owner-session' };
  const invalid = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts/${courtId}/inventory/block`,
    headers,
    payload: { reason: 'Missing inventory target' },
  });
  const valid = await app.inject({
    method: 'POST',
    url: `/${venueId}/courts/${courtId}/inventory/block`,
    headers,
    payload: { reason: 'Maintenance', slotId, slotVersion: 1 },
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(valid.statusCode, 201);
  const call = fixture.calls.blockAvailability as Record<string, unknown>;
  assert.equal(call.actorOwnerId, ownerId);
  assert.equal(call.slotVersion, 1);
  await app.close();
});

test('unsupported content route is absent and payout route ignores raw banking fields', async () => {
  const fixture = createFixture();
  const app = await buildApp(fixture);
  const headers = { authorization: 'Bearer owner-session' };
  const contentResponse = await app.inject({
    method: 'PUT',
    url: `/${venueId}/content`,
    headers,
    payload: { content: { amenities: ['Parking'] } },
  });
  const rawBankResponse = await app.inject({
    method: 'POST',
    url: `/${venueId}/payout-accounts`,
    headers,
    payload: {
      accountHolderName: 'Venue Owner',
      vaultProvider: 'bank-vault',
      vaultAccountToken: 'tok_account_123456',
      accountLast4: '6789',
      accountNumber: '123456789',
      bankName: 'Example Bank',
      ifscCode: 'ABCD0123456',
    },
  });

  assert.equal(contentResponse.statusCode, 404);
  assert.equal(rawBankResponse.statusCode, 201);
  const payoutCall = fixture.calls.addPayoutAccount as Record<
    string,
    unknown
  >;
  assert.equal('accountNumber' in payoutCall, false);
  await app.close();
});
