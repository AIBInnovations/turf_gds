import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, type ClientSession } from 'mongodb';

import type { FinancialCloseRepository } from '../src/modules/financial-close/financial-close.repository.js';
import { createFinancialCloseService } from '../src/modules/financial-close/financial-close.service.js';
import type {
  PayoutDocument,
  SettlementDocument,
} from '../src/modules/financial-close/financial-close.types.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type {
  LedgerEntryDocument,
} from '../src/modules/ledger/ledger.repository.js';
import type { LedgerService } from '../src/modules/ledger/ledger.service.js';
import type { OutboxRepository } from '../src/shared/communications/outbox.repository.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('payout gates, allocation, manual result, and owner isolation are enforced', async () => {
  const timestamp = new Date('2026-08-12T10:00:00.000Z');
  const adminId = new ObjectId();
  const partnerId = new ObjectId();
  const ownerId = new ObjectId();
  const venueId = new ObjectId();
  const otherVenueId = new ObjectId();
  const settlementId = new ObjectId();
  const accountId = new ObjectId();
  const bookingId = new ObjectId();
  const contractId = new ObjectId();
  const session = {} as ClientSession;
  const events: string[] = [];
  let allocated = false;
  let payout: PayoutDocument | null = null;
  let kycStatus: 'VERIFIED' | 'EXPIRED' = 'VERIFIED';

  const settlement: SettlementDocument = {
    _id: settlementId,
    partner_id: partnerId,
    environment: 'PRODUCTION',
    period_start: new Date('2026-08-01T00:00:00.000Z'),
    period_end: new Date('2026-08-08T00:00:00.000Z'),
    cycle: 'WEEKLY',
    due_at: new Date('2026-08-10T00:00:00.000Z'),
    status: 'COMPLETED',
    gross_amount_minor: 10_000,
    commission_amount_minor: 1_000,
    tax_amount_minor: 180,
    refund_amount_minor: 0,
    net_amount_minor: 8_820,
    currency: 'INR',
    audit_history: [],
    created_at: timestamp,
    completed_at: timestamp,
  };
  const entries = makeEntries({
    bookingId,
    partnerId,
    venueId,
    contractId,
    settlementId,
    timestamp,
  });

  const repository = {
    async findPayoutByIdempotency(key: string) {
      return payout?.idempotency_key === key ? payout : null;
    },
    async findPayoutForSettlementVenue() {
      return payout;
    },
    async findSettlement() {
      return settlement;
    },
    async findVenue() {
      return {
        _id: venueId,
        status: 'ACTIVE',
        environment: 'PRODUCTION',
      };
    },
    async findCanonicalOwner() {
      return {
        _id: new ObjectId(),
        owner_id: ownerId,
        venue_id: venueId,
        role: 'OWNER',
        status: 'ACTIVE',
        created_at: timestamp,
      };
    },
    async findCurrentBusinessKyc() {
      return {
        _id: new ObjectId(),
        status: kycStatus,
        expires_at:
          kycStatus === 'VERIFIED'
            ? new Date('2027-08-12T00:00:00.000Z')
            : new Date('2026-08-11T00:00:00.000Z'),
      };
    },
    async findPayoutAccount(
      id: ObjectId,
      requestedVenueId: ObjectId,
    ) {
      if (!id.equals(accountId) || !requestedVenueId.equals(venueId)) {
        return null;
      }
      return {
        _id: accountId,
        venue_id: venueId,
        status: 'VERIFIED',
        account_holder_name: 'Turf Owner',
        account_last4: '6789',
        bank_name: 'Example Bank',
      };
    },
    async insertPayout(value: PayoutDocument) {
      payout = value;
    },
    async recordPayoutResult(
      values: Parameters<
        FinancialCloseRepository['recordPayoutResult']
      >[0],
    ) {
      if (!payout || payout.status !== 'PENDING') return null;
      payout = {
        ...payout,
        status: values.status,
        bank_reference: values.bankReference,
        failure_reason: values.failureReason,
        paid_at: values.status === 'PAID' ? values.now : null,
        updated_at: values.now,
      };
      return payout;
    },
    async findPayout(
      _id: ObjectId,
      requestedVenueId?: ObjectId,
    ) {
      return payout &&
        (!requestedVenueId || payout.venue_id.equals(requestedVenueId))
        ? payout
        : null;
    },
    async listPayouts(values: { venueId?: ObjectId }) {
      const items =
        payout && (!values.venueId || payout.venue_id.equals(values.venueId))
          ? [payout]
          : [];
      return { items, total: items.length };
    },
    async listSettlements() {
      return { items: [settlement], total: 1 };
    },
    async findBookings() {
      return [];
    },
  } as unknown as FinancialCloseRepository;
  const ledgerService = {
    async listForSettlementVenue() {
      return entries;
    },
    async findByIds() {
      return [];
    },
    async allocateToPayout() {
      allocated = true;
      return true;
    },
    async listSettlementIdsForVenue() {
      return [settlementId];
    },
  } as unknown as LedgerService;
  const ownerAccessService = {
    async requirePermission(actorOwnerId: string, requestedVenueId: string) {
      if (
        actorOwnerId !== ownerId.toHexString() ||
        requestedVenueId !== venueId.toHexString()
      ) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Denied',
          statusCode: 403,
        });
      }
    },
  } as unknown as OwnerAccessService;
  const service = createFinancialCloseService({
    repository,
    ledgerService,
    outboxRepository: {
      async enqueue(values) {
        events.push(values.eventType);
      },
    } as OutboxRepository,
    ownerAccessService,
    database: {
      async withTransaction<T>(operation: (
        context: { db: never; session: ClientSession },
      ) => Promise<T>) {
        return operation({ db: undefined as never, session });
      },
    } as unknown as DatabaseConnection,
    now: () => timestamp,
  });

  kycStatus = 'EXPIRED';
  await assert.rejects(
    service.initiatePayout({
      adminId: adminId.toHexString(),
      settlementId: settlementId.toHexString(),
      venueId: venueId.toHexString(),
      payoutAccountId: accountId.toHexString(),
      idempotencyKey: 'payout-001',
      correlationId: 'expired-kyc',
    }),
    hasCode('PAYOUT_KYC_NOT_VERIFIED'),
  );

  kycStatus = 'VERIFIED';
  const initiated = await service.initiatePayout({
    adminId: adminId.toHexString(),
    settlementId: settlementId.toHexString(),
    venueId: venueId.toHexString(),
    payoutAccountId: accountId.toHexString(),
    idempotencyKey: 'payout-001',
    correlationId: 'payout-create',
  });
  assert.equal(initiated.status, 'PENDING');
  assert.equal(initiated.amountMinor, 8_820);
  assert.equal(allocated, true);
  assert.deepEqual(events, ['PAYOUT_PENDING']);

  const replay = await service.initiatePayout({
    adminId: adminId.toHexString(),
    settlementId: settlementId.toHexString(),
    venueId: venueId.toHexString(),
    payoutAccountId: accountId.toHexString(),
    idempotencyKey: 'payout-001',
    correlationId: 'payout-replay',
  });
  assert.equal(replay.payoutId, initiated.payoutId);

  const paid = await service.recordPayoutResult({
    adminId: adminId.toHexString(),
    payoutId: initiated.payoutId as string,
    status: 'PAID',
    bankReference: 'BANK-PAYOUT-001',
    correlationId: 'payout-paid',
  });
  assert.equal(paid.status, 'PAID');
  assert.deepEqual(events, ['PAYOUT_PENDING', 'PAYOUT_PAID']);

  const ownerView = await service.getOwnerPayout({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    payoutId: initiated.payoutId as string,
  });
  assert.deepEqual(ownerView.payoutAccount, {
    id: accountId.toHexString(),
    accountHolderName: 'Turf Owner',
    accountLast4: '6789',
    bankName: 'Example Bank',
  });
  assert.equal(
    JSON.stringify(ownerView).includes('vault_account_token'),
    false,
  );
  await assert.rejects(
    service.listOwnerPayouts({
      actorOwnerId: ownerId.toHexString(),
      venueId: otherVenueId.toHexString(),
    }),
    hasCode('PERMISSION_DENIED'),
  );
});

