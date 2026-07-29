import { createHash, randomUUID } from 'node:crypto';

import { MongoServerError, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { OutboxRepository } from '../../shared/communications/outbox.repository.js';
import type { PartnerVenueContractDocument } from '../contracts/contract.types.js';
import type {
  LedgerEntryDocument,
  LedgerRepository,
} from '../ledger/ledger.repository.js';
import type { CourtDocument } from '../venue/court.types.js';
import type {
  PricingRuleDocument,
  SlotDocument,
} from '../venue/inventory.types.js';
import type { VenueDocument } from '../venue/venue.types.js';
import type { BookingLifecycleRepository } from './booking-lifecycle.repository.js';
import type {
  ApiIdempotencyRecordDocument,
  BookingCancellationDocument,
  BookingDocument,
  BookingType,
} from './booking.types.js';

type Environment = 'SANDBOX' | 'PRODUCTION';

export interface HoldBookingInput {
  partnerId: string;
  environment: Environment;
  bookingType: BookingType;
  correlationId: string;
  slotId?: string;
  venueId?: string;
  courtId?: string;
  startsAt?: string;
  endsAt?: string;
}

export interface ConfirmBookingInput {
  partnerId: string;
  environment: Environment;
  holdId: string;
  idempotencyKey: string;
  externalBookingReference: string;
  customerReference?: string;
  partnerPaymentReference?: string;
  correlationId: string;
}

export interface CancelBookingInput {
  partnerId: string;
  environment: Environment;
  bookingId: string;
  idempotencyKey: string;
  reasonCode: string;
  reasonText?: string;
  correlationId: string;
}

export interface BookingLifecycleService {
  hold(input: HoldBookingInput): Promise<{
    holdId: string;
    slotId: string;
    venueId: string;
    courtId: string;
    bookingType: BookingType;
    startsAt: string;
    endsAt: string;
    priceMinor: number;
    currency: 'INR';
    expiresAt: string;
  }>;
  confirm(input: ConfirmBookingInput): Promise<Record<string, unknown>>;
  cancel(input: CancelBookingInput): Promise<Record<string, unknown>>;
  recoverExpiredHolds(): Promise<{
    fixedReleased: number;
    openReleased: number;
  }>;
  getAudit(input: {
    bookingId: string;
  }): Promise<Record<string, unknown>>;
}

export function createBookingLifecycleService(input: {
  repository: BookingLifecycleRepository;
  ledgerRepository: LedgerRepository;
  outboxRepository: OutboxRepository;
  database: DatabaseConnection;
  now?: () => Date;
  holdTtlMs?: number;
  idempotencyTtlMs?: number;
}): BookingLifecycleService {
  const now = input.now ?? (() => new Date());
  const holdTtlMs = input.holdTtlMs ?? 10 * 60 * 1_000;
  const idempotencyTtlMs = input.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000;

  return {
    async hold(values) {
      const partnerId = oid(values.partnerId);
      const timestamp = now();
      const holdId = randomUUID();
      let held: SlotDocument | undefined;

      await input.database.withTransaction(async ({ session }) => {
        if (values.bookingType === 'FIXED_SLOT') {
          if (!values.slotId) {
            throw invalid('FIXED_SLOT_ID_REQUIRED', 'slotId is required');
          }
          const slot = await input.repository.findSlot(
            oid(values.slotId),
            session,
          );
          if (!slot || slot.booking_type !== 'FIXED_SLOT') {
            throw notFound('SLOT_NOT_FOUND', 'Fixed Slot was not found');
          }
          const context = await loadContext({
            partnerId,
            environment: values.environment,
            venueId: slot.venue_id,
            courtId: slot.court_id,
            at: timestamp,
            session,
          });
          assertBookable(context, 'FIXED_SLOT');
          if (slot.starts_at <= timestamp || slot.price_minor === null) {
            throw conflict(
              'SLOT_NOT_AVAILABLE',
              'Slot is not available for a future priced booking',
            );
          }
          const expiresAt = expiry(timestamp, slot.starts_at, holdTtlMs);
          held =
            (await input.repository.claimFixedHold({
              slotId: slot._id,
              partnerId,
              environment: values.environment,
              holdId,
              expiresAt,
              now: timestamp,
              previousStatus:
                slot.status === 'HELD' ? 'HELD' : 'AVAILABLE',
              correlationId: values.correlationId,
              session,
            })) ?? undefined;
          if (!held) {
            throw conflict(
              'SLOT_NOT_AVAILABLE',
              'Slot is already held, booked, blocked, or unavailable',
            );
          }
          return;
        }

        const venueId = oid(required(values.venueId, 'venueId'));
        const courtId = oid(required(values.courtId, 'courtId'));
        const startsAt = instant(values.startsAt, 'startsAt');
        const endsAt = instant(values.endsAt, 'endsAt');
        if (startsAt <= timestamp || endsAt <= startsAt) {
          throw invalid(
            'INVALID_BOOKING_INTERVAL',
            'A future interval with startsAt before endsAt is required',
          );
        }
        const context = await loadContext({
          partnerId,
          environment: values.environment,
          venueId,
          courtId,
          at: timestamp,
          session,
        });
        assertBookable(context, 'OPEN_TIME');
        validateOpenInterval(context.venue, context.court, startsAt, endsAt);
        const conflictSlot = await input.repository.findConflictingSlot({
          courtId,
          environment: values.environment,
          startsAt,
          endsAt,
          now: timestamp,
          session,
        });
        if (conflictSlot) {
          throw conflict(
            'INVENTORY_OVERLAP',
            'The requested interval overlaps unavailable inventory',
          );
        }
        if (
          !(await input.repository.lockCourt({
            courtId,
            version: context.court.version,
            now: timestamp,
            session,
          }))
        ) {
          throw conflict(
            'INVENTORY_VERSION_CONFLICT',
            'Court inventory changed concurrently',
          );
        }
        const pricingRules = await input.repository.findPricingRules(
          courtId,
          startsAt,
          session,
        );
        const priceMinor = resolvePrice(
          context.venue,
          pricingRules,
          startsAt,
          endsAt,
        );
        const expiresAt = expiry(timestamp, startsAt, holdTtlMs);
        held = {
          _id: new ObjectId(),
          court_id: courtId,
          venue_id: venueId,
          environment: values.environment,
          booking_type: 'OPEN_TIME',
          starts_at: startsAt,
          ends_at: endsAt,
          price_minor: priceMinor,
          currency: 'INR',
          status: 'HELD',
          hold_id: holdId,
          hold_partner_id: partnerId,
          hold_expires_at: expiresAt,
          hold_created_at: timestamp,
          source: 'BOOKING',
          booking_id: null,
          audit_history: [{
            event_type: 'SLOT_HELD',
            actor_type: 'PARTNER',
            actor_id: partnerId,
            previous_status: null,
            new_status: 'HELD',
            reason: 'Partner open-time booking hold',
            correlation_id: values.correlationId,
            occurred_at: timestamp,
          }],
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
        };
        await input.repository.insertSlot(held, session);
      });

      if (!held?.hold_id || !held.hold_expires_at || held.price_minor === null) {
        throw new Error('Hold transaction completed without a result');
      }
      return {
        holdId: held.hold_id,
        slotId: held._id.toHexString(),
        venueId: held.venue_id.toHexString(),
        courtId: held.court_id.toHexString(),
        bookingType: held.booking_type,
        startsAt: held.starts_at.toISOString(),
        endsAt: held.ends_at.toISOString(),
        priceMinor: held.price_minor,
        currency: held.currency,
        expiresAt: held.hold_expires_at.toISOString(),
      };
    },

    async confirm(values) {
      const partnerId = oid(values.partnerId);
      const key = idempotencyKey(values.idempotencyKey);
      const operation = 'BOOKING_CONFIRM';
      const requestHash = hash({
        holdId: required(values.holdId, 'holdId'),
        externalBookingReference: required(
          values.externalBookingReference,
          'externalBookingReference',
        ),
        customerReference: optional(values.customerReference),
        partnerPaymentReference: optional(values.partnerPaymentReference),
      });
      const replay = await replayIfPresent({
        partnerId,
        environment: values.environment,
        key,
        operation,
        requestHash,
      });
      if (replay) return replay;

      try {
        let response: Record<string, unknown> | undefined;
        await input.database.withTransaction(async ({ session }) => {
          const existing = await input.repository.getIdempotency(
            partnerId,
            values.environment,
            key,
            operation,
            session,
          );
          if (existing) {
            response = sameRequest(existing, requestHash);
            return;
          }
          const timestamp = now();
          const slot = await input.repository.findHeldSlot(
            values.holdId,
            partnerId,
            values.environment,
            session,
          );
          if (!slot || !slot.hold_expires_at || slot.hold_expires_at <= timestamp) {
            throw conflict(
              'HOLD_NOT_ACTIVE',
              'Hold was not found, does not belong to the Partner, or expired',
            );
          }
          if (slot.price_minor === null) {
            throw conflict('BOOKING_PRICE_MISSING', 'Held Slot has no price');
          }
          const context = await loadContext({
            partnerId,
            environment: values.environment,
            venueId: slot.venue_id,
            courtId: slot.court_id,
            at: timestamp,
            session,
          });
          assertBookable(context, slot.booking_type);
          const amounts = calculateAmounts(
            slot.price_minor,
            context.contract,
          );
          const bookingId = new ObjectId();
          const booking: BookingDocument = {
            _id: bookingId,
            slot_id: slot._id,
            contract_id: context.contract._id,
            partner_id: partnerId,
            venue_id: slot.venue_id,
            court_id: slot.court_id,
            environment: values.environment,
            booking_type: slot.booking_type,
            starts_at: slot.starts_at,
            ends_at: slot.ends_at,
            external_booking_reference: values.externalBookingReference.trim(),
            confirm_idempotency_key: key,
            customer_reference: optional(values.customerReference),
            partner_payment_reference: optional(
              values.partnerPaymentReference,
            ),
            status: 'CONFIRMED',
            ...amounts,
            currency: 'INR',
            cancellation_terms_snapshot: {
              cancellation_terms: context.contract.cancellation_terms,
              refund_rules: context.contract.refund_rules,
              resale_cutoff_minutes: context.contract.resale_cutoff_minutes,
              commission_rate_bps: context.contract.commission_rate_bps,
              tax_rate_bps: context.contract.tax_rate_bps,
              terms_version: context.contract.terms_version,
            },
            confirmed_at: timestamp,
            cancelled_at: null,
            audit_history: [{
              event_type: 'BOOKING_CONFIRMED',
              actor_type: 'PARTNER',
              actor_id: partnerId,
              correlation_id: values.correlationId,
              changes: {
                previous_status: null,
                new_status: 'CONFIRMED',
                reason: 'Partner confirmed an active hold',
                contract_id: context.contract._id.toHexString(),
                terms_version: context.contract.terms_version,
              },
              occurred_at: timestamp,
            }],
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
          };
          if (
            !(await input.repository.confirmSlot({
              slot,
              bookingId,
              partnerId,
              now: timestamp,
              correlationId: values.correlationId,
              session,
            }))
          ) {
            throw conflict(
              'HOLD_CONFIRMATION_CONFLICT',
              'Held inventory changed concurrently',
            );
          }
          await input.repository.insertBooking(booking, session);
          await input.ledgerRepository.post(
            confirmationLedger(booking, timestamp, values.correlationId),
            session,
          );
          await enqueueBookingEvent(
            input.outboxRepository,
            booking,
            'BOOKING_CONFIRMED',
            1,
            timestamp,
            values.correlationId,
            session,
          );
          response = bookingView(booking);
          await input.repository.insertIdempotency(
            idempotencyRecord({
              partnerId,
              environment: values.environment,
              key,
              operation,
              requestHash,
              response,
              resourceId: bookingId,
              now: timestamp,
              ttlMs: idempotencyTtlMs,
            }),
            session,
          );
        });
        if (!response) {
          throw new Error('Confirmation transaction completed without a result');
        }
        return response;
      } catch (error) {
        if (duplicate(error)) {
          const replayed = await replayIfPresent({
            partnerId,
            environment: values.environment,
            key,
            operation,
            requestHash,
          });
          if (replayed) return replayed;
        }
        throw error;
      }
    },

    async cancel(values) {
      const partnerId = oid(values.partnerId);
      const bookingId = oid(values.bookingId);
      const key = idempotencyKey(values.idempotencyKey);
      const operation = `BOOKING_CANCEL:${bookingId.toHexString()}`;
      const reasonCode = required(values.reasonCode, 'reasonCode').toUpperCase();
      const reasonText = optional(values.reasonText);
      const requestHash = hash({ bookingId: values.bookingId, reasonCode, reasonText });
      const replay = await replayIfPresent({
        partnerId,
        environment: values.environment,
        key,
        operation,
        requestHash,
      });
      if (replay) return replay;

      try {
        let response: Record<string, unknown> | undefined;
        await input.database.withTransaction(async ({ session }) => {
          const existing = await input.repository.getIdempotency(
            partnerId,
            values.environment,
            key,
            operation,
            session,
          );
          if (existing) {
            response = sameRequest(existing, requestHash);
            return;
          }
          const timestamp = now();
          const booking = await input.repository.findBooking(
            bookingId,
            partnerId,
            values.environment,
            session,
          );
          if (!booking) {
            throw notFound('BOOKING_NOT_FOUND', 'Booking was not found');
          }
          if (booking.status !== 'CONFIRMED') {
            throw conflict(
              'BOOKING_NOT_CANCELLABLE',
              'Only a confirmed booking can be cancelled',
            );
          }
          const policy = cancellationPolicy(booking, timestamp);
          if (!policy.allowed) {
            throw conflict(
              'CANCELLATION_NOT_ALLOWED',
              'The snapshotted contract prohibits cancellation',
            );
          }
          const refundAmount = Math.round(
            (booking.gross_amount_minor * policy.refundPercent) / 100,
          );
          const disposition = policy.releaseInventory
            ? 'RELEASE_TO_INVENTORY'
            : 'KEEP_UNAVAILABLE';
          const cancelled = await input.repository.cancelBooking({
            booking,
            now: timestamp,
            correlationId: values.correlationId,
            reasonCode,
            reasonText,
            session,
          });
          if (!cancelled) {
            throw conflict(
              'BOOKING_VERSION_CONFLICT',
              'Booking changed concurrently',
            );
          }
          if (
            !(await input.repository.disposeSlot({
              booking,
              disposition,
              now: timestamp,
              correlationId: values.correlationId,
              session,
            }))
          ) {
            throw conflict(
              'SLOT_DISPOSITION_CONFLICT',
              'Booked Slot changed concurrently',
            );
          }
          const cancellation: BookingCancellationDocument = {
            _id: new ObjectId(),
            booking_id: booking._id,
            requested_by_type: 'PARTNER',
            requested_by_id: partnerId,
            reason_code: reasonCode,
            reason_text: reasonText,
            refund_percent: policy.refundPercent,
            refund_amount_minor: refundAmount,
            slot_disposition: disposition,
            idempotency_key: key,
            cancelled_at: timestamp,
            created_at: timestamp,
          };
          await input.repository.insertCancellation(cancellation, session);
          const originals = await input.ledgerRepository.listForBooking(
            booking._id,
            session,
          );
          await input.ledgerRepository.post(
            cancellationLedger(
              booking,
              originals,
              policy.refundPercent,
              timestamp,
              values.correlationId,
            ),
            session,
          );
          await enqueueBookingEvent(
            input.outboxRepository,
            cancelled,
            'BOOKING_CANCELLED',
            cancelled.version,
            timestamp,
            values.correlationId,
            session,
            { refundAmountMinor: refundAmount, disposition },
          );
          response = {
            bookingId: booking._id.toHexString(),
            status: 'CANCELLED',
            refundPercent: policy.refundPercent,
            refundAmountMinor: refundAmount,
            currency: booking.currency,
            slotDisposition: disposition,
            cancelledAt: timestamp.toISOString(),
          };
          await input.repository.insertIdempotency(
            idempotencyRecord({
              partnerId,
              environment: values.environment,
              key,
              operation,
              requestHash,
              response,
              resourceId: booking._id,
              now: timestamp,
              ttlMs: idempotencyTtlMs,
            }),
            session,
          );
        });
        if (!response) {
          throw new Error('Cancellation transaction completed without a result');
        }
        return response;
      } catch (error) {
        if (duplicate(error)) {
          const replayed = await replayIfPresent({
            partnerId,
            environment: values.environment,
            key,
            operation,
            requestHash,
          });
          if (replayed) return replayed;
        }
        throw error;
      }
    },

    recoverExpiredHolds() {
      return input.repository.recoverExpiredHolds(now());
    },

    async getAudit(values) {
      const booking = await input.repository.findBookingAudit(
        oid(values.bookingId),
      );
      if (!booking) {
        throw notFound('BOOKING_NOT_FOUND', 'Booking was not found');
      }
      return {
        bookingId: booking._id.toHexString(),
        status: booking.status,
        auditHistory: [...booking.audit_history]
          .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
          .map((entry) => ({
            eventType: entry.event_type,
            actorType: entry.actor_type,
            actorId: entry.actor_id?.toHexString() ?? null,
            correlationId: entry.correlation_id,
            changes: entry.changes,
            occurredAt: entry.occurred_at.toISOString(),
          })),
      };
    },
  };

  async function loadContext(values: {
    partnerId: ObjectId;
    environment: Environment;
    venueId: ObjectId;
    courtId: ObjectId;
    at: Date;
    session: import('mongodb').ClientSession;
  }) {
    // MongoDB transactions do not support parallel operations on one session.
    const venue = await input.repository.findVenue(
      values.venueId,
      values.session,
    );
    const court = await input.repository.findCourt(
      values.courtId,
      values.session,
    );
    const contract = await input.repository.findEffectiveContract(
      values.partnerId,
      values.venueId,
      values.environment,
      values.at,
      values.session,
    );
    if (!venue || venue.status !== 'ACTIVE') {
      throw conflict('VENUE_NOT_BOOKABLE', 'Venue is not active');
    }
    if (venue.environment !== values.environment) {
      throw conflict(
        'ENVIRONMENT_MISMATCH',
        'Partner and Venue environments must match',
      );
    }
    if (
      !court ||
      !court.venue_id.equals(values.venueId) ||
      court.status !== 'AVAILABLE'
    ) {
      throw conflict('COURT_NOT_BOOKABLE', 'Court is not available');
    }
    if (!contract) {
      throw conflict(
        'ACTIVE_CONTRACT_NOT_FOUND',
        'No effective Partner-Venue contract was found',
      );
    }
    return { venue, court, contract };
  }

  async function replayIfPresent(values: {
    partnerId: ObjectId;
    environment: Environment;
    key: string;
    operation: string;
    requestHash: string;
  }): Promise<Record<string, unknown> | null> {
    const existing = await input.repository.getIdempotency(
      values.partnerId,
      values.environment,
      values.key,
      values.operation,
    );
    return existing ? sameRequest(existing, values.requestHash) : null;
  }
}

function assertBookable(
  context: {
    court: CourtDocument;
    contract: PartnerVenueContractDocument;
  },
  mode: BookingType,
): void {
  if (
    context.court.booking_mode !== 'BOTH' &&
    context.court.booking_mode !== mode
  ) {
    throw conflict(
      'COURT_BOOKING_MODE_NOT_ALLOWED',
      `Court does not allow ${mode}`,
    );
  }
  if (
    context.contract.allowed_booking_modes !== 'BOTH' &&
    context.contract.allowed_booking_modes !== mode
  ) {
    throw conflict(
      'CONTRACT_BOOKING_MODE_NOT_ALLOWED',
      `Contract does not allow ${mode}`,
    );
  }
}

function validateOpenInterval(
  venue: VenueDocument,
  court: CourtDocument,
  startsAt: Date,
  endsAt: Date,
): void {
  const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  const minimum = Math.max(60, court.min_booking_minutes);
  if (
    durationMinutes < minimum ||
    durationMinutes % court.booking_increment_minutes !== 0
  ) {
    throw invalid(
      'INVALID_BOOKING_DURATION',
      `Duration must be at least ${minimum} minutes and follow ${court.booking_increment_minutes}-minute increments`,
    );
  }
  const start = localParts(startsAt, venue.timezone);
  const end = localParts(endsAt, venue.timezone);
  if (start.date !== end.date) {
    throw invalid(
      'OUTSIDE_OPERATING_HOURS',
      'Open-time bookings must remain within one local operating day',
    );
  }
  const hours = court.operating_hours.entries.find(
    ({ day_of_week }) => day_of_week === start.day,
  );
  if (
    !hours ||
    start.minutes < timeMinutes(hours.opens_at) ||
    end.minutes > timeMinutes(hours.closes_at)
  ) {
    throw invalid(
      'OUTSIDE_OPERATING_HOURS',
      'Requested interval is outside Court operating hours',
    );
  }
  if (
    (start.minutes - timeMinutes(hours.opens_at)) %
      court.booking_increment_minutes !==
    0
  ) {
    throw invalid(
      'INVALID_BOOKING_INCREMENT',
      'Start time does not follow the Court booking increment',
    );
  }
}

function resolvePrice(
  venue: VenueDocument,
  rules: PricingRuleDocument[],
  startsAt: Date,
  endsAt: Date,
): number {
  const start = localParts(startsAt, venue.timezone);
  const end = localParts(endsAt, venue.timezone);
  const rule = rules.find((candidate) => {
    if (candidate.day_of_week !== null && candidate.day_of_week !== start.day) {
      return false;
    }
    if (
      candidate.start_time !== null &&
      start.minutes < timeMinutes(candidate.start_time)
    ) {
      return false;
    }
    if (
      candidate.end_time !== null &&
      end.minutes > timeMinutes(candidate.end_time)
    ) {
      return false;
    }
    return true;
  });
  if (!rule) {
    throw conflict(
      'PRICING_RULE_NOT_FOUND',
      'No active Pricing Rule applies to the requested interval',
    );
  }
  return Math.round(
    rule.price_minor * ((endsAt.getTime() - startsAt.getTime()) / 3_600_000),
  );
}

function calculateAmounts(
  gross: number,
  contract: PartnerVenueContractDocument,
) {
  const commission = Math.round((gross * contract.commission_rate_bps) / 10_000);
  const tax = Math.round((gross * contract.tax_rate_bps) / 10_000);
  return {
    gross_amount_minor: gross,
    commission_amount_minor: commission,
    tax_amount_minor: tax,
    venue_net_amount_minor: gross - commission - tax,
  };
}

function confirmationLedger(
  booking: BookingDocument,
  timestamp: Date,
  correlationId: string,
): LedgerEntryDocument[] {
  const base = {
    booking_id: booking._id,
    partner_id: booking.partner_id,
    venue_id: booking.venue_id,
    contract_id: booking.contract_id,
    settlement_id: null,
    payout_id: null,
    reverses_entry_id: null,
    environment: booking.environment,
    currency: 'INR' as const,
    effective_at: timestamp,
    correlation_id: correlationId,
    created_at: timestamp,
  };
  return [
    {
      ...base,
      _id: new ObjectId(),
      entry_type: 'BOOKING',
      direction: 'DEBIT',
      amount_minor: booking.gross_amount_minor,
      metadata: { component: 'GROSS' },
    },
    {
      ...base,
      _id: new ObjectId(),
      entry_type: 'COMMISSION',
      direction: 'CREDIT',
      amount_minor: booking.commission_amount_minor,
      metadata: { component: 'COMMISSION' },
    },
    {
      ...base,
      _id: new ObjectId(),
      entry_type: 'TAX',
      direction: 'CREDIT',
      amount_minor: booking.tax_amount_minor,
      metadata: { component: 'TAX' },
    },
    {
      ...base,
      _id: new ObjectId(),
      entry_type: 'BOOKING',
      direction: 'CREDIT',
      amount_minor: booking.venue_net_amount_minor,
      metadata: { component: 'VENUE_NET' },
    },
  ];
}

function cancellationLedger(
  booking: BookingDocument,
  originals: LedgerEntryDocument[],
  refundPercent: number,
  timestamp: Date,
  correlationId: string,
): LedgerEntryDocument[] {
  if (refundPercent === 0) return [];
  return originals
    .filter((entry) => entry.reverses_entry_id === null)
    .map((entry) => ({
      _id: new ObjectId(),
      booking_id: booking._id,
      partner_id: booking.partner_id,
      venue_id: booking.venue_id,
      contract_id: booking.contract_id,
      settlement_id: null,
      payout_id: null,
      reverses_entry_id: entry._id,
      environment: booking.environment,
      entry_type: 'REVERSAL' as const,
      direction: entry.direction === 'DEBIT' ? 'CREDIT' as const : 'DEBIT' as const,
      amount_minor: Math.round((entry.amount_minor * refundPercent) / 100),
      currency: 'INR' as const,
      effective_at: timestamp,
      correlation_id: correlationId,
      metadata: {
        refund_percent: refundPercent,
        original_entry_type: entry.entry_type,
      },
      created_at: timestamp,
    }));
}

function cancellationPolicy(
  booking: BookingDocument,
  timestamp: Date,
): {
  allowed: boolean;
  refundPercent: number;
  releaseInventory: boolean;
} {
  const snapshot = booking.cancellation_terms_snapshot as {
    cancellation_terms?: {
      cancellation_allowed?: boolean;
      default_refund_bps?: number;
      release_inventory?: boolean;
    };
    refund_rules?: {
      rules?: Array<{
        min_minutes_before_start?: number;
        refund_bps?: number;
        release_inventory?: boolean;
      }>;
    };
    resale_cutoff_minutes?: number;
  };
  const terms = snapshot.cancellation_terms;
  if (!terms?.cancellation_allowed) {
    return { allowed: false, refundPercent: 0, releaseInventory: false };
  }
  const minutesBefore = Math.max(
    0,
    Math.floor((booking.starts_at.getTime() - timestamp.getTime()) / 60_000),
  );
  const rule = [...(snapshot.refund_rules?.rules ?? [])]
    .sort(
      (a, b) =>
        (b.min_minutes_before_start ?? 0) -
        (a.min_minutes_before_start ?? 0),
    )
    .find(
      ({ min_minutes_before_start }) =>
        minutesBefore >= (min_minutes_before_start ?? 0),
    );
  const refundBps = rule?.refund_bps ?? terms.default_refund_bps ?? 0;
  const releaseByPolicy =
    rule?.release_inventory ?? terms.release_inventory ?? false;
  const cutoff = snapshot.resale_cutoff_minutes ?? 0;
  return {
    allowed: true,
    refundPercent: Math.max(0, Math.min(100, Math.round(refundBps / 100))),
    releaseInventory: releaseByPolicy && minutesBefore >= cutoff,
  };
}

async function enqueueBookingEvent(
  repository: OutboxRepository,
  booking: BookingDocument,
  eventType: string,
  eventVersion: number,
  timestamp: Date,
  correlationId: string,
  session: import('mongodb').ClientSession,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await repository.enqueue({
    aggregateType: 'BOOKING',
    aggregateId: booking._id,
    partnerId: booking.partner_id,
    venueId: booking.venue_id,
    environment: booking.environment,
    eventType,
    eventVersion,
    correlationId,
    payload: {
      booking_id: booking._id.toHexString(),
      venue_id: booking.venue_id.toHexString(),
      court_id: booking.court_id.toHexString(),
      status: booking.status,
      ...extra,
    },
    now: timestamp,
    session,
  });
}

function idempotencyRecord(input: {
  partnerId: ObjectId;
  environment: Environment;
  key: string;
  operation: string;
  requestHash: string;
  response: Record<string, unknown>;
  resourceId: ObjectId;
  now: Date;
  ttlMs: number;
}): ApiIdempotencyRecordDocument {
  return {
    _id: new ObjectId(),
    partner_id: input.partnerId,
    environment: input.environment,
    idempotency_key: input.key,
    operation: input.operation,
    request_hash: input.requestHash,
    response_status: 201,
    response_body: input.response,
    resource_type: 'BOOKING',
    resource_id: input.resourceId,
    expires_at: new Date(input.now.getTime() + input.ttlMs),
    created_at: input.now,
  };
}

function sameRequest(
  record: ApiIdempotencyRecordDocument,
  requestHash: string,
): Record<string, unknown> {
  if (record.request_hash !== requestHash) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was already used with a different request',
    );
  }
  if (!record.response_body) {
    throw conflict(
      'IDEMPOTENCY_RESPONSE_UNAVAILABLE',
      'The stored idempotency response is unavailable',
    );
  }
  return record.response_body;
}

