import { ObjectId, type ClientSession } from 'mongodb';

import { AppError } from '../../shared/errors/app-error.js';
import type { LedgerRepository } from './ledger.repository.js';
import type {
  LedgerBookingSnapshot,
  LedgerDirection,
  LedgerEntryDocument,
  LedgerEnvironment,
  LedgerEntryType,
} from './ledger.types.js';

export interface LedgerService {
  postBooking(input: {
    booking: LedgerBookingSnapshot;
    effectiveAt: Date;
    correlationId: string;
    session: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  postCancellation(input: {
    booking: LedgerBookingSnapshot;
    refundPercent: number;
    effectiveAt: Date;
    correlationId: string;
    session: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  postAdjustment(input: {
    booking: Omit<
      LedgerBookingSnapshot,
      | 'grossAmountMinor'
      | 'commissionAmountMinor'
      | 'taxAmountMinor'
      | 'venueNetAmountMinor'
    >;
    lines: Array<{
      direction: LedgerDirection;
      amountMinor: number;
      component: string;
    }>;
    reason: string;
    evidenceUri: string;
    actorId: ObjectId;
    effectiveAt: Date;
    correlationId: string;
    session: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  listForBooking(
    bookingId: ObjectId,
    session: ClientSession,
  ): Promise<LedgerEntryDocument[]>;
  listUnsettled(input: {
    partnerId: ObjectId;
    environment: LedgerEnvironment;
    periodStart: Date;
    periodEnd: Date;
    session: ClientSession;
  }): Promise<LedgerEntryDocument[]>;
  allocateToSettlement(
    input: Parameters<LedgerRepository['allocateToSettlement']>[0],
  ): Promise<boolean>;
  findByIds(
    ids: ObjectId[],
    session?: ClientSession,
  ): Promise<LedgerEntryDocument[]>;
  listForSettlementVenue(
    input: Parameters<LedgerRepository['listForSettlementVenue']>[0],
  ): Promise<LedgerEntryDocument[]>;
  allocateToPayout(
    input: Parameters<LedgerRepository['allocateToPayout']>[0],
  ): Promise<boolean>;
  listSettlementIdsForVenue(
    input: Parameters<LedgerRepository['listSettlementIdsForVenue']>[0],
  ): Promise<ObjectId[]>;
}

export function createLedgerService(
  repository: LedgerRepository,
): LedgerService {
  return {
    async postBooking(input) {
      const { booking } = input;
      assertBookingAmounts(booking);
      const entries = [
        entry(input, 'BOOKING', 'DEBIT', booking.grossAmountMinor, 'GROSS'),
        entry(
          input,
          'COMMISSION',
          'CREDIT',
          booking.commissionAmountMinor,
          'COMMISSION',
        ),
        entry(input, 'TAX', 'CREDIT', booking.taxAmountMinor, 'TAX'),
        entry(
          input,
          'BOOKING',
          'CREDIT',
          booking.venueNetAmountMinor,
          'VENUE_NET',
        ),
      ];
      validateLedgerJournal(entries);
      await repository.post(entries, input.session);
      return entries;
    },

    async postCancellation(input) {
      if (
        !Number.isInteger(input.refundPercent) ||
        input.refundPercent < 0 ||
        input.refundPercent > 100
      ) {
        throw invalid(
          'INVALID_REFUND_PERCENT',
          'refundPercent must be an integer from 0 to 100',
        );
      }
      if (input.refundPercent === 0) return [];
      const all = await repository.listForBooking(
        input.booking.bookingId,
        input.session,
      );
      const alreadyReversed = new Set(
        all
          .map(({ reverses_entry_id }) => reverses_entry_id)
          .filter((id): id is ObjectId => id !== null)
          .map((id) => id.toHexString()),
      );
      const originals = all.filter(
        (value) =>
          value.reverses_entry_id === null &&
          ['BOOKING', 'COMMISSION', 'TAX'].includes(value.entry_type) &&
          ['GROSS', 'COMMISSION', 'TAX', 'VENUE_NET'].includes(
            String(value.metadata?.component ?? ''),
          ),
      );
      if (originals.length === 0) {
        throw conflict(
          'LEDGER_ORIGINALS_NOT_FOUND',
          'Booking confirmation Ledger entries were not found',
        );
      }
      assertScope(input.booking, originals);
      if (
        originals.some(({ _id }) => alreadyReversed.has(_id.toHexString()))
      ) {
        throw conflict(
          'LEDGER_ENTRY_ALREADY_REVERSED',
          'A booking Ledger entry has already been reversed',
        );
      }
      const amounts = scaledBalancedAmounts(originals, input.refundPercent);
      const entries = originals
        .map((original, index): LedgerEntryDocument | null => {
          const amount = amounts[index]!;
          if (amount === 0) return null;
          return {
            _id: new ObjectId(),
            booking_id: original.booking_id,
            partner_id: original.partner_id,
            venue_id: original.venue_id,
            contract_id: original.contract_id,
            settlement_id: null,
            payout_id: null,
            reverses_entry_id: original._id,
            environment: original.environment,
            entry_type: 'REVERSAL',
            direction:
              original.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
            amount_minor: amount,
            currency: original.currency,
            effective_at: input.effectiveAt,
            correlation_id: required(input.correlationId, 'correlationId'),
            metadata: {
              refund_percent: input.refundPercent,
              original_entry_type: original.entry_type,
              original_component: original.metadata?.component ?? null,
            },
            created_at: input.effectiveAt,
          };
        })
        .filter((value): value is LedgerEntryDocument => value !== null);
      if (entries.length === 0) return [];
      validateLedgerJournal(entries);
      validateReversals(entries, originals);
      await repository.post(entries, input.session);
      return entries;
    },

    async postAdjustment(input) {
      const reason = required(input.reason, 'reason');
      const evidenceUri = required(input.evidenceUri, 'evidenceUri');
      if (
        input.lines.some(
          ({ component }) =>
            !['GROSS', 'COMMISSION', 'TAX', 'VENUE_NET'].includes(component),
        )
      ) {
        throw invalid(
          'INVALID_ADJUSTMENT_COMPONENT',
          'Adjustment components must be GROSS, COMMISSION, TAX, or VENUE_NET',
        );
      }
      const entries = input.lines.map(
        (line): LedgerEntryDocument => ({
          _id: new ObjectId(),
          booking_id: input.booking.bookingId,
          partner_id: input.booking.partnerId,
          venue_id: input.booking.venueId,
          contract_id: input.booking.contractId,
          settlement_id: null,
          payout_id: null,
          reverses_entry_id: null,
          environment: input.booking.environment,
          entry_type: 'ADJUSTMENT',
          direction: line.direction,
          amount_minor: line.amountMinor,
          currency: 'INR',
          effective_at: input.effectiveAt,
          correlation_id: required(input.correlationId, 'correlationId'),
          metadata: {
            component: required(line.component, 'component'),
            reason,
            evidence_uri: evidenceUri,
            actor_id: input.actorId.toHexString(),
          },
          created_at: input.effectiveAt,
        }),
      );
      validateLedgerJournal(entries);
      await repository.post(entries, input.session);
      return entries;
    },

    listForBooking: (bookingId, session) =>
      repository.listForBooking(bookingId, session),
    listUnsettled: (input) => repository.listUnsettled(input),
    allocateToSettlement: (input) => repository.allocateToSettlement(input),
    findByIds: (ids, session) => repository.findByIds(ids, session),
    listForSettlementVenue: (input) =>
      repository.listForSettlementVenue(input),
    allocateToPayout: (input) => repository.allocateToPayout(input),
    listSettlementIdsForVenue: (input) =>
      repository.listSettlementIdsForVenue(input),
  };
}

export function validateLedgerJournal(entries: LedgerEntryDocument[]): void {
  if (entries.length < 2) {
    throw invalid(
      'LEDGER_JOURNAL_INCOMPLETE',
      'A Ledger journal requires at least two entries',
    );
  }
  const first = entries[0]!;
  let debit = 0;
  let credit = 0;
  for (const value of entries) {
    if (
      !Number.isSafeInteger(value.amount_minor) ||
      value.amount_minor < 0
    ) {
      throw invalid(
        'INVALID_LEDGER_AMOUNT',
        'Ledger amounts must be non-negative safe integers',
      );
    }
    if (
      !value.booking_id.equals(first.booking_id) ||
      !value.partner_id.equals(first.partner_id) ||
      !value.venue_id.equals(first.venue_id) ||
      !value.contract_id.equals(first.contract_id) ||
      value.environment !== first.environment ||
      value.currency !== first.currency ||
      value.correlation_id !== first.correlation_id
    ) {
      throw invalid(
        'LEDGER_SCOPE_MISMATCH',
        'Every entry in a journal must share one financial scope',
      );
    }
    if (value.direction === 'DEBIT') debit += value.amount_minor;
    else credit += value.amount_minor;
  }
  if (!Number.isSafeInteger(debit) || debit !== credit) {
    throw invalid(
      'LEDGER_JOURNAL_UNBALANCED',
      'Ledger journal debit and credit totals must match',
    );
  }
}

function entry(
  input: {
    booking: LedgerBookingSnapshot;
    effectiveAt: Date;
    correlationId: string;
  },
  entryType: LedgerEntryType,
  direction: LedgerDirection,
  amountMinor: number,
  component: string,
): LedgerEntryDocument {
  return {
    _id: new ObjectId(),
    booking_id: input.booking.bookingId,
    partner_id: input.booking.partnerId,
    venue_id: input.booking.venueId,
    contract_id: input.booking.contractId,
    settlement_id: null,
    payout_id: null,
    reverses_entry_id: null,
    environment: input.booking.environment,
    entry_type: entryType,
    direction,
    amount_minor: amountMinor,
    currency: 'INR',
    effective_at: input.effectiveAt,
    correlation_id: required(input.correlationId, 'correlationId'),
    metadata: { component },
    created_at: input.effectiveAt,
  };
}

function assertBookingAmounts(booking: LedgerBookingSnapshot): void {
  for (const value of [
    booking.grossAmountMinor,
    booking.commissionAmountMinor,
    booking.taxAmountMinor,
    booking.venueNetAmountMinor,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalid(
        'INVALID_BOOKING_LEDGER_AMOUNT',
        'Booking financial amounts must be non-negative safe integers',
      );
    }
  }
  if (
    booking.grossAmountMinor !==
    booking.commissionAmountMinor +
      booking.taxAmountMinor +
      booking.venueNetAmountMinor
  ) {
    throw invalid(
      'BOOKING_LEDGER_IMBALANCE',
      'Booking financial components must equal gross amount',
    );
  }
}

function assertScope(
  booking: LedgerBookingSnapshot,
  entries: LedgerEntryDocument[],
): void {
  if (
    entries.some(
      (value) =>
        !value.booking_id.equals(booking.bookingId) ||
        !value.partner_id.equals(booking.partnerId) ||
        !value.venue_id.equals(booking.venueId) ||
        !value.contract_id.equals(booking.contractId) ||
        value.environment !== booking.environment,
    )
  ) {
    throw conflict(
      'LEDGER_BOOKING_SCOPE_MISMATCH',
      'Ledger entries do not match the Booking financial scope',
    );
  }
}

function scaledBalancedAmounts(
  entries: LedgerEntryDocument[],
  percent: number,
): number[] {
  const result = Array<number>(entries.length).fill(0);
  for (const direction of ['DEBIT', 'CREDIT'] as const) {
    const positions = entries
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value.direction === direction);
    const total = positions.reduce(
      (sum, { value }) => sum + value.amount_minor,
      0,
    );
    const target = Math.round((total * percent) / 100);
    const shares = positions.map(({ value, index }) => {
      const exact = (value.amount_minor * percent) / 100;
      return { index, amount: Math.floor(exact), remainder: exact % 1 };
    });
    let remaining =
      target - shares.reduce((sum, { amount }) => sum + amount, 0);
    shares.sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    );
    for (const share of shares) {
      if (remaining > 0) {
        share.amount += 1;
        remaining -= 1;
      }
      result[share.index] = share.amount;
    }
  }
  return result;
}

function validateReversals(
  reversals: LedgerEntryDocument[],
  originals: LedgerEntryDocument[],
): void {
  const byId = new Map(
    originals.map((value) => [value._id.toHexString(), value]),
  );
  const seen = new Set<string>();
  for (const reversal of reversals) {
    const id = reversal.reverses_entry_id?.toHexString();
    const original = id ? byId.get(id) : undefined;
    if (
      !id ||
      seen.has(id) ||
      !original ||
      reversal.direction === original.direction ||
      reversal.amount_minor > original.amount_minor
    ) {
      throw conflict(
        'INVALID_LEDGER_REVERSAL',
        'Reversal entries must uniquely offset an original entry',
      );
    }
    seen.add(id);
  }
}

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw invalid('FIELD_REQUIRED', `${field} is required`);
  return result;
}

function invalid(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 409 });
}
