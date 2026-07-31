import { ObjectId, type Db } from 'mongodb';

import { AppError } from '../../../shared/errors/app-error.js';
import type { BookingDocument } from '../../booking/booking.types.js';
import type {
  InvoiceDocument,
  SettlementDocument,
} from '../../financial-close/financial-close.types.js';
import type { LedgerEntryDocument } from '../../ledger/ledger.types.js';
import type { CourtDocument } from '../../venue/courts/court.types.js';
import type {
  PricingRuleDocument,
  SlotDocument,
} from '../../venue/inventory/inventory.types.js';
import type { VenueDocument } from '../../venue/profile/venue.types.js';
import type {
  ApiUsageDailyDocument,
  PartnerEnvironment,
} from './partner-access.types.js';

type BookingMode = 'OPEN_TIME' | 'FIXED_SLOT';

interface ContractDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  venue_id: ObjectId;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  allowed_booking_modes: 'OPEN_TIME' | 'FIXED_SLOT' | 'BOTH';
  effective_from: Date;
  effective_to: Date | null;
}

export interface PartnerPortalService {
  searchAvailability(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    sportType: CourtDocument['sport_type'];
    startsAt: string;
    endsAt: string;
    bookingType?: BookingMode;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  listUsage(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  listBookings(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    from?: string;
    to?: string;
    status?: BookingDocument['status'];
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  listSettlements(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    from?: string;
    to?: string;
    status?: SettlementDocument['status'];
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  getSettlement(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    settlementId: string;
  }): Promise<unknown>;
  listInvoices(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  getInvoice(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    invoiceId: string;
  }): Promise<unknown>;
}

export function createPartnerPortalService(db: Db): PartnerPortalService {
  return {
    async searchAvailability(input) {
      const startsAt = instant(input.startsAt, 'startsAt');
      const endsAt = instant(input.endsAt, 'endsAt');
      if (startsAt >= endsAt) invalid('INVALID_AVAILABILITY_RANGE');
      const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
      if (durationMinutes > 24 * 60) invalid('AVAILABILITY_RANGE_TOO_LARGE');
      const limit = boundedLimit(input.limit);
      const partnerId = oid(input.partnerId);

      const venues = await db.collection<VenueDocument>('venues').aggregate<
        VenueDocument & { distance_meters: number }
      >([
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: [input.longitude, input.latitude],
            },
            distanceField: 'distance_meters',
            maxDistance: input.radiusMeters,
            spherical: true,
            query: { environment: input.environment, status: 'ACTIVE' },
          },
        },
        { $limit: 500 },
      ]).toArray();
      if (venues.length === 0) return { items: [], nextCursor: null };

      const contracts = await db.collection<ContractDocument>(
        'partner_venue_contracts',
      ).find({
        partner_id: partnerId,
        venue_id: { $in: venues.map(({ _id }) => _id) },
        status: 'ACTIVE',
        effective_from: { $lte: startsAt },
        $or: [{ effective_to: null }, { effective_to: { $gt: startsAt } }],
      }).sort({ effective_from: -1 }).toArray();
      const contractByVenue = new Map(
        contracts.map((value) => [value.venue_id.toHexString(), value]),
      );
      const eligibleVenues = venues.filter((value) =>
        contractByVenue.has(value._id.toHexString()));
      if (eligibleVenues.length === 0) return { items: [], nextCursor: null };

      const courts = await db.collection<CourtDocument>('courts').find({
        venue_id: { $in: eligibleVenues.map(({ _id }) => _id) },
        status: 'AVAILABLE',
        sport_type: input.sportType,
        ...(input.bookingType
          ? {
              booking_mode: {
                $in: [input.bookingType, 'BOTH'],
              },
            }
          : {}),
      }).toArray();
      const courtIds = courts.map(({ _id }) => _id);
      const fixedSlots = courtIds.length
        ? await db.collection<SlotDocument>('slots').find({
            court_id: { $in: courtIds },
            environment: input.environment,
            booking_type: 'FIXED_SLOT',
            status: 'AVAILABLE',
            starts_at: { $gte: startsAt },
            ends_at: { $lte: endsAt },
          }).sort({ starts_at: 1, _id: 1 }).toArray()
        : [];
      const pricingRules = courtIds.length
        ? await db.collection<PricingRuleDocument>('pricing_rules').find({
            court_id: { $in: courtIds },
            active: true,
            effective_from: { $lte: startsAt },
            $or: [{ effective_to: null }, { effective_to: { $gt: startsAt } }],
          }).sort({ priority: -1, created_at: 1 }).toArray()
        : [];
      const venueById = new Map(
        eligibleVenues.map((value) => [value._id.toHexString(), value]),
      );
      const fixedByCourt = groupBy(fixedSlots, (value) =>
        value.court_id.toHexString());
      const rulesByCourt = groupBy(pricingRules, (value) =>
        value.court_id.toHexString());
      const items: Array<Record<string, unknown>> = [];

      for (const court of courts) {
        const venue = venueById.get(court.venue_id.toHexString());
        const contract = contractByVenue.get(court.venue_id.toHexString());
        if (!venue || !contract) continue;
        const base = {
          venueId: venue._id.toHexString(),
          venueName: venue.display_name,
          address: venue.address,
          distanceMeters: Math.round(
            (venue as VenueDocument & { distance_meters: number })
              .distance_meters,
          ),
          courtId: court._id.toHexString(),
          courtName: court.name,
          sportType: court.sport_type,
          contractId: contract._id.toHexString(),
          currency: 'INR',
        };
        if (
          input.bookingType !== 'OPEN_TIME' &&
          allows(court.booking_mode, contract.allowed_booking_modes, 'FIXED_SLOT')
        ) {
          for (const slot of fixedByCourt.get(court._id.toHexString()) ?? []) {
            items.push({
              ...base,
              availabilityId: slot._id.toHexString(),
              bookingType: 'FIXED_SLOT',
              startsAt: slot.starts_at.toISOString(),
              endsAt: slot.ends_at.toISOString(),
              priceMinor: slot.price_minor,
            });
          }
        }
        if (
          input.bookingType !== 'FIXED_SLOT' &&
          allows(court.booking_mode, contract.allowed_booking_modes, 'OPEN_TIME') &&
          durationMinutes >= court.min_booking_minutes &&
          durationMinutes % court.booking_increment_minutes === 0 &&
          insideOperatingHours(court, venue.timezone, startsAt, endsAt)
        ) {
          const overlap = await db.collection<SlotDocument>('slots').findOne({
            court_id: court._id,
            environment: input.environment,
            status: { $in: ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'] },
            starts_at: { $lt: endsAt },
            ends_at: { $gt: startsAt },
          });
          const rule = matchingRule(
            rulesByCourt.get(court._id.toHexString()) ?? [],
            venue.timezone,
            startsAt,
          );
          if (!overlap && rule) {
            items.push({
              ...base,
              availabilityId: null,
              bookingType: 'OPEN_TIME',
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              priceMinor: Math.round(rule.price_minor * durationMinutes / 60),
            });
          }
        }
      }

      items.sort((left, right) =>
        Number(left.distanceMeters) - Number(right.distanceMeters) ||
        String(left.courtId).localeCompare(String(right.courtId)) ||
        String(left.startsAt).localeCompare(String(right.startsAt)));
      const after = decodeCursor(input.cursor);
      const filtered = after
        ? items.filter((item) => availabilityKey(item) > after)
        : items;
      const page = filtered.slice(0, limit);
      return {
        items: page,
        nextCursor:
          filtered.length > limit && page.length
            ? encodeCursor(availabilityKey(page[page.length - 1]!))
            : null,
      };
    },

    async listUsage(input) {
      const query: Record<string, unknown> = scopedQuery(input);
      if (input.from || input.to) {
        query.usage_date = dateRange(input.from, input.to);
      }
      return listByCursor(
        db.collection<ApiUsageDailyDocument>('api_usage_daily'),
        query,
        input.cursor,
        input.limit,
        usageView,
      );
    },

    async listBookings(input) {
      const query: Record<string, unknown> = {
        ...scopedQuery(input),
        ...(input.status ? { status: input.status } : {}),
      };
      if (input.from || input.to) query.starts_at = dateRange(input.from, input.to);
      return listByCursor(
        db.collection<BookingDocument>('bookings'),
        query,
        input.cursor,
        input.limit,
        bookingView,
      );
    },

    async listSettlements(input) {
      const query: Record<string, unknown> = {
        ...scopedQuery(input),
        ...(input.status ? { status: input.status } : {}),
      };
      if (input.from || input.to) {
        query.period_start = dateRange(input.from, input.to);
      }
      return listByCursor(
        db.collection<SettlementDocument>('settlements'),
        query,
        input.cursor,
        input.limit,
        settlementView,
      );
    },

    async getSettlement(input) {
      const settlement = await db.collection<SettlementDocument>(
        'settlements',
      ).findOne({
        _id: oid(input.settlementId),
        partner_id: oid(input.partnerId),
        environment: input.environment,
      });
      if (!settlement) notFound('SETTLEMENT_NOT_FOUND');
      const entries = await db.collection<LedgerEntryDocument>(
        'ledger_entries',
      ).find({
        settlement_id: settlement!._id,
        partner_id: settlement!.partner_id,
        environment: settlement!.environment,
      }).sort({ effective_at: 1, _id: 1 }).toArray();
      const bookings = await db.collection<BookingDocument>('bookings').find({
        _id: { $in: uniqueIds(entries.map(({ booking_id }) => booking_id)) },
        partner_id: settlement!.partner_id,
        environment: settlement!.environment,
      }).toArray();
      return {
        ...settlementView(settlement!),
        allocations: bookings.map(bookingView),
      };
    },

    async listInvoices(input) {
      const settlements = await db.collection<SettlementDocument>(
        'settlements',
      ).find({
        partner_id: oid(input.partnerId),
        environment: input.environment,
      }).project<{ _id: ObjectId }>({ _id: 1 }).toArray();
      return listByCursor(
        db.collection<InvoiceDocument>('invoices'),
        {
          settlement_id: { $in: settlements.map(({ _id }) => _id) },
          environment: input.environment,
        },
        input.cursor,
        input.limit,
        invoiceView,
      );
    },

    async getInvoice(input) {
      const invoice = await db.collection<InvoiceDocument>('invoices').findOne({
        _id: oid(input.invoiceId),
        environment: input.environment,
      });
      if (!invoice) notFound('INVOICE_NOT_FOUND');
      const settlement = await db.collection<SettlementDocument>(
        'settlements',
      ).findOne({
        _id: invoice!.settlement_id,
        partner_id: oid(input.partnerId),
        environment: input.environment,
      });
      if (!settlement) notFound('INVOICE_NOT_FOUND');
      return invoiceView(invoice!);
    },
  };
}

function scopedQuery(input: {
  partnerId: string;
  environment: PartnerEnvironment;
}) {
  return {
    partner_id: oid(input.partnerId),
    environment: input.environment,
  };
}

async function listByCursor<T extends { _id: ObjectId }, V>(
  collection: import('mongodb').Collection<T>,
  query: Record<string, unknown>,
  cursor: string | undefined,
  requestedLimit: number | undefined,
  view: (value: T) => V,
): Promise<{ items: V[]; nextCursor: string | null }> {
  const limit = boundedLimit(requestedLimit);
  if (cursor) query._id = { $lt: oid(cursor) };
  const values = await collection.find(query as never).sort({ _id: -1 }).limit(limit + 1)
    .toArray();
  const hasMore = values.length > limit;
  const page = values.slice(0, limit);
  return {
    items: page.map((value) => view(value as T)),
    nextCursor: hasMore ? page[page.length - 1]!._id.toHexString() : null,
  };
}

function boundedLimit(value = 25): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    invalid('INVALID_PAGINATION');
  }
  return value;
}