function bookingView(booking: BookingDocument): Record<string, unknown> {
  return {
    bookingId: booking._id.toHexString(),
    slotId: booking.slot_id.toHexString(),
    venueId: booking.venue_id.toHexString(),
    courtId: booking.court_id.toHexString(),
    bookingType: booking.booking_type,
    startsAt: booking.starts_at.toISOString(),
    endsAt: booking.ends_at.toISOString(),
    externalBookingReference: booking.external_booking_reference,
    status: booking.status,
    grossAmountMinor: booking.gross_amount_minor,
    commissionAmountMinor: booking.commission_amount_minor,
    taxAmountMinor: booking.tax_amount_minor,
    venueNetAmountMinor: booking.venue_net_amount_minor,
    currency: booking.currency,
    confirmedAt: booking.confirmed_at.toISOString(),
  };
}

function localParts(value: Date, timezone: string): {
  date: string;
  day: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekdays: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    day: weekdays[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function expiry(now: Date, startsAt: Date, ttlMs: number): Date {
  return new Date(Math.min(now.getTime() + ttlMs, startsAt.getTime()));
}

function hash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function duplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function idempotencyKey(value: string): string {
  const key = required(value, 'Idempotency-Key');
  if (key.length > 200) {
    throw invalid(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must not exceed 200 characters',
    );
  }
  return key;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw invalid('INVALID_REQUEST', `${name} is required`);
  return normalized;
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function instant(value: string | undefined, name: string): Date {
  const parsed = new Date(required(value, name));
  if (Number.isNaN(parsed.getTime())) {
    throw invalid('INVALID_REQUEST', `${name} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw invalid('INVALID_ID', 'A valid identifier is required');
  }
  return new ObjectId(value);
}

function invalid(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 409 });
}

function notFound(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 404 });
}