function makeEntries(input: {
  bookingId: ObjectId;
  partnerId: ObjectId;
  venueId: ObjectId;
  contractId: ObjectId;
  settlementId: ObjectId;
  timestamp: Date;
}): LedgerEntryDocument[] {
  const base = {
    booking_id: input.bookingId,
    partner_id: input.partnerId,
    venue_id: input.venueId,
    contract_id: input.contractId,
    settlement_id: input.settlementId,
    payout_id: null,
    reverses_entry_id: null,
    environment: 'PRODUCTION' as const,
    currency: 'INR' as const,
    effective_at: input.timestamp,
    correlation_id: 'booking-confirm',
    created_at: input.timestamp,
  };
  return [
    entry(base, 'BOOKING', 'DEBIT', 10_000, 'GROSS'),
    entry(base, 'COMMISSION', 'CREDIT', 1_000, 'COMMISSION'),
    entry(base, 'TAX', 'CREDIT', 180, 'TAX'),
    entry(base, 'BOOKING', 'CREDIT', 8_820, 'VENUE_NET'),
  ];
}

function entry(
  base: Omit<
    LedgerEntryDocument,
    '_id' | 'entry_type' | 'direction' | 'amount_minor' | 'metadata'
  >,
  entryType: LedgerEntryDocument['entry_type'],
  direction: LedgerEntryDocument['direction'],
  amountMinor: number,
  component: string,
): LedgerEntryDocument {
  return {
    ...base,
    _id: new ObjectId(),
    entry_type: entryType,
    direction,
    amount_minor: amountMinor,
    metadata: { component },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}
