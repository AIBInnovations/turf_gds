import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import payoutAccountAdminRoutes from '../src/modules/venue/payout-accounts/payout-account-admin.routes.js';
import type { PayoutAccountService } from '../src/modules/venue/payout-accounts/payout-account.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const venueId = '687f00000000000000000c01';
const accountId = '687f00000000000000000c02';

async function appFor(role: 'ADMIN' | 'OPS') {
  const calls: Record<string, unknown> = {};
  const service = {
    async verify(input: unknown) {
      calls.verify = input;
      return { id: accountId, status: 'VERIFIED' };
    },
  } as unknown as PayoutAccountService;
  const adminAuthService = {
    async authenticate() {
      return {
        actorType: 'ADMIN',
        adminId: '687f00000000000000000c03',
        role,
      };
    },
  } as unknown as AdminAuthService;
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(payoutAccountAdminRoutes, {
    service,
    adminAuthService,
  });
  return { app, calls };
}

test('only ADMIN can record payout-account verification', async () => {
  const ops = await appFor('OPS');
  const forbidden = await ops.app.inject({
    method: 'POST',
    url: `/${venueId}/payout-accounts/${accountId}/verification`,
    headers: { authorization: 'Bearer ops-token' },
    payload: { outcome: 'VERIFIED', verificationMethod: 'PENNY_DROP' },
  });
  assert.equal(forbidden.statusCode, 403);
  await ops.app.close();

  const admin = await appFor('ADMIN');
  const verified = await admin.app.inject({
    method: 'POST',
    url: `/${venueId}/payout-accounts/${accountId}/verification`,
    headers: { authorization: 'Bearer admin-token' },
    payload: { outcome: 'VERIFIED', verificationMethod: 'PENNY_DROP' },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(
    (admin.calls.verify as Record<string, unknown>).accountId,
    accountId,
  );
  await admin.app.close();
});
