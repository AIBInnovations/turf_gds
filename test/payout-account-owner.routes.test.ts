import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import payoutAccountOwnerRoutes from '../src/modules/venue/payout-accounts/payout-account-owner.routes.js';
import type { PayoutAccountService } from '../src/modules/venue/payout-accounts/payout-account.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const ownerId = '687f00000000000000000100';
const venueId = '687f00000000000000000101';

test('owner payout-account routes are authenticated and strip raw banking fields', async () => {
  const calls: Record<string, unknown> = {};
  const service = {
    async add(input: unknown) {
      calls.add = input;
      return { id: 'account-id', status: 'PENDING' };
    },
    async list(input: unknown) {
      calls.list = input;
      return [];
    },
  } as unknown as PayoutAccountService;
  const ownerAccessService = {
    async authenticateOwner() {
      return { actorType: 'OWNER', ownerId, status: 'ACTIVE' };
    },
  } as unknown as OwnerAccessService;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(payoutAccountOwnerRoutes, {
    service,
    ownerAccessService,
  });
  const unauthorized = await app.inject({
    method: 'GET',
    url: `/${venueId}/payout-accounts`,
  });
  assert.equal(unauthorized.statusCode, 401);
  const created = await app.inject({
    method: 'POST',
    url: `/${venueId}/payout-accounts`,
    headers: { authorization: 'Bearer owner-session' },
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
  assert.equal(created.statusCode, 201);
  const call = calls.add as Record<string, unknown>;
  assert.equal(call.actorOwnerId, ownerId);
  assert.equal('accountNumber' in call, false);
  await app.close();
});
