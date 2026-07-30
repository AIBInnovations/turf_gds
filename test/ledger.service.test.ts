import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, type ClientSession } from 'mongodb';

import type { LedgerRepository } from '../src/modules/ledger/ledger.repository.js';
import {
  createLedgerService,
  validateLedgerJournal,
} from '../src/modules/ledger/ledger.service.js';
import type {
  LedgerBookingSnapshot,
  LedgerEntryDocument,
} from '../src/modules/ledger/ledger.types.js';
import { AppError } from '../src/shared/errors/app-error.js';

const session = {} as ClientSession;
const timestamp = new Date('2026-08-12T10:00:00.000Z');
const booking: LedgerBookingSnapshot = {
  bookingId: new ObjectId(),
  partnerId: new ObjectId(),
  venueId: new ObjectId(),
  contractId: new ObjectId(),
  environment: 'PRODUCTION',
  grossAmountMinor: 2,
  commissionAmountMinor: 0,
  taxAmountMinor: 1,
  venueNetAmountMinor: 1,
};

function fixture() {
  const entries: LedgerEntryDocument[] = [];
  const repository = {
    async post(values: LedgerEntryDocument[]) {
      entries.push(...values);
    },
    async listForBooking() {
      return entries;
    },
  } as unknown as LedgerRepository;
  return {
    entries,
    repository,
    service: createLedgerService(repository),
  };
}

test('Ledger posts a balanced booking journal and exposes no arbitrary mutation', async () => {
  const value = fixture();
  const posted = await value.service.postBooking({
    booking,
    effectiveAt: timestamp,
    correlationId: 'booking-confirmed',
    session,
  });
  assert.equal(posted.length, 4);
  assertBalanced(posted);
  assert.equal('update' in value.repository, false);
  assert.equal('delete' in value.repository, false);
});

test('partial-refund allocation preserves balance across rounding boundaries', async () => {
  const value = fixture();
  await value.service.postBooking({
    booking,
    effectiveAt: timestamp,
    correlationId: 'booking-confirmed',
    session,
  });
  const reversals = await value.service.postCancellation({
    booking,
    refundPercent: 25,
    effectiveAt: new Date('2026-08-13T10:00:00.000Z'),
    correlationId: 'booking-cancelled',
    session,
  });
  assertBalanced(reversals);
  assert.equal(
    reversals
      .filter(({ direction }) => direction === 'CREDIT')
      .reduce((sum, { amount_minor }) => sum + amount_minor, 0),
    1,
  );
  await assert.rejects(
    value.service.postCancellation({
      booking,
      refundPercent: 25,
      effectiveAt: new Date('2026-08-14T10:00:00.000Z'),
      correlationId: 'duplicate-cancellation',
      session,
    }),
    hasCode('LEDGER_ENTRY_ALREADY_REVERSED'),
  );
});

test('Ledger rejects unbalanced journals and undocumented adjustments', async () => {
  const value = fixture();
  const common = {
    booking: {
      bookingId: booking.bookingId,
      partnerId: booking.partnerId,
      venueId: booking.venueId,
      contractId: booking.contractId,
      environment: booking.environment,
    },
    lines: [
      { direction: 'DEBIT' as const, amountMinor: 100, component: 'GROSS' },
      {
        direction: 'CREDIT' as const,
        amountMinor: 100,
        component: 'VENUE_NET',
      },
    ],
    actorId: new ObjectId(),
    effectiveAt: timestamp,
    correlationId: 'adjustment',
  };
  await assert.rejects(
    value.service.postAdjustment({
      ...common,
      reason: 'Correction',
      evidenceUri: '',
      session,
    }),
    hasCode('FIELD_REQUIRED'),
  );
  const posted = await value.service.postAdjustment({
    ...common,
    reason: 'Correction',
    evidenceUri: 'https://evidence.example/adjustment',
    session,
  });
  assertBalanced(posted);
  assert.throws(
    () => validateLedgerJournal([{ ...posted[0]!, amount_minor: 99 }, posted[1]!]),
    hasCode('LEDGER_JOURNAL_UNBALANCED'),
  );
});

function assertBalanced(entries: LedgerEntryDocument[]): void {
  const total = (direction: 'DEBIT' | 'CREDIT') =>
    entries
      .filter((value) => value.direction === direction)
      .reduce((sum, value) => sum + value.amount_minor, 0);
  assert.equal(total('DEBIT'), total('CREDIT'));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}