function dateRange(from?: string, to?: string): Record<string, Date> {
  const result: Record<string, Date> = {};
  if (from) result.$gte = instant(from, 'from');
  if (to) result.$lte = instant(to, 'to');
  if (result.$gte && result.$lte && result.$gte > result.$lte) {
    invalid('INVALID_DATE_RANGE');
  }
  return result;
}

function insideOperatingHours(
  court: CourtDocument,
  timezone: string,
  startsAt: Date,
  endsAt: Date,
): boolean {
  const start = localParts(startsAt, timezone);
  const end = localParts(endsAt, timezone);
  if (start.date !== end.date) return false;
  const hours = court.operating_hours.entries.find(
    ({ day_of_week }) => day_of_week === start.day,
  );
  return Boolean(
    hours &&
      start.time >= hours.opens_at &&
      end.time <= hours.closes_at,
  );
}

function matchingRule(
  rules: PricingRuleDocument[],
  timezone: string,
  startsAt: Date,
): PricingRuleDocument | undefined {
  const local = localParts(startsAt, timezone);
  return rules.find((rule) =>
    (rule.day_of_week === null || rule.day_of_week === local.day) &&
    (rule.start_time === null || rule.start_time <= local.time) &&
    (rule.end_time === null || rule.end_time > local.time));
}

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const days: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    day: days[get('weekday')] ?? 0,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function allows(
  court: CourtDocument['booking_mode'],
  contract: ContractDocument['allowed_booking_modes'],
  requested: BookingMode,
) {
  return (court === 'BOTH' || court === requested) &&
    (contract === 'BOTH' || contract === requested);
}

