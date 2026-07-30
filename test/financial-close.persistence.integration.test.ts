import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import { initializeContractPersistence } from '../src/modules/contracts/contract.persistence.js';
import type { PartnerVenueContractDocument } from '../src/modules/contracts/contract.types.js';
import { initializeFinancialClosePersistence } from '../src/modules/financial-close/financial-close.persistence.js';
import { createFinancialCloseRepository } from '../src/modules/financial-close/financial-close.repository.js';
import { createFinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type {
  ReconciliationDocument,
  SettlementDocument,
} from '../src/modules/financial-close/financial-close.types.js';
import { initializeLedgerPersistence } from '../src/modules/ledger/ledger.persistence.js';
import {
  createLedgerRepository,
  type LedgerEntryDocument,
} from '../src/modules/ledger/ledger.repository.js';
import { createLedgerService } from '../src/modules/ledger/ledger.service.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { initializeOutboxPersistence } from '../src/shared/communications/outbox.persistence.js';
import { createOutboxRepository } from '../src/shared/communications/outbox.repository.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import type {
  VenueOwnerDocument,
  VenueOwnerMembershipDocument,
} from '../src/modules/identity/owner/owner.types.js';
import type { KycVerificationDocument } from '../src/modules/identity/kyc/kyc.types.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { initializeInventoryPersistence } from '../src/modules/venue/inventory/inventory.persistence.js';
import type { VenueDocument } from '../src/modules/venue/profile/venue.types.js';
import type { VenuePayoutAccountDocument } from '../src/modules/venue/payout-accounts/payout-account.types.js';

