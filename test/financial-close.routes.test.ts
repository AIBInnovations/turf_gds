import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import financialCloseRoutes from '../src/modules/financial-close/financial-close.routes.js';
import type { FinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type { AdminAuthService } from '../src/modules/identity/platform/auth.service.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';

const adminId = '687f00000000000000000a01';
const partnerId = '687f00000000000000000a02';
const settlementId = '687f00000000000000000a03';

function fixture(role: 'ADMIN' | 'OPS' | 'SUPPORT' = 'ADMIN') {
  const calls: Record<string, unknown> = {};
  const service = {
    async generate(input) {
      calls.generate = input;
      return { settlementId, status: 'DRAFT' };
    },
    async submit(input) {
      calls.submit = input;
      return { settlementId, status: 'PENDING_FUNDS' };
    },
    async reconcile(input) {
      calls.reconcile = input;
      return { settlementId, status: 'RECONCILED' };
    },
    async resolve(input) {
      calls.resolve = input;
      return { settlementId, status: 'RECONCILED' };
    },
    async complete(input) {
      calls.complete = input;
      return { settlementId, status: 'COMPLETED' };
    },
    async get(input) {
      calls.get = input;
      return { settlementId: input, status: 'DRAFT' };
    },
    async list() {
      return {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    },
    async initiatePayout(input) {
      calls.initiatePayout = input;
      return { payoutId: settlementId, status: 'PENDING' };
    },
    async recordPayoutResult(input) {
      calls.recordPayoutResult = input;
      return { payoutId: settlementId, status: input.status };
    },
    async listOwnerSettlements() {
      throw new Error('not used');
    },
    async getOwnerSettlement() {
      throw new Error('not used');
    },
    async listOwnerPayouts() {
      throw new Error('not used');
    },
    async getOwnerPayout() {
      throw new Error('not used');
    },
    async recordAdjustment(input) {
      calls.recordAdjustment = input;
      return { settlementId, entryIds: ['entry-id'] };
    },
    async createInvoice(input) {
      calls.createInvoice = input;
      return { invoiceId: settlementId, status: 'DRAFT' };
    },
    async listInvoices(input) {
      calls.listInvoices = input;
      return {
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    },
    async getInvoice(input) {
      calls.getInvoice = input;
      return { invoiceId: input, status: 'DRAFT' };
    },
    async issueInvoice(input) {
      calls.issueInvoice = input;
      return { invoiceId: input.invoiceId, status: 'ISSUED' };
    },
    async voidInvoice(input) {
      calls.voidInvoice = input;
      return { invoiceId: input.invoiceId, status: 'VOID' };
    },
  } satisfies FinancialCloseService;
  const adminAuthService = {
    async authenticate() {
      return {
        actorType: 'ADMIN',
        adminId,
        role,
      };
    },
  } as unknown as AdminAuthService;
  return { calls, service, adminAuthService };
}

test('Financial Close exposes adjustment and Invoice workflows to ADMIN only', async () => {
  const value = fixture();
  const app = await appFor(value);
  const headers = { authorization: 'Bearer admin-token' };
  const adjusted = await app.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/adjustments`,
    headers,
    payload: {
      bookingId: '687f00000000000000000a04',
      lines: [
        { direction: 'DEBIT', amountMinor: 100, component: 'GROSS' },
        { direction: 'CREDIT', amountMinor: 100, component: 'VENUE_NET' },
      ],
      reason: 'Post-settlement correction',
      evidenceUri: 'https://evidence.example/adjustment/1',
    },
  });
  assert.equal(adjusted.statusCode, 201);
  assert.equal(
    (value.calls.recordAdjustment as { adminId: string }).adminId,
    adminId,
  );

  const created = await app.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/invoices`,
    headers,
  });
  assert.equal(created.statusCode, 201);
  const issued = await app.inject({
    method: 'POST',
    url: `/invoices/${settlementId}/issue`,
    headers,
  });
  assert.equal(issued.statusCode, 200);
  const voided = await app.inject({
    method: 'POST',
    url: `/invoices/${settlementId}/void`,
    headers,
  });
  assert.equal(voided.statusCode, 200);

  const ops = fixture('OPS');
  const opsApp = await appFor(ops);
  const denied = await opsApp.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/invoices`,
    headers,
  });
  assert.equal(denied.statusCode, 403);
});

async function appFor(value: ReturnType<typeof fixture>) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(financialCloseRoutes, value);
  return app;
}

test('Financial Close routes authenticate and derive Admin mutation context', async () => {
  const value = fixture();
  const app = await appFor(value);
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/settlements',
    payload: {
      partnerId,
      environment: 'PRODUCTION',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-08T00:00:00.000Z',
    },
  });
  assert.equal(unauthorized.statusCode, 401);

  const created = await app.inject({
    method: 'POST',
    url: '/settlements',
    headers: { authorization: 'Bearer admin-token' },
    payload: {
      partnerId,
      environment: 'PRODUCTION',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-08T00:00:00.000Z',
    },
  });
  assert.equal(created.statusCode, 201);
  const generate = value.calls.generate as Record<string, unknown>;
  assert.equal(generate.adminId, adminId);
  assert.equal(generate.environment, 'PRODUCTION');
  assert.equal(typeof generate.correlationId, 'string');
  await app.close();
});

test('Financial Close routes enforce ADMIN mutations and validate reconciliation amounts', async () => {
  const ops = fixture('OPS');
  const opsApp = await appFor(ops);
  const forbidden = await opsApp.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/submit`,
    headers: { authorization: 'Bearer ops-token' },
  });
  assert.equal(forbidden.statusCode, 403);
  await opsApp.close();

  const value = fixture();
  const app = await appFor(value);
  const invalid = await app.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/reconciliation`,
    headers: { authorization: 'Bearer admin-token' },
    payload: { reportedAmountMinor: -1 },
  });
  assert.equal(invalid.statusCode, 400);
  const valid = await app.inject({
    method: 'POST',
    url: `/settlements/${settlementId}/reconciliation`,
    headers: { authorization: 'Bearer admin-token' },
    payload: {
      reportedAmountMinor: 8_820,
      bankReference: 'BANK-001',
    },
  });
  assert.equal(valid.statusCode, 201);
  const reconcile = value.calls.reconcile as Record<string, unknown>;
  assert.equal(reconcile.settlementId, settlementId);
  assert.equal(reconcile.adminId, adminId);
  await app.close();
});