function bookingView(value: BookingDocument) {
  return {
    bookingId: value._id.toHexString(),
    venueId: value.venue_id.toHexString(),
    courtId: value.court_id.toHexString(),
    bookingType: value.booking_type,
    startsAt: value.starts_at.toISOString(),
    endsAt: value.ends_at.toISOString(),
    externalBookingReference: value.external_booking_reference,
    status: value.status,
    grossAmountMinor: value.gross_amount_minor,
    commissionAmountMinor: value.commission_amount_minor,
    taxAmountMinor: value.tax_amount_minor,
    venueNetAmountMinor: value.venue_net_amount_minor,
    currency: value.currency,
  };
}

function settlementView(value: SettlementDocument) {
  return {
    settlementId: value._id.toHexString(),
    periodStart: value.period_start.toISOString(),
    periodEnd: value.period_end.toISOString(),
    cycle: value.cycle,
    dueAt: value.due_at.toISOString(),
    status: value.status,
    grossAmountMinor: value.gross_amount_minor,
    commissionAmountMinor: value.commission_amount_minor,
    taxAmountMinor: value.tax_amount_minor,
    refundAmountMinor: value.refund_amount_minor,
    netAmountMinor: value.net_amount_minor,
    currency: value.currency,
    completedAt: value.completed_at?.toISOString() ?? null,
  };
}