test('Financial Close allocates one environment, reconciles mismatches, and completes in order', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_financial_close_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 4,
  });
  const clock = new Date('2026-08-08T12:00:00.000Z');

  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeInventoryPersistence(database.db);
    await initializeContractPersistence(database.db);
    await initializeLedgerPersistence(database.db);
    await initializeFinancialClosePersistence(database.db);
    await initializeOutboxPersistence(database.db);

    const partnerId = new ObjectId();
    const venueId = new ObjectId();
    const contractId = new ObjectId();
    const bookingId = new ObjectId();
    const adminId = new ObjectId();
    const ownerId = new ObjectId();
    const payoutAccountId = new ObjectId();
    const effectiveAt = new Date('2026-08-03T08:00:00.000Z');
    const contract: PartnerVenueContractDocument = {
      _id: contractId,
      partner_id: partnerId,
      venue_id: venueId,
      status: 'ACTIVE',
      settlement_cycle: 'WEEKLY',
      settlement_lag_days: 2,
      commission_rate_bps: 1_000,
      tax_rate_bps: 180,
      allowed_booking_modes: 'BOTH',
      cancellation_terms: {
        cancellation_allowed: true,
        default_refund_bps: 0,
        release_inventory: true,
      },
      resale_cutoff_minutes: 0,
      refund_rules: { rules: [] },
      terms_version: 1,
      effective_from: new Date('2026-08-01T00:00:00.000Z'),
      effective_to: null,
      audit_history: [],
      created_at: clock,
      updated_at: clock,
    };
    await database.db
      .collection<PartnerVenueContractDocument>('partner_venue_contracts')
      .insertOne(contract);
    await seedPayoutEligibility({
      database,
      ownerId,
      venueId,
      payoutAccountId,
      adminId,
      timestamp: clock,
    });

    const base = {
      booking_id: bookingId,
      partner_id: partnerId,
      venue_id: venueId,
      contract_id: contractId,
      settlement_id: null,
      payout_id: null,
      reverses_entry_id: null,
      environment: 'PRODUCTION' as const,
      currency: 'INR' as const,
      effective_at: effectiveAt,
      correlation_id: 'booking-confirm',
      created_at: effectiveAt,
    };
    const entries: LedgerEntryDocument[] = [
      {
        ...base,
        _id: new ObjectId(),
        entry_type: 'BOOKING',
        direction: 'DEBIT',
        amount_minor: 10_000,
        metadata: { component: 'GROSS' },
      },
      {
        ...base,
        _id: new ObjectId(),
        entry_type: 'COMMISSION',
        direction: 'CREDIT',
        amount_minor: 1_000,
        metadata: { component: 'COMMISSION' },
      },
      {
        ...base,
        _id: new ObjectId(),
        entry_type: 'TAX',
        direction: 'CREDIT',
        amount_minor: 180,
        metadata: { component: 'TAX' },
      },
      {
        ...base,
        _id: new ObjectId(),
        entry_type: 'BOOKING',
        direction: 'CREDIT',
        amount_minor: 8_820,
        metadata: { component: 'VENUE_NET' },
      },
    ];
    const sandboxEntry: LedgerEntryDocument = {
      ...entries[0]!,
      _id: new ObjectId(),
      environment: 'SANDBOX',
    };
    await database.db
      .collection<LedgerEntryDocument>('ledger_entries')
      .insertMany([...entries, sandboxEntry]);

    const service = createFinancialCloseService({
      repository: createFinancialCloseRepository(database),
      ledgerService: createLedgerService(createLedgerRepository(database)),
      outboxRepository: createOutboxRepository(database),
      ownerAccessService: {
        async requirePermission() {},
      } as unknown as OwnerAccessService,
      database,
      now: () => clock,
    });
    const generated = await service.generate({
      adminId: adminId.toHexString(),
      partnerId: partnerId.toHexString(),
      environment: 'PRODUCTION',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-08T00:00:00.000Z',
      correlationId: 'settlement-generate',
    });
    assert.equal(generated.status, 'DRAFT');
    assert.equal(generated.cycle, 'WEEKLY');
    assert.equal(generated.grossAmountMinor, 10_000);
    assert.equal(generated.commissionAmountMinor, 1_000);
    assert.equal(generated.taxAmountMinor, 180);
    assert.equal(generated.refundAmountMinor, 0);
    assert.equal(generated.netAmountMinor, 8_820);
    assert.equal(generated.dueAt, '2026-08-10T00:00:00.000Z');

    const settlementId = new ObjectId(generated.settlementId as string);
    assert.equal(
      await database.db
        .collection<LedgerEntryDocument>('ledger_entries')
        .countDocuments({
          _id: { $in: entries.map(({ _id }) => _id) },
          settlement_id: settlementId,
        }),
      4,
    );
    assert.equal(
      (
        await database.db
          .collection<LedgerEntryDocument>('ledger_entries')
          .findOne({ _id: sandboxEntry._id })
      )?.settlement_id,
      null,
    );
    await assert.rejects(
      service.generate({
        adminId: adminId.toHexString(),
        partnerId: partnerId.toHexString(),
        environment: 'PRODUCTION',
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-08-08T00:00:00.000Z',
        correlationId: 'settlement-retry',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'SETTLEMENT_ALREADY_EXISTS',
    );

    assert.equal(
      (
        await service.submit({
          adminId: adminId.toHexString(),
          settlementId: settlementId.toHexString(),
          correlationId: 'settlement-submit',
        })
      ).status,
      'PENDING_FUNDS',
    );
    const mismatch = await service.reconcile({
      adminId: adminId.toHexString(),
      settlementId: settlementId.toHexString(),
      reportedAmountMinor: 8_800,
      bankReference: 'BANK-001',
      notes: 'Partner reported a short remittance',
      correlationId: 'reconciliation-record',
    });
    assert.equal(mismatch.status, 'RECONCILING');
    assert.equal(
      (mismatch.reconciliation as Record<string, unknown>).status,
      'MISMATCH',
    );
    const resolved = await service.resolve({
      adminId: adminId.toHexString(),
      settlementId: settlementId.toHexString(),
      evidenceUri: 'https://evidence.example/short-remittance',
      notes: 'Authorized as a documented bank fee',
      correlationId: 'reconciliation-resolve',
    });
    assert.equal(resolved.status, 'RECONCILED');
    assert.equal(
      (resolved.reconciliation as Record<string, unknown>).status,
      'RESOLVED',
    );
    assert.equal(
      (
        (resolved.reconciliation as Record<string, unknown>)
          .attemptHistory as unknown[]
      ).length,
      2,
    );
    const completed = await service.complete({
      adminId: adminId.toHexString(),
      settlementId: settlementId.toHexString(),
      correlationId: 'settlement-complete',
    });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.completedAt, clock.toISOString());

    const storedSettlement = await database.db
      .collection<SettlementDocument>('settlements')
      .findOne({ _id: settlementId });
    const storedReconciliation = await database.db
      .collection<ReconciliationDocument>('reconciliations')
      .findOne({ settlement_id: settlementId });
    assert.equal(storedSettlement?.cycle, 'WEEKLY');
    assert.equal(
      Object.hasOwn(storedSettlement ?? {}, 'settlement_cycle'),
      false,
    );
    assert.deepEqual(
      storedSettlement?.audit_history.map(({ event_type }) => event_type),
      [
        'SETTLEMENT_DRAFT_CREATED',
        'SETTLEMENT_PENDING_FUNDS',
        'SETTLEMENT_RECONCILING',
        'SETTLEMENT_RECONCILED',
        'SETTLEMENT_COMPLETED',
      ],
    );
    assert.equal(storedReconciliation?.attempt_history.length, 2);

    const concurrentPayouts = await Promise.allSettled([
      service.initiatePayout({
        adminId: adminId.toHexString(),
        settlementId: settlementId.toHexString(),
        venueId: venueId.toHexString(),
        payoutAccountId: payoutAccountId.toHexString(),
        idempotencyKey: 'integration-payout-001',
        correlationId: 'payout-initiate-1',
      }),
      service.initiatePayout({
        adminId: adminId.toHexString(),
        settlementId: settlementId.toHexString(),
        venueId: venueId.toHexString(),
        payoutAccountId: payoutAccountId.toHexString(),
        idempotencyKey: 'integration-payout-002',
        correlationId: 'payout-initiate-2',
      }),
    ]);
    assert.equal(
      concurrentPayouts.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    assert.equal(
      concurrentPayouts.filter(({ status }) => status === 'rejected').length,
      1,
    );
    const payoutResult = concurrentPayouts.find(
      (result) => result.status === 'fulfilled',
    );
    assert.ok(payoutResult?.status === 'fulfilled');
    const payout = payoutResult.value;
    assert.equal(payout.status, 'PENDING');
    assert.equal(payout.amountMinor, 8_820);
    assert.equal(
      await database.db
        .collection<LedgerEntryDocument>('ledger_entries')
        .countDocuments({
          settlement_id: settlementId,
          payout_id: new ObjectId(payout.payoutId as string),
        }),
      4,
    );
    const paid = await service.recordPayoutResult({
      adminId: adminId.toHexString(),
      payoutId: payout.payoutId as string,
      status: 'PAID',
      bankReference: 'INTEGRATION-BANK-PAYOUT-001',
      correlationId: 'payout-paid',
    });
    assert.equal(paid.status, 'PAID');
    assert.equal(
      await database.db.collection('outbox_events').countDocuments({
        aggregate_id: new ObjectId(payout.payoutId as string),
      }),
      2,
    );
  } finally {
    if (databaseName.startsWith('turf_gds_financial_close_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

test('Financial Close startup safely migrates legacy fields and obsolete indexes', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_financial_close_migration_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 2,
  });
  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }
    const now = new Date('2026-08-08T12:00:00.000Z');
    const settlementId = new ObjectId();
    await database.db.createCollection('settlements');
    await database.db.collection('settlements').insertOne({
      _id: settlementId,
      partner_id: new ObjectId(),
      environment: 'PRODUCTION',
      period_start: new Date('2026-08-01T00:00:00.000Z'),
      period_end: new Date('2026-08-08T00:00:00.000Z'),
      settlement_cycle: 'WEEKLY',
      due_at: new Date('2026-08-10T00:00:00.000Z'),
      status: 'DRAFT',
      gross_amount_minor: 10_000,
      commission_amount_minor: 1_000,
      tax_amount_minor: 180,
      refund_amount_minor: 0,
      net_amount_minor: 8_820,
      currency: 'INR',
      audit_history: [],
      completed_at: null,
      created_at: now,
    });
    await database.db.createCollection('invoices');
    await database.db.collection('invoices').insertOne({
      _id: new ObjectId(),
      settlement_id: settlementId,
      environment: 'PRODUCTION',
      invoice_number: 'LEGACY-001',
      type: 'TAX_INVOICE',
      subtotal_amount_minor: 1_000,
      tax_amount_minor: 180,
      total_amount_minor: 1_180,
      currency: 'INR',
      status: 'DRAFT',
      document_uri: null,
      issued_at: null,
      created_at: now,
    });
    await database.db.createCollection('reconciliations');
    await database.db.collection('reconciliations').createIndex(
      { settlement_id: 1 },
      { unique: true, name: 'uq_reconciliation_settlement' },
    );
    await database.db.createCollection('outbox_events');
    await database.db.collection('outbox_events').createIndex(
      { aggregate_type: 1, aggregate_id: 1, event_version: 1 },
      { unique: true, name: 'uq_outbox_aggregate_version' },
    );

    await initializeFinancialClosePersistence(database.db);
    await initializeOutboxPersistence(database.db);

    const migratedSettlement = await database.db
      .collection('settlements')
      .findOne({ _id: settlementId });
    assert.equal(migratedSettlement?.cycle, 'WEEKLY');
    assert.equal(Object.hasOwn(migratedSettlement ?? {}, 'settlement_cycle'), false);
    const migratedInvoice = await database.db
      .collection('invoices')
      .findOne({ invoice_number: 'LEGACY-001' });
    assert.equal(migratedInvoice?.subtotal_minor, 1_000);
    assert.equal(migratedInvoice?.total_minor, 1_180);
    assert.equal(
      Object.hasOwn(migratedInvoice ?? {}, 'subtotal_amount_minor'),
      false,
    );
    const reconciliationIndexes = await database.db
      .collection('reconciliations')
      .indexes();
    assert.equal(
      reconciliationIndexes.some(({ name }) => name === 'uq_reconciliation_settlement'),
      false,
    );
    assert.ok(
      reconciliationIndexes.some(
        ({ name }) => name === 'uq_reconciliation_bank_reference',
      ),
    );
    const outboxIndexes = await database.db.collection('outbox_events').indexes();
    assert.equal(
      outboxIndexes.some(({ name }) => name === 'uq_outbox_aggregate_version'),
      false,
    );
    assert.ok(
      outboxIndexes.some(({ name }) => name === 'uq_outbox_event_identity'),
    );
  } finally {
    if (databaseName.startsWith('turf_gds_financial_close_migration_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});

async function seedPayoutEligibility(input: {
  database: MongoDatabaseConnection;
  ownerId: ObjectId;
  venueId: ObjectId;
  payoutAccountId: ObjectId;
  adminId: ObjectId;
  timestamp: Date;
}): Promise<void> {
  const owner: VenueOwnerDocument = {
    _id: input.ownerId,
    legal_name: 'Financial Close Venue Owner',
    email: `financial-close-${input.ownerId.toHexString()}@example.test`,
    phone_e164: '+919999999999',
    password_hash: 'not-used',
    email_verified_at: input.timestamp,
    kyc_status: 'VERIFIED',
    status: 'ACTIVE',
    approved_by: input.adminId,
    approved_at: input.timestamp,
    last_login_at: null,
    failed_login_count: 0,
    locked_until: null,
    sessions: [],
    fcm_tokens: [],
    notifications: [],
    audit_history: [],
    created_at: input.timestamp,
    updated_at: input.timestamp,
  };
  const venue: VenueDocument = {
    _id: input.venueId,
    legal_name: 'Financial Close Venue Pvt Ltd',
    display_name: 'Financial Close Venue',
    timezone: 'Asia/Kolkata',
    address: {
      line1: '1 Finance Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560001',
      country: 'IN',
    },
    geo: { type: 'Point', coordinates: [77.59, 12.97] },
    currency: 'INR',
    environment: 'PRODUCTION',
    status: 'ACTIVE',
    media: [],
    audit_history: [],
    version: 1,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  };
  const membership: VenueOwnerMembershipDocument = {
    _id: new ObjectId(),
    owner_id: input.ownerId,
    venue_id: input.venueId,
    role: 'OWNER',
    status: 'ACTIVE',
    created_at: input.timestamp,
  };
  const kyc: KycVerificationDocument = {
    _id: new ObjectId(),
    subject_type: 'VENUE_OWNER',
    subject_id: input.ownerId,
    verification_type: 'BUSINESS',
    status: 'VERIFIED',
    is_current: true,
    reviewed_by: input.adminId,
    reviewed_at: input.timestamp,
    rejection_reason: null,
    expires_at: new Date('2027-08-12T00:00:00.000Z'),
    audit_history: [],
    created_at: input.timestamp,
  };
  const account: VenuePayoutAccountDocument = {
    _id: input.payoutAccountId,
    venue_id: input.venueId,
    account_holder_name: 'Financial Close Venue Pvt Ltd',
    vault_provider: 'integration-vault',
    vault_account_token: `tok_${input.payoutAccountId.toHexString()}`,
    account_last4: '6789',
    bank_name: 'Integration Bank',
    ifsc_code: 'ABCD0123456',
    status: 'VERIFIED',
    verified_by: input.adminId,
    verified_at: input.timestamp,
    verification_failure_reason: null,
    verification_method: 'MANUAL',
    audit_history: [],
    created_at: input.timestamp,
    updated_at: input.timestamp,
  };
  await input.database.db
    .collection<VenueOwnerDocument>('venue_owners')
    .insertOne(owner);
  await input.database.db.collection<VenueDocument>('venues').insertOne(venue);
  await input.database.db
    .collection<VenueOwnerMembershipDocument>('venue_owner_memberships')
    .insertOne(membership);
  await input.database.db
    .collection<KycVerificationDocument>('kyc_verifications')
    .insertOne(kyc);
  await input.database.db
    .collection<VenuePayoutAccountDocument>('venue_payout_accounts')
    .insertOne(account);
}
