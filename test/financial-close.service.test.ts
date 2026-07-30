import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, type ClientSession } from 'mongodb';

import type { PartnerVenueContractDocument } from '../src/modules/contracts/contract.types.js';
import type { FinancialCloseRepository } from '../src/modules/financial-close/financial-close.repository.js';
import { createFinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type {
  ReconciliationDocument,
  SettlementDocument,
} from '../src/modules/financial-close/financial-close.types.js';
import type {
  LedgerEntryDocument,
} from '../src/modules/ledger/ledger.repository.js';
import type { LedgerService } from '../src/modules/ledger/ledger.service.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import type { OutboxRepository } from '../src/shared/communications/outbox.repository.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('Financial Close derives totals and enforces the reconciliation state machine', async () => {
  const now = new Date('2026-08-08T12:00:00.000Z');
  const adminId = new ObjectId();
  const partnerId = new ObjectId();
  const venueId = new ObjectId();
  const bookingId = new ObjectId();
  const contractId = new ObjectId();
  const session = {} as ClientSession;
  let settlement: SettlementDocument | null = null;
  let reconciliation: ReconciliationDocument | null = null;
  let allocation: ObjectId[] = [];
  let unsettledQuery: Record<string, unknown> | undefined;

  const contract = {
    _id: contractId,
    partner_id: partnerId,
    venue_id: venueId,
    settlement_cycle: 'WEEKLY',
    settlement_lag_days: 2,
  } as PartnerVenueContractDocument;
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
    effective_at: new Date('2026-08-03T08:00:00.000Z'),
    correlation_id: 'confirm',
    created_at: new Date('2026-08-03T08:00:00.000Z'),
  };
  const confirmations: LedgerEntryDocument[] = [
    ledger(base, 'BOOKING', 'DEBIT', 10_000, 'GROSS'),
    ledger(base, 'COMMISSION', 'CREDIT', 1_000, 'COMMISSION'),
    ledger(base, 'TAX', 'CREDIT', 180, 'TAX'),
    ledger(base, 'BOOKING', 'CREDIT', 8_820, 'VENUE_NET'),
  ];
  const entries: LedgerEntryDocument[] = [
    ...confirmations,
    ...confirmations.map((original) => ({
      ...base,
      _id: new ObjectId(),
      reverses_entry_id: original._id,
      entry_type: 'REVERSAL' as const,
      direction:
        original.direction === 'DEBIT'
          ? 'CREDIT' as const
          : 'DEBIT' as const,
      amount_minor: Math.round(original.amount_minor / 2),
      metadata: {
        original_component: original.metadata?.component,
      },
    })),
    ledger(base, 'ADJUSTMENT', 'DEBIT', 100, 'GROSS'),
    ledger(base, 'ADJUSTMENT', 'CREDIT', 100, 'VENUE_NET'),
  ];

  const repository = {
    async findContracts() {
      return [contract];
    },
    async insertSettlement(
      value: Parameters<FinancialCloseRepository['insertSettlement']>[0],
    ) {
      settlement = value;
    },
    async findSettlementPeriod() {
      return settlement;
    },
    async findSettlement() {
      return settlement;
    },
    async transitionSettlement(
      input: Parameters<FinancialCloseRepository['transitionSettlement']>[0],
    ) {
      if (!settlement || settlement.status !== input.from) return null;
      settlement = {
        ...settlement,
        status: input.to,
        completed_at:
          input.completedAt === undefined
            ? settlement.completed_at
            : input.completedAt,
      };
      return settlement;
    },
    async insertReconciliation(
      value: Parameters<FinancialCloseRepository['insertReconciliation']>[0],
    ) {
      reconciliation = value;
    },
    async findReconciliation() {
      return reconciliation;
    },
    async resolveReconciliation(
      input: Parameters<FinancialCloseRepository['resolveReconciliation']>[0],
    ) {
      if (!reconciliation || reconciliation.status !== 'MISMATCH') return null;
      reconciliation = {
        ...reconciliation,
        status: 'RESOLVED',
        reconciled_by: input.adminId,
        reconciled_at: input.now,
        evidence_uri: input.evidenceUri,
        notes: input.notes,
        attempt_history: [...reconciliation.attempt_history, input.attempt],
      };
      return reconciliation;
    },
  } as unknown as FinancialCloseRepository;
  const ledgerService = {
    async listUnsettled(
      input: Parameters<LedgerService['listUnsettled']>[0],
    ) {
      unsettledQuery = input;
      return entries;
    },
    async allocateToSettlement(
      input: Parameters<LedgerService['allocateToSettlement']>[0],
    ) {
      allocation = input.entryIds;
      return true;
    },
    async findByIds() {
      return [];
    },
  } as unknown as LedgerService;
  const database = {
    async withTransaction<T>(
      operation: Parameters<DatabaseConnection['withTransaction']>[0],
    ): Promise<T> {
      return operation({ db: undefined as never, session }) as Promise<T>;
    },
  } as unknown as DatabaseConnection;
  const service = createFinancialCloseService({
    repository,
    ledgerService,
    outboxRepository: {
      async enqueue() {},
    } as OutboxRepository,
    ownerAccessService: {
      async requirePermission() {},
    } as unknown as OwnerAccessService,
    database,
    now: () => now,
  });

  const generated = await service.generate({
    adminId: adminId.toHexString(),
    partnerId: partnerId.toHexString(),
    environment: 'PRODUCTION',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-08-08T00:00:00.000Z',
    correlationId: 'generate',
  });
  assert.equal(generated.status, 'DRAFT');
  assert.equal(generated.grossAmountMinor, 10_100);
  assert.equal(generated.commissionAmountMinor, 500);
  assert.equal(generated.taxAmountMinor, 90);
  assert.equal(generated.refundAmountMinor, 5_000);
  assert.equal(generated.netAmountMinor, 4_510);
  assert.equal(generated.dueAt, '2026-08-10T00:00:00.000Z');
  assert.equal(allocation.length, 10);
  assert.equal(unsettledQuery?.environment, 'PRODUCTION');

  const settlementId = generated.settlementId as string;
  await assert.rejects(
    service.generate({
      adminId: adminId.toHexString(),
      partnerId: partnerId.toHexString(),
      environment: 'PRODUCTION',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-08T00:00:00.000Z',
      correlationId: 'retry',
    }),
    hasCode('SETTLEMENT_ALREADY_EXISTS'),
  );
  assert.equal(
    (
      await service.submit({
        adminId: adminId.toHexString(),
        settlementId,
        correlationId: 'submit',
      })
    ).status,
    'PENDING_FUNDS',
  );
  await assert.rejects(
    service.reconcile({
      adminId: adminId.toHexString(),
      settlementId,
      reportedAmountMinor: 4_400,
      bankReference: 'BANK-MISSING-NOTES',
      correlationId: 'missing-notes',
    }),
    hasCode('RECONCILIATION_NOTES_REQUIRED'),
  );
  const mismatched = await service.reconcile({
    adminId: adminId.toHexString(),
    settlementId,
    reportedAmountMinor: 4_400,
    bankReference: 'BANK-001',
    notes: 'Short remittance',
    correlationId: 'mismatch',
  });
  assert.equal(mismatched.status, 'RECONCILING');
  assert.equal(
    (mismatched.reconciliation as Record<string, unknown>).status,
    'MISMATCH',
  );
  const resolved = await service.resolve({
    adminId: adminId.toHexString(),
    settlementId,
    evidenceUri: 'https://example.test/evidence',
    notes: 'Approved bank fee',
    correlationId: 'resolve',
  });
  assert.equal(resolved.status, 'RECONCILED');
  assert.equal(
    (
      (resolved.reconciliation as Record<string, unknown>)
        .attemptHistory as unknown[]
    ).length,
    2,
  );
  const completed = await service.complete({
    adminId: adminId.toHexString(),
    settlementId,
    correlationId: 'complete',
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.completedAt, now.toISOString());
});

function ledger(
  base: Omit<
    LedgerEntryDocument,
    '_id' | 'entry_type' | 'direction' | 'amount_minor' | 'metadata'
  >,
  entryType: LedgerEntryDocument['entry_type'],
  direction: LedgerEntryDocument['direction'],
  amount: number,
  component: string,
): LedgerEntryDocument {
  return {
    ...base,
    _id: new ObjectId(),
    entry_type: entryType,
    direction,
    amount_minor: amount,
    metadata: { component },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}