function usageView(value: ApiUsageDailyDocument) {
  return {
    usageDate: value.usage_date.toISOString(),
    requestCount: value.request_count,
    errorCount: value.error_count,
    rateLimitedCount: value.rate_limited_count,
    p95LatencyMs: value.p95_latency_ms,
  };
}

function invoiceView(value: InvoiceDocument) {
  return {
    invoiceId: value._id.toHexString(),
    settlementId: value.settlement_id.toHexString(),
    invoiceNumber: value.invoice_number,
    type: value.type,
    subtotalMinor: value.subtotal_minor,
    taxAmountMinor: value.tax_amount_minor,
    totalMinor: value.total_minor,
    currency: value.currency,
    status: value.status,
    documentUri: value.document_uri,
    issuedAt: value.issued_at?.toISOString() ?? null,
    createdAt: value.created_at.toISOString(),
  };
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const group = result.get(key(value)) ?? [];
    group.push(value);
    result.set(key(value), group);
  }
  return result;
}

function uniqueIds(values: ObjectId[]): ObjectId[] {
  return [...new Map(values.map((value) => [value.toHexString(), value])).values()];
}

function availabilityKey(value: Record<string, unknown>): string {
  return [
    String(value.distanceMeters).padStart(12, '0'),
    value.courtId,
    value.startsAt,
    value.bookingType,
  ].join('|');
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(value?: string): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    invalid('INVALID_CURSOR');
  }
}

function instant(value: string, field: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) invalid(`INVALID_${field.toUpperCase()}`);
  return result;
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) invalid('INVALID_IDENTIFIER');
  return new ObjectId(value);
}

function invalid(code: string): never {
  throw new AppError({
    code,
    message: 'The Partner portal request is invalid',
    statusCode: 400,
  });
}

function notFound(code: string): never {
  throw new AppError({
    code,
    message: 'The requested Partner resource was not found',
    statusCode: 404,
  });
}
