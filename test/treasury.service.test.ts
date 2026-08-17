import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import { createTreasuryService } from '../src/modules/treasury/treasury.service.js';
import type { TreasuryProvider } from '../src/modules/treasury/razorpay.provider.js';
import type { PayoutAttemptDocument } from '../src/modules/treasury/treasury.types.js';
import type {
  PayoutDocument,
} from '../src/modules/financial-close/financial-close.types.js';
import type { PartnerRemittanceDocument } from '../src/modules/treasury/treasury.types.js';
import type { VenuePayoutAccountDocument } from '../src/modules/venue/payout-accounts/payout-account.types.js';
import type { FinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const now = new Date('2026-08-01T10:00:00.000Z');

function duplicateKeyError(): Error & { code: number } {
  const error = new Error('duplicate key') as Error & { code: number };
  error.code = 11_000;
  return error;
}

function createFixture(options: {
  simulateInsertRace?: boolean;
} = {}) {
  const payoutId = new ObjectId();
  const accountId = new ObjectId();
  const settlementId = new ObjectId();

  const payout: PayoutDocument = {
    _id: payoutId,
    settlement_id: settlementId,
    venue_id: new ObjectId(),
    payout_account_id: accountId,
    environment: 'PRODUCTION',
    amount_minor: 8_820,
    currency: 'INR',
    status: 'PENDING',
    idempotency_key: 'payout-idem-key',
    bank_reference: null,
    failure_reason: null,
    initiated_at: null,
    paid_at: null,
    audit_history: [],
    created_at: now,
    updated_at: now,
  };
  const account: VenuePayoutAccountDocument = {
    _id: accountId,
    venue_id: payout.venue_id,
    account_holder_name: 'Turf Owner',
    vault_provider: 'RAZORPAY',
    vault_account_token: 'vault-token-1',
    account_last4: '6789',
    bank_name: 'Example Bank',
    ifsc_code: 'RAZR0000001',
    status: 'VERIFIED',
    verified_by: new ObjectId(),
    verified_at: now,
    verification_failure_reason: null,
    verification_method: 'PENNY_DROP',
    is_default: true,
    documents: [],
    version: 1,
    audit_history: [],
    created_at: now,
    updated_at: now,
  };

  const attemptsStore = new Map<string, PayoutAttemptDocument>();
  let attemptsFindOneCalls = 0;

  const attemptsCollection = {
    async findOne(filter: Record<string, unknown>) {
      if (filter.idempotency_key) {
        attemptsFindOneCalls += 1;
        if (
          options.simulateInsertRace &&
          attemptsFindOneCalls === 1
        ) {
          return null;
        }
        for (const doc of attemptsStore.values()) {
          if (doc.idempotency_key === filter.idempotency_key) return doc;
        }
        return null;
      }
      if (filter._id) {
        return attemptsStore.get((filter._id as ObjectId).toHexString()) ?? null;
      }
      return null;
    },
    async insertOne(doc: PayoutAttemptDocument) {
      for (const existing of attemptsStore.values()) {
        if (existing.idempotency_key === doc.idempotency_key) {
          throw duplicateKeyError();
        }
      }
      attemptsStore.set(doc._id.toHexString(), doc);
    },
    async findOneAndUpdate(
      filter: { _id: ObjectId },
      update: { $set: Partial<PayoutAttemptDocument> },
    ) {
      const existing = attemptsStore.get(filter._id.toHexString());
      if (!existing) return null;
      const updated = { ...existing, ...update.$set };
      attemptsStore.set(filter._id.toHexString(), updated);
      return updated;
    },
    async updateOne(
      filter: { _id: ObjectId },
      update: { $set: Partial<PayoutAttemptDocument> },
    ) {
      const existing = attemptsStore.get(filter._id.toHexString());
      if (existing) {
        attemptsStore.set(filter._id.toHexString(), { ...existing, ...update.$set });
      }
    },
    find(filter: { status?: { $in: string[] }; updated_at?: { $lt: Date } }) {
      const results = [...attemptsStore.values()].filter((doc) => {
        if (filter.status && !filter.status.$in.includes(doc.status)) return false;
        if (filter.updated_at && !(doc.updated_at < filter.updated_at.$lt)) return false;
        return true;
      });
      const chain = {
        sort: () => chain,
        limit: () => chain,
        toArray: async () => results,
      };
      return chain;
    },
  };

  const fakeDb = {
    collection(name: string) {
      if (name === 'payouts') {
        return { findOne: async () => ({ ...payout }) };
      }
      if (name === 'partner_remittances') {
        return {
          findOne: async () => ({
            _id: new ObjectId(),
            settlement_id: settlementId,
            status: 'RECEIVED',
          }),
        };
      }
      if (name === 'venue_payout_accounts') {
        return { findOne: async () => ({ ...account }) };
      }
      if (name === 'payout_attempts') {
        return attemptsCollection;
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  const recordPayoutResultCalls: unknown[] = [];
  let recordPayoutResultError: Error | null = null;
  const financialClose = {
    async recordPayoutResult(values: unknown) {
      recordPayoutResultCalls.push(values);
      if (recordPayoutResultError) throw recordPayoutResultError;
      return {};
    },
  } as unknown as FinancialCloseService;

  const database = {
    db: fakeDb as never,
  } as unknown as DatabaseConnection;

  return {
    payoutId,
    accountId,
    attemptsStore,
    recordPayoutResultCalls,
    failRecordPayoutResultWith(error: Error | null) {
      recordPayoutResultError = error;
    },
    database,
    financialClose,
    createService(provider: TreasuryProvider) {
      return createTreasuryService({
        database,
        provider,
        financialClose,
        now: () => now,
      });
    },
  };
}

function stubProvider(overrides: Partial<TreasuryProvider> = {}): TreasuryProvider {
  return {
    async createCollectionReference() {
      throw new Error('not used');
    },
    async createPayout() {
      return { id: 'pout_1', status: 'processing' };
    },
    async fetchPayoutStatus() {
      return { id: 'pout_1', status: 'processing', utr: null, failureReason: null };
    },
    verifyWebhook() {},
    ...overrides,
  };
}

test('initiateProviderPayout replays idempotently when insertOne loses a concurrent duplicate-key race', async () => {
  const fixture = createFixture({ simulateInsertRace: true });
  let createPayoutCalls = 0;
  const provider = stubProvider({
    async createPayout() {
      createPayoutCalls += 1;
      return { id: 'pout_winner', status: 'processing' };
    },
  });
  const service = fixture.createService(provider);

  const first = await service.initiateProviderPayout({
    payoutId: fixture.payoutId.toHexString(),
    adminId: new ObjectId().toHexString(),
  }) as { attemptId: string };
  assert.equal(createPayoutCalls, 1);

  const second = await service.initiateProviderPayout({
    payoutId: fixture.payoutId.toHexString(),
    adminId: new ObjectId().toHexString(),
  }) as { attemptId: string };

  assert.equal(second.attemptId, first.attemptId);
  assert.equal(createPayoutCalls, 1, 'provider must not be called twice for the same idempotency key');
});

test('initiateProviderPayout marks the attempt FAILED on a definite provider rejection', async () => {
  const fixture = createFixture();
  const provider = stubProvider({
    async createPayout() {
      throw new AppError({
        code: 'TREASURY_PROVIDER_ERROR',
        message: 'Razorpay request failed',
        statusCode: 502,
        details: { providerStatus: 400, providerError: { description: 'invalid fund account' } },
      });
    },
  });
  const service = fixture.createService(provider);

  await assert.rejects(
    service.initiateProviderPayout({
      payoutId: fixture.payoutId.toHexString(),
      adminId: new ObjectId().toHexString(),
    }),
  );

  const [attempt] = [...fixture.attemptsStore.values()];
  assert.equal(attempt?.status, 'FAILED');
});

test('initiateProviderPayout marks the attempt AWAITING_RECONCILIATION on an ambiguous provider error', async () => {
  const fixture = createFixture();
  const provider = stubProvider({
    async createPayout() {
      throw new Error('fetch failed');
    },
  });
  const service = fixture.createService(provider);

  await assert.rejects(
    service.initiateProviderPayout({
      payoutId: fixture.payoutId.toHexString(),
      adminId: new ObjectId().toHexString(),
    }),
  );

  const [attempt] = [...fixture.attemptsStore.values()];
  assert.equal(attempt?.status, 'AWAITING_RECONCILIATION');
});

test('reconcilePendingPayouts transitions a stale AWAITING_RECONCILIATION attempt to PAID', async () => {
  const fixture = createFixture();
  const provider = stubProvider({
    async createPayout() {
      throw new Error('fetch failed');
    },
    async fetchPayoutStatus() {
      return { id: 'pout_stuck', status: 'processed', utr: 'UTR123', failureReason: null };
    },
  });
  const service = fixture.createService(provider);

  await assert.rejects(
    service.initiateProviderPayout({
      payoutId: fixture.payoutId.toHexString(),
      adminId: new ObjectId().toHexString(),
    }),
  );
  const [attempt] = [...fixture.attemptsStore.values()];
  assert.equal(attempt?.status, 'AWAITING_RECONCILIATION');
  // reconciliation only considers attempts stale by more than the internal threshold
  attempt!.updated_at = new Date(now.getTime() - 10 * 60_000);
  attempt!.provider_payout_id = 'pout_stuck';
  fixture.attemptsStore.set(attempt!._id.toHexString(), attempt!);

  await service.reconcilePendingPayouts();

  const reconciled = fixture.attemptsStore.get(attempt!._id.toHexString());
  assert.equal(reconciled?.status, 'PAID');
  assert.equal(fixture.recordPayoutResultCalls.length, 1);
  assert.deepEqual(fixture.recordPayoutResultCalls[0], {
    adminId: '000000000000000000000001',
    payoutId: fixture.payoutId.toHexString(),
    status: 'PAID',
    bankReference: 'UTR123',
    correlationId: `provider-reconcile:${attempt!._id.toHexString()}`,
  });
});

test('reconcilePendingPayouts finalises an attempt the webhook already settled', async () => {
  const fixture = createFixture();
  const provider = stubProvider({
    async createPayout() {
      throw new Error('fetch failed');
    },
    async fetchPayoutStatus() {
      return { id: 'pout_done', status: 'processed', utr: 'UTR999', failureReason: null };
    },
  });
  const service = fixture.createService(provider);

  await assert.rejects(
    service.initiateProviderPayout({
      payoutId: fixture.payoutId.toHexString(),
      adminId: new ObjectId().toHexString(),
    }),
  );
  const [attempt] = [...fixture.attemptsStore.values()];
  attempt!.updated_at = new Date(now.getTime() - 10 * 60_000);
  attempt!.provider_payout_id = 'pout_done';
  fixture.attemptsStore.set(attempt!._id.toHexString(), attempt!);

  // The API's webhook handler got there first, so the payout is no longer
  // PENDING. That is a completed reconciliation, not a failure.
  fixture.failRecordPayoutResultWith(
    new AppError({
      code: 'PAYOUT_NOT_PENDING',
      message: 'Payout was already finalised',
      statusCode: 409,
    }),
  );

  await service.reconcilePendingPayouts();

  // Previously the throw skipped the terminal write, leaving the attempt stale
  // forever and re-hitting the provider on every pass.
  const reconciled = fixture.attemptsStore.get(attempt!._id.toHexString());
  assert.equal(reconciled?.status, 'PAID');
  assert.equal(reconciled?.reconcile_lease_until, null);
});

test('reconcilePendingPayouts gives up after repeated transient failures', async () => {
  const fixture = createFixture();
  const provider = stubProvider({
    async createPayout() {
      throw new Error('fetch failed');
    },
    async fetchPayoutStatus() {
      throw new Error('provider unreachable');
    },
  });
  const service = fixture.createService(provider);

  await assert.rejects(
    service.initiateProviderPayout({
      payoutId: fixture.payoutId.toHexString(),
      adminId: new ObjectId().toHexString(),
    }),
  );
  const [attempt] = [...fixture.attemptsStore.values()];
  attempt!.provider_payout_id = 'pout_unreachable';

  for (let pass = 0; pass < 10; pass += 1) {
    const current = fixture.attemptsStore.get(attempt!._id.toHexString())!;
    current.updated_at = new Date(now.getTime() - 10 * 60_000);
    current.reconcile_lease_until = null;
    fixture.attemptsStore.set(attempt!._id.toHexString(), current);
    await service.reconcilePendingPayouts();
  }

  const exhausted = fixture.attemptsStore.get(attempt!._id.toHexString());
  assert.equal(exhausted?.status, 'FAILED');
  assert.equal(exhausted?.failure_reason, 'Reconciliation exhausted');
});

function createRemittanceFixture() {
  const partnerId = new ObjectId();
  const settlementId = new ObjectId();
  const store = new Map<string, PartnerRemittanceDocument>();

  function makeRemittance(environment: 'SANDBOX' | 'PRODUCTION'): PartnerRemittanceDocument {
    return {
      _id: new ObjectId(),
      settlement_id: settlementId,
      partner_id: partnerId,
      environment,
      expected_amount_minor: 10_000,
      received_amount_minor: 0,
      currency: 'INR',
      status: 'AWAITING_FUNDS',
      provider: 'RAZORPAY',
      provider_reference: `SET-${settlementId.toHexString()}`,
      virtual_account_id: `va_${environment.toLowerCase()}`,
      virtual_account_number: '999900000001',
      virtual_account_ifsc: 'RAZR0000001',
      due_at: now,
      receipts: [],
      manual_evidence: [],
      created_at: now,
      updated_at: now,
    };
  }

  const productionRemittance = makeRemittance('PRODUCTION');
  const sandboxRemittance = makeRemittance('SANDBOX');
  store.set(productionRemittance._id.toHexString(), productionRemittance);
  store.set(sandboxRemittance._id.toHexString(), sandboxRemittance);

  function matches(doc: PartnerRemittanceDocument, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      const actual = (doc as unknown as Record<string, unknown>)[key];
      if (actual instanceof ObjectId && value instanceof ObjectId) return actual.equals(value);
      return actual === value;
    });
  }

  const remittancesCollection = {
    async findOne(filter: Record<string, unknown>) {
      for (const doc of store.values()) if (matches(doc, filter)) return doc;
      return null;
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $push?: Record<string, unknown> },
    ) {
      for (const doc of store.values()) {
        if (matches(doc, filter)) {
          Object.assign(doc, update.$set);
          if (update.$push) {
            for (const [key, value] of Object.entries(update.$push)) {
              (doc as unknown as Record<string, unknown[]>)[key] = [
                ...((doc as unknown as Record<string, unknown[]>)[key] ?? []),
                value,
              ];
            }
          }
          return doc;
        }
      }
      return null;
    },
  };

  const database = {
    db: { collection: () => remittancesCollection } as never,
  } as unknown as DatabaseConnection;

  const service = createTreasuryService({
    database,
    provider: stubProvider(),
    financialClose: { async recordPayoutResult() { return {}; } } as unknown as FinancialCloseService,
    now: () => now,
  });

  return { service, partnerId, settlementId, productionRemittance, sandboxRemittance };
}

test('getRemittance is scoped by environment and cannot cross from SANDBOX into PRODUCTION', async () => {
  const fixture = createRemittanceFixture();

  const production = await fixture.service.getRemittance({
    settlementId: fixture.settlementId.toHexString(),
    partnerId: fixture.partnerId.toHexString(),
    environment: 'PRODUCTION',
  }) as { virtualAccount: { id: string } | null };
  assert.equal(production.virtualAccount?.id, 'va_production');

  const sandbox = await fixture.service.getRemittance({
    settlementId: fixture.settlementId.toHexString(),
    partnerId: fixture.partnerId.toHexString(),
    environment: 'SANDBOX',
  }) as { virtualAccount: { id: string } | null };
  assert.equal(sandbox.virtualAccount?.id, 'va_sandbox');
});

test('submitManual cannot submit manual evidence for another environment\'s remittance', async () => {
  const fixture = createRemittanceFixture();

  const updated = await fixture.service.submitManual({
    settlementId: fixture.settlementId.toHexString(),
    partnerId: fixture.partnerId.toHexString(),
    environment: 'SANDBOX',
    amountMinor: 10_000,
    bankReference: 'BANKREF-1',
  }) as { manualEvidence: unknown[] };
  assert.equal(updated.manualEvidence.length, 1);

  const productionAfter = fixture.productionRemittance;
  assert.equal(productionAfter.manual_evidence.length, 0);
  assert.equal(productionAfter.status, 'AWAITING_FUNDS');
});
