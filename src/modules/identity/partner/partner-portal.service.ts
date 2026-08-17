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
import {
  classifyOverlap,
  queryOverlappingSlotsForCourts,
  type OverlapSlot,
} from '../../venue/inventory/slot-overlap.js';
import type { VenueDocument } from '../../venue/profile/venue.types.js';
import type {
  ApiUsageDailyDocument,
  PartnerEnvironment,
} from './partner-access.types.js';

type BookingMode = 'OPEN_TIME' | 'FIXED_SLOT';

/**
 * `truncated` is true when the page stopped at its server-side scan budget
 * before covering the whole radius. `nextCursor` is then non-null and the page
 * may hold fewer than `limit` items — keep paging.
 */
export interface AvailabilityPage {
  items: unknown[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface PartnerPortalServiceOptions {
  now?: () => Date;
  /** Venues examined per request before reporting truncation. */
  maxVenueScan?: number;
  /** Venues pulled from $geoNear per round trip. */
  venueChunkSize?: number;
  /** Upper bound on fixed slots fetched per chunk. */
  maxSlotFetch?: number;
  /** Courts examined per page of the single-venue endpoint. */
  maxCourtsPerVenue?: number;
}

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
  }): Promise<AvailabilityPage>;
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
    allocationCursor?: string;
    allocationLimit?: number;
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
  getBooking(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    bookingId: string;
  }): Promise<unknown>;
  searchVenues(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    sportType: CourtDocument['sport_type'];
    cursor?: string;
    limit?: number;
  }): Promise<AvailabilityPage>;
  getVenueAvailability(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    venueId: string;
    startsAt: string;
    endsAt: string;
    bookingType?: BookingMode;
    cursor?: string;
    limit?: number;
  }): Promise<AvailabilityPage>;
  listSettlementAllocations(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    settlementId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
}

export function createPartnerPortalService(
  db: Db,
  options: PartnerPortalServiceOptions = {},
): PartnerPortalService {
  const clock = options.now ?? (() => new Date());
  const maxVenueScan = options.maxVenueScan ?? 500;
  const venueChunkSize = options.venueChunkSize ?? 100;
  const maxSlotFetch = options.maxSlotFetch ?? 20_000;
  const maxCourtsPerVenue = options.maxCourtsPerVenue ?? 200;

  /**
   * One query for every court in the chunk, replacing a per-court findOne.
   * Classification is shared with the booking write path, so the read side
   * cannot disagree with it about what "occupied" means — in particular an
   * expired-but-unreaped hold no longer hides inventory.
   */
  async function overlapByCourt(
    courtIds: readonly ObjectId[],
    environment: PartnerEnvironment,
    startsAt: Date,
    endsAt: Date,
  ): Promise<Map<string, OverlapSlot[]>> {
    const overlapping = await queryOverlappingSlotsForCourts(db, {
      courtIds,
      environment,
      startsAt,
      endsAt,
    });
    return groupBy(overlapping, (value) => value.court_id.toHexString());
  }

  /**
   * Build every availability row for one chunk of venues.
   * Exactly five queries regardless of how many courts the chunk holds.
   */
  async function buildSearchRows(values: {
    venues: Array<VenueDocument & { distance_meters: number }>;
    partnerId: ObjectId;
    environment: PartnerEnvironment;
    sportType: CourtDocument['sport_type'];
    bookingType: BookingMode | undefined;
    startsAt: Date;
    endsAt: Date;
    durationMinutes: number;
    now: Date;
  }): Promise<AvailabilityRow[]> {
    const contracts = await db
      .collection<ContractDocument>('partner_venue_contracts')
      .find({
        partner_id: values.partnerId,
        venue_id: { $in: values.venues.map(({ _id }) => _id) },
        status: 'ACTIVE',
        effective_from: { $lte: values.startsAt },
        $or: [
          { effective_to: null },
          { effective_to: { $gt: values.startsAt } },
        ],
      })
      .sort({ effective_from: -1 })
      .toArray();
    // Keep the FIRST entry per venue. Sorted effective_from descending, that is
    // the newest in-effect contract — the same one findEffectiveContract picks
    // on the write path. `new Map(entries)` would keep the last, i.e. the
    // oldest, and quote terms the booking path would then refuse.
    const contractByVenue = new Map<string, ContractDocument>();
    for (const contract of contracts) {
      const key = contract.venue_id.toHexString();
      if (!contractByVenue.has(key)) contractByVenue.set(key, contract);
    }

    const eligible = values.venues.filter((value) =>
      contractByVenue.has(value._id.toHexString()),
    );
    if (eligible.length === 0) return [];

    const courts = await db
      .collection<CourtDocument>('courts')
      .find({
        venue_id: { $in: eligible.map(({ _id }) => _id) },
        status: 'AVAILABLE',
        sport_type: values.sportType,
        ...(values.bookingType
          ? { booking_mode: { $in: [values.bookingType, 'BOTH'] } }
          : {}),
      })
      .toArray();
    const courtIds = courts.map(({ _id }) => _id);
    if (courtIds.length === 0) return [];

    const fixedSlots = await db
      .collection<SlotDocument>('slots')
      .find({
        court_id: { $in: courtIds },
        environment: values.environment,
        booking_type: 'FIXED_SLOT',
        status: 'AVAILABLE',
        starts_at: { $gte: values.startsAt },
        ends_at: { $lte: values.endsAt },
      })
      .sort({ starts_at: 1, _id: 1 })
      .limit(maxSlotFetch)
      .toArray();

    const pricingRules = await db
      .collection<PricingRuleDocument>('pricing_rules')
      .find({
        court_id: { $in: courtIds },
        active: true,
        effective_from: { $lte: values.startsAt },
        $or: [
          { effective_to: null },
          { effective_to: { $gt: values.startsAt } },
        ],
      })
      .sort({ priority: -1, created_at: 1 })
      .toArray();

    const overlap = await overlapByCourt(
      courtIds,
      values.environment,
      values.startsAt,
      values.endsAt,
    );
    const venueById = new Map(
      eligible.map((value) => [value._id.toHexString(), value]),
    );
    const fixedByCourt = groupBy(fixedSlots, (value) =>
      value.court_id.toHexString(),
    );
    const rulesByCourt = groupBy(pricingRules, (value) =>
      value.court_id.toHexString(),
    );
    const rows: AvailabilityRow[] = [];

    for (const court of courts) {
      const venue = venueById.get(court.venue_id.toHexString());
      const contract = contractByVenue.get(court.venue_id.toHexString());
      if (!venue || !contract) continue;
      const base = {
        venueId: venue._id.toHexString(),
        venueName: venue.display_name,
        address: venue.address,
        distanceMeters: Math.round(venue.distance_meters),
        courtId: court._id.toHexString(),
        courtName: court.name,
        sportType: court.sport_type,
        contractId: contract._id.toHexString(),
        currency: 'INR',
      };

      if (
        values.bookingType !== 'OPEN_TIME' &&
        allows(court.booking_mode, contract.allowed_booking_modes, 'FIXED_SLOT')
      ) {
        for (const slot of fixedByCourt.get(court._id.toHexString()) ?? []) {
          if (fixedSlotBlocked(overlap, slot, values.now)) continue;
          rows.push({
            rawDistanceMeters: venue.distance_meters,
            courtId: base.courtId,
            startsAt: slot.starts_at.toISOString(),
            bookingType: 'FIXED_SLOT',
            availabilityId: slot._id.toHexString(),
            wire: {
              ...base,
              availabilityId: slot._id.toHexString(),
              bookingType: 'FIXED_SLOT',
              startsAt: slot.starts_at.toISOString(),
              endsAt: slot.ends_at.toISOString(),
              priceMinor: slot.price_minor,
            },
          });
        }
      }

      if (
        values.bookingType !== 'FIXED_SLOT' &&
        allows(
          court.booking_mode,
          contract.allowed_booking_modes,
          'OPEN_TIME',
        ) &&
        values.durationMinutes >= court.min_booking_minutes &&
        values.durationMinutes % court.booking_increment_minutes === 0 &&
        insideOperatingHours(
          court,
          venue.timezone,
          values.startsAt,
          values.endsAt,
        ) &&
        !openTimeBlocked(overlap, court._id, values.now)
      ) {
        const rule = matchingRule(
          rulesByCourt.get(court._id.toHexString()) ?? [],
          venue.timezone,
          values.startsAt,
        );
        if (rule) {
          rows.push({
            rawDistanceMeters: venue.distance_meters,
            courtId: base.courtId,
            startsAt: values.startsAt.toISOString(),
            bookingType: 'OPEN_TIME',
            availabilityId: null,
            wire: {
              ...base,
              availabilityId: null,
              bookingType: 'OPEN_TIME',
              startsAt: values.startsAt.toISOString(),
              endsAt: values.endsAt.toISOString(),
              priceMinor: Math.round(
                (rule.price_minor * values.durationMinutes) / 60,
              ),
            },
          });
        }
      }
    }

    return rows;
  }

  /** Is this court's open-time interval occupied by something that blocks? */
  function openTimeBlocked(
    overlap: Map<string, OverlapSlot[]>,
    courtId: ObjectId,
    now: Date,
  ): boolean {
    return (
      classifyOverlap({
        slots: overlap.get(courtId.toHexString()) ?? [],
        now,
        perspective: 'OPEN_TIME',
      }).blocking.length > 0
    );
  }

  /**
   * A generated fixed slot is only sellable if nothing blocks its own interval.
   * Belt-and-braces on top of consumption: it also covers connector-created
   * open-time slots and any grid predating the repair script.
   */
  function fixedSlotBlocked(
    overlap: Map<string, OverlapSlot[]>,
    slot: SlotDocument | OverlapSlot,
    now: Date,
  ): boolean {
    const candidates = (overlap.get(slot.court_id.toHexString()) ?? []).filter(
      (value) =>
        value.starts_at < slot.ends_at && value.ends_at > slot.starts_at,
    );
    return (
      classifyOverlap({
        slots: candidates,
        now,
        perspective: 'FIXED_SLOT',
        excludeSlotId: slot._id,
      }).blocking.length > 0
    );
  }

  return {
    async searchAvailability(input) {
      const startsAt = instant(input.startsAt, 'startsAt');
      const endsAt = instant(input.endsAt, 'endsAt');
      if (startsAt >= endsAt) invalid('INVALID_AVAILABILITY_RANGE');
      const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
      if (durationMinutes > 24 * 60) invalid('AVAILABILITY_RANGE_TOO_LARGE');
      const limit = boundedLimit(input.limit);
      const partnerId = oid(input.partnerId);
      const now = clock();
      const cursor = decodeAvailabilityCursor(input.cursor);

      // $geoNear streams in ascending distance and honours minDistance, so the
      // leading sort component is a real index-level seek rather than an
      // in-memory skip. That is what stops page N costing as much as page 1.
      const aggregation = db
        .collection<VenueDocument>('venues')
        .aggregate<VenueDocument & { distance_meters: number }>(
          [
            {
              $geoNear: {
                near: {
                  type: 'Point',
                  coordinates: [input.longitude, input.latitude],
                },
                distanceField: 'distance_meters',
                maxDistance: input.radiusMeters,
                // 1mm of slack absorbs float round-tripping through the cursor;
                // minDistance is inclusive so nothing at the boundary is skipped.
                ...(cursor
                  ? { minDistance: Math.max(0, cursor.d - 0.001) }
                  : {}),
                spherical: true,
                query: { environment: input.environment, status: 'ACTIVE' },
              },
            },
          ],
          { batchSize: venueChunkSize },
        );

      const kept: AvailabilityRow[] = [];
      let scanned = 0;
      let exhausted = false;
      let lastVenueDistance = cursor?.d ?? 0;

      try {
        while (scanned < maxVenueScan) {
          const chunk = await take(
            aggregation,
            Math.min(venueChunkSize, maxVenueScan - scanned),
          );
          if (chunk.length === 0) {
            exhausted = true;
            break;
          }
          scanned += chunk.length;
          lastVenueDistance = chunk[chunk.length - 1]!.distance_meters;

          for (const row of await buildSearchRows({
            venues: chunk,
            partnerId,
            environment: input.environment,
            sportType: input.sportType,
            bookingType: input.bookingType,
            startsAt,
            endsAt,
            durationMinutes,
            now,
          })) {
            if (!cursor || compareAvailability(row, cursor) > 0) kept.push(row);
          }
          kept.sort(compareRows);
          if (kept.length > limit + 1) kept.length = limit + 1;
          // Every remaining venue is at least this far away, so none of them
          // can sort ahead of the row that already occupies position limit+1.
          if (
            kept.length > limit &&
            lastVenueDistance > kept[limit]!.rawDistanceMeters
          ) {
            break;
          }
        }
      } finally {
        await aggregation.close();
      }

      const hasMore = kept.length > limit;
      const page = kept.slice(0, limit);
      const truncated = !exhausted && !hasMore;
      let nextCursor: string | null = null;
      if (hasMore && page.length > 0) {
        nextCursor = encodeAvailabilityCursor(
          availabilityCursorOf(page[page.length - 1]!),
        );
      } else if (truncated) {
        nextCursor = encodeAvailabilityCursor(
          page.length > 0
            ? availabilityCursorOf(page[page.length - 1]!)
            : {
                // Guarantee forward progress even when a whole budget produced
                // nothing and every venue sat at one exact distance.
                d:
                  cursor && lastVenueDistance === cursor.d
                    ? lastVenueDistance + 0.001
                    : lastVenueDistance,
              },
        );
      }
      return { items: page.map((row) => row.wire), nextCursor, truncated };
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
      if (input.from || input.to)
        query.starts_at = dateRange(input.from, input.to);
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
      const settlement = await db
        .collection<SettlementDocument>('settlements')
        .findOne({
          _id: oid(input.settlementId),
          partner_id: oid(input.partnerId),
          environment: input.environment,
        });
      if (!settlement) notFound('SETTLEMENT_NOT_FOUND');
      // Allocations are paged. A settlement can cover thousands of bookings,
      // and the previous unbounded read also drove the statement PDF, which
      // serialises them onto a single line.
      const allocations = await allocationPage({
        settlement: settlement!,
        cursor: input.allocationCursor,
        limit: boundedLimit(input.allocationLimit),
      });
      return {
        ...settlementView(settlement!),
        allocations: allocations.items,
        allocationsNextCursor: allocations.nextCursor,
      };
    },

    async listInvoices(input) {
      // partner_id is denormalised onto invoices, so this no longer has to
      // load every settlement id the Partner has ever had into memory.
      return listByCursor(
        db.collection<InvoiceDocument>('invoices'),
        scopedQuery(input),
        input.cursor,
        input.limit,
        invoiceView,
      );
    },

    async getInvoice(input) {
      const invoice = await db.collection<InvoiceDocument>('invoices').findOne({
        _id: oid(input.invoiceId),
        partner_id: oid(input.partnerId),
        environment: input.environment,
      });
      // Same code for "missing" and "not yours" so invoice ids stay
      // non-enumerable.
      if (!invoice) notFound('INVOICE_NOT_FOUND');
      return invoiceView(invoice!);
    },

    async getBooking(input) {
      const booking = await db.collection<BookingDocument>('bookings').findOne({
        _id: oid(input.bookingId),
        partner_id: oid(input.partnerId),
        environment: input.environment,
      });
      if (!booking) notFound('BOOKING_NOT_FOUND');
      return bookingView(booking!);
    },

    async searchVenues(input) {
      const limit = boundedLimit(input.limit);
      const partnerId = oid(input.partnerId);
      const now = clock();
      const cursor = decodeVenueCursor(input.cursor);

      const aggregation = db
        .collection<VenueDocument>('venues')
        .aggregate<VenueDocument & { distance_meters: number }>(
          [
            {
              $geoNear: {
                near: {
                  type: 'Point',
                  coordinates: [input.longitude, input.latitude],
                },
                distanceField: 'distance_meters',
                maxDistance: input.radiusMeters,
                ...(cursor
                  ? { minDistance: Math.max(0, cursor.d - 0.001) }
                  : {}),
                spherical: true,
                query: { environment: input.environment, status: 'ACTIVE' },
              },
            },
          ],
          { batchSize: venueChunkSize },
        );

      const kept: Array<{
        rawDistanceMeters: number;
        venueId: string;
        wire: Record<string, unknown>;
      }> = [];
      let scanned = 0;
      let exhausted = false;
      let lastVenueDistance = cursor?.d ?? 0;

      try {
        while (scanned < maxVenueScan) {
          const chunk = await take(
            aggregation,
            Math.min(venueChunkSize, maxVenueScan - scanned),
          );
          if (chunk.length === 0) {
            exhausted = true;
            break;
          }
          scanned += chunk.length;
          lastVenueDistance = chunk[chunk.length - 1]!.distance_meters;

          // Same effective-date window as /availability. Without it this
          // endpoint advertised venues whose contract had expired or had not
          // started, which then returned no availability at all.
          const contracts = await db
            .collection<ContractDocument>('partner_venue_contracts')
            .find({
              partner_id: partnerId,
              venue_id: { $in: chunk.map(({ _id }) => _id) },
              status: 'ACTIVE',
              effective_from: { $lte: now },
              $or: [{ effective_to: null }, { effective_to: { $gt: now } }],
            })
            .toArray();
          const contracted = new Set(
            contracts.map((value) => value.venue_id.toHexString()),
          );
          const eligible = chunk.filter((value) =>
            contracted.has(value._id.toHexString()),
          );
          if (eligible.length > 0) {
            const courts = await db
              .collection<CourtDocument>('courts')
              .find({
                venue_id: { $in: eligible.map(({ _id }) => _id) },
                status: 'AVAILABLE',
                sport_type: input.sportType,
              })
              .toArray();
            const countByVenue = new Map<string, number>();
            for (const court of courts) {
              const key = court.venue_id.toHexString();
              countByVenue.set(key, (countByVenue.get(key) ?? 0) + 1);
            }
            for (const venue of eligible) {
              const key = venue._id.toHexString();
              const courtCount = countByVenue.get(key) ?? 0;
              if (courtCount === 0) continue;
              const row = {
                rawDistanceMeters: venue.distance_meters,
                venueId: key,
                wire: {
                  venueId: key,
                  legalName: venue.legal_name,
                  displayName: venue.display_name,
                  address: venue.address,
                  timezone: venue.timezone,
                  distanceMeters: Math.round(venue.distance_meters),
                  courtCount,
                  currency: venue.currency,
                },
              };
              if (!cursor || compareVenue(row, cursor) > 0) kept.push(row);
            }
          }

          kept.sort((left, right) =>
            compareVenue(left, {
              d: right.rawDistanceMeters,
              v: right.venueId,
            }),
          );
          if (kept.length > limit + 1) kept.length = limit + 1;
          if (
            kept.length > limit &&
            lastVenueDistance > kept[limit]!.rawDistanceMeters
          ) {
            break;
          }
        }
      } finally {
        await aggregation.close();
      }

      const hasMore = kept.length > limit;
      const page = kept.slice(0, limit);
      const truncated = !exhausted && !hasMore;
      let nextCursor: string | null = null;
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]!;
        nextCursor = encodeVenueCursor({
          d: last.rawDistanceMeters,
          v: last.venueId,
        });
      } else if (truncated) {
        const last = page[page.length - 1];
        nextCursor = encodeVenueCursor(
          last
            ? { d: last.rawDistanceMeters, v: last.venueId }
            : {
                d:
                  cursor && lastVenueDistance === cursor.d
                    ? lastVenueDistance + 0.001
                    : lastVenueDistance,
              },
        );
      }
      return { items: page.map((row) => row.wire), nextCursor, truncated };
    },

    async getVenueAvailability(input) {
      const startsAt = instant(input.startsAt, 'startsAt');
      const endsAt = instant(input.endsAt, 'endsAt');
      if (startsAt >= endsAt) invalid('INVALID_AVAILABILITY_RANGE');
      const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
      if (durationMinutes > 24 * 60) invalid('AVAILABILITY_RANGE_TOO_LARGE');
      const limit = boundedLimit(input.limit);
      const partnerId = oid(input.partnerId);
      const venueId = oid(input.venueId);
      const now = clock();
      const cursor = decodeAvailabilityCursor(input.cursor);

      const venue = await db.collection<VenueDocument>('venues').findOne({
        _id: venueId,
        environment: input.environment,
        status: 'ACTIVE',
      });
      if (!venue) notFound('VENUE_NOT_FOUND');

      const contract = await db
        .collection<ContractDocument>('partner_venue_contracts')
        .findOne({
          partner_id: partnerId,
          venue_id: venueId,
          status: 'ACTIVE',
          effective_from: { $lte: startsAt },
          $or: [{ effective_to: null }, { effective_to: { $gt: startsAt } }],
        });
      if (!contract) notFound('CONTRACT_NOT_FOUND');

      // _id-ordered with the cursor pushed down. The previous implementation
      // never sorted at all, so a cursor built from one court silently dropped
      // every row of any court the driver happened to return later.
      const courts = await db
        .collection<CourtDocument>('courts')
        .find({
          venue_id: venueId,
          status: 'AVAILABLE',
          ...(cursor?.c ? { _id: { $gte: oid(cursor.c) } } : {}),
          ...(input.bookingType
            ? { booking_mode: { $in: [input.bookingType, 'BOTH'] } }
            : {}),
        })
        .sort({ _id: 1 })
        .limit(maxCourtsPerVenue)
        .toArray();
      const courtIds = courts.map(({ _id }) => _id);

      const fixedSlots = courtIds.length
        ? await db
            .collection<SlotDocument>('slots')
            .find({
              court_id: { $in: courtIds },
              environment: input.environment,
              booking_type: 'FIXED_SLOT',
              status: 'AVAILABLE',
              starts_at: { $gte: startsAt },
              ends_at: { $lte: endsAt },
            })
            .sort({ starts_at: 1, _id: 1 })
            .limit(maxSlotFetch)
            .toArray()
        : [];
      const pricingRules = courtIds.length
        ? await db
            .collection<PricingRuleDocument>('pricing_rules')
            .find({
              court_id: { $in: courtIds },
              active: true,
              effective_from: { $lte: startsAt },
              $or: [
                { effective_to: null },
                { effective_to: { $gt: startsAt } },
              ],
            })
            .sort({ priority: -1, created_at: 1 })
            .toArray()
        : [];

      const overlap = await overlapByCourt(
        courtIds,
        input.environment,
        startsAt,
        endsAt,
      );
      const fixedByCourt = groupBy(fixedSlots, (s) => s.court_id.toHexString());
      const rulesByCourt = groupBy(pricingRules, (r) =>
        r.court_id.toHexString(),
      );
      const rows: AvailabilityRow[] = [];

      for (const court of courts) {
        const base = {
          venueId: venue!._id.toHexString(),
          courtId: court._id.toHexString(),
          courtName: court.name,
          sportType: court.sport_type,
          contractId: contract!._id.toHexString(),
          currency: 'INR',
        };
        if (
          input.bookingType !== 'OPEN_TIME' &&
          allows(
            court.booking_mode,
            contract!.allowed_booking_modes,
            'FIXED_SLOT',
          )
        ) {
          for (const slot of fixedByCourt.get(court._id.toHexString()) ?? []) {
            if (fixedSlotBlocked(overlap, slot, now)) continue;
            rows.push({
              rawDistanceMeters: 0,
              courtId: base.courtId,
              startsAt: slot.starts_at.toISOString(),
              bookingType: 'FIXED_SLOT',
              availabilityId: slot._id.toHexString(),
              wire: {
                ...base,
                availabilityId: slot._id.toHexString(),
                bookingType: 'FIXED_SLOT',
                startsAt: slot.starts_at.toISOString(),
                endsAt: slot.ends_at.toISOString(),
                priceMinor: slot.price_minor,
              },
            });
          }
        }
        if (
          input.bookingType !== 'FIXED_SLOT' &&
          allows(
            court.booking_mode,
            contract!.allowed_booking_modes,
            'OPEN_TIME',
          ) &&
          durationMinutes >= court.min_booking_minutes &&
          durationMinutes % court.booking_increment_minutes === 0 &&
          insideOperatingHours(court, venue!.timezone, startsAt, endsAt) &&
          !openTimeBlocked(overlap, court._id, now)
        ) {
          const rule = matchingRule(
            rulesByCourt.get(court._id.toHexString()) ?? [],
            venue!.timezone,
            startsAt,
          );
          if (rule) {
            rows.push({
              rawDistanceMeters: 0,
              courtId: base.courtId,
              startsAt: startsAt.toISOString(),
              bookingType: 'OPEN_TIME',
              availabilityId: null,
              wire: {
                ...base,
                availabilityId: null,
                bookingType: 'OPEN_TIME',
                startsAt: startsAt.toISOString(),
                endsAt: endsAt.toISOString(),
                priceMinor: Math.round(
                  (rule.price_minor * durationMinutes) / 60,
                ),
              },
            });
          }
        }
      }

      rows.sort(compareRows);
      const filtered = cursor
        ? rows.filter((row) => compareAvailability(row, cursor) > 0)
        : rows;
      const page = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const truncated =
        courts.length === maxCourtsPerVenue ||
        fixedSlots.length === maxSlotFetch;
      return {
        items: page.map((row) => row.wire),
        nextCursor:
          (hasMore || truncated) && page.length > 0
            ? encodeAvailabilityCursor(
                availabilityCursorOf(page[page.length - 1]!),
              )
            : null,
        truncated,
      };
    },

    async listSettlementAllocations(input) {
      const settlement = await db
        .collection<SettlementDocument>('settlements')
        .findOne({
          _id: oid(input.settlementId),
          partner_id: oid(input.partnerId),
          environment: input.environment,
        });
      if (!settlement) notFound('SETTLEMENT_NOT_FOUND');
      return allocationPage({
        settlement: settlement!,
        cursor: input.cursor,
        limit: boundedLimit(input.limit),
      });
    },
  };

  /**
   * Keyset page of the bookings a settlement allocated, newest booking first.
   *
   * Ledger entries are read in booking_id order and de-duplicated, because a
   * booking contributes up to three entries (BOOKING, COMMISSION, TAX). The
   * over-fetch factor makes one round trip enough in the common case; the loop
   * covers settlements with unusually many entries per booking.
   */
  async function allocationPage(values: {
    settlement: SettlementDocument;
    cursor: string | undefined;
    limit: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const entries = db.collection<LedgerEntryDocument>('ledger_entries');
    const wanted = values.limit + 1;
    const seen = new Map<string, ObjectId>();
    let bound = values.cursor ? oid(values.cursor) : null;

    while (seen.size < wanted) {
      const batch = await entries
        .find({
          settlement_id: values.settlement._id,
          partner_id: values.settlement.partner_id,
          environment: values.settlement.environment,
          ...(bound ? { booking_id: { $lt: bound } } : {}),
        })
        .sort({ booking_id: -1 })
        .project<{ booking_id: ObjectId }>({ booking_id: 1 })
        .limit(wanted * 4)
        .toArray();
      if (batch.length === 0) break;
      for (const entry of batch) {
        if (seen.size >= wanted) break;
        seen.set(entry.booking_id.toHexString(), entry.booking_id);
      }
      bound = batch[batch.length - 1]!.booking_id;
      if (batch.length < wanted * 4) break;
    }

    const ordered = [...seen.values()];
    const hasMore = ordered.length > values.limit;
    const pageIds = ordered.slice(0, values.limit);
    if (pageIds.length === 0) return { items: [], nextCursor: null };

    const bookings = await db
      .collection<BookingDocument>('bookings')
      .find({
        _id: { $in: pageIds },
        partner_id: values.settlement.partner_id,
        environment: values.settlement.environment,
      })
      .toArray();
    const byId = new Map(
      bookings.map((value) => [value._id.toHexString(), value]),
    );
    const items = pageIds
      .map((id) => byId.get(id.toHexString()))
      .filter((value): value is BookingDocument => value !== undefined)
      .map(bookingView);

    return {
      items,
      nextCursor: hasMore ? pageIds[pageIds.length - 1]!.toHexString() : null,
    };
  }
}

/** Pull up to `count` documents from an open aggregation cursor. */
async function take<T>(
  cursor: import('mongodb').AggregationCursor<T>,
  count: number,
): Promise<T[]> {
  const values: T[] = [];
  while (values.length < count && (await cursor.hasNext())) {
    const value = await cursor.next();
    if (value === null) break;
    values.push(value);
  }
  return values;
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
  const values = await collection
    .find(query as never)
    .sort({ _id: -1 })
    .limit(limit + 1)
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
    hours && start.time >= hours.opens_at && end.time <= hours.closes_at,
  );
}

function matchingRule(
  rules: PricingRuleDocument[],
  timezone: string,
  startsAt: Date,
): PricingRuleDocument | undefined {
  const local = localParts(startsAt, timezone);
  return rules.find(
    (rule) =>
      (rule.day_of_week === null || rule.day_of_week === local.day) &&
      (rule.start_time === null || rule.start_time <= local.time) &&
      (rule.end_time === null || rule.end_time > local.time),
  );
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
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
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
  return (
    (court === 'BOTH' || court === requested) &&
    (contract === 'BOTH' || contract === requested)
  );
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

/**
 * A row of the availability result set, plus the raw values its sort key needs.
 * `wire` is the object returned to the Partner and is never reshaped here.
 */
interface AvailabilitySortKey {
  /** Unrounded $geoNear distance. 0 for the single-venue endpoint. */
  rawDistanceMeters: number;
  courtId: string;
  startsAt: string;
  bookingType: BookingMode;
  availabilityId: string | null;
}

interface AvailabilityRow extends AvailabilitySortKey {
  wire: Record<string, unknown>;
}

/**
 * Opaque pagination position. `c` absent marks a scan-resume cursor: it sorts
 * before every row at the same distance, so it resumes a page that exhausted
 * its venue-scan budget without emitting anything.
 */
interface AvailabilityCursor {
  d: number;
  c?: string;
  s?: string;
  b?: BookingMode;
  a?: string | null;
}

const BOOKING_MODE_ORDER: Record<BookingMode, number> = {
  FIXED_SLOT: 0,
  OPEN_TIME: 1,
};

function compareStrings(left: string, right: string): number {
  // Code-unit comparison, deliberately not localeCompare: the cursor filter
  // compares with < / >, and ICU collation does not agree with those.
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Strict total order over availability rows.
 *
 * Every component is needed. `availabilityId` in particular: two AVAILABLE
 * fixed slots on one court may share `starts_at` with different `ends_at`
 * (uq_slots_court_mode_interval permits it), and without the id they produce
 * identical keys, so the strictly-greater page filter drops one of them.
 */
export function compareAvailability(
  left: AvailabilitySortKey,
  right: AvailabilityCursor,
): number {
  if (left.rawDistanceMeters !== right.d) {
    return left.rawDistanceMeters < right.d ? -1 : 1;
  }
  if (right.c === undefined) return 1; // scan-resume cursor sorts first
  const byCourt = compareStrings(left.courtId, right.c);
  if (byCourt !== 0) return byCourt;
  const byStart = compareStrings(left.startsAt, right.s ?? '');
  if (byStart !== 0) return byStart;
  const byMode =
    BOOKING_MODE_ORDER[left.bookingType] -
    BOOKING_MODE_ORDER[right.b ?? 'FIXED_SLOT'];
  if (byMode !== 0) return byMode < 0 ? -1 : 1;
  return compareStrings(left.availabilityId ?? '', right.a ?? '');
}

function compareRows(left: AvailabilityRow, right: AvailabilityRow): number {
  return compareAvailability(left, availabilityCursorOf(right));
}

export function availabilityCursorOf(
  row: AvailabilitySortKey,
): AvailabilityCursor {
  return {
    d: row.rawDistanceMeters,
    c: row.courtId,
    s: row.startsAt,
    b: row.bookingType,
    ...(row.availabilityId !== null ? { a: row.availabilityId } : {}),
  };
}

export function encodeAvailabilityCursor(value: AvailabilityCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const LEGACY_CURSOR =
  /^(\d{12})\|([a-fA-F0-9]{24})\|(.+)\|(FIXED_SLOT|OPEN_TIME)$/;

export function decodeAvailabilityCursor(
  value?: string,
): AvailabilityCursor | null {
  if (!value) return null;
  // Buffer.from(..., 'base64url') never throws; it drops invalid characters.
  // Validation therefore has to happen on the decoded text.
  const text = Buffer.from(value, 'base64url').toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Cursors issued before the total-order fix used a pipe-delimited form.
    // Accept them for one release so in-flight pagination survives deploy.
    const legacy = LEGACY_CURSOR.exec(text);
    if (!legacy) invalid('INVALID_CURSOR');
    return {
      d: Number(legacy![1]),
      c: legacy![2]!,
      s: legacy![3]!,
      b: legacy![4] as BookingMode,
    };
  }

  if (!parsed || typeof parsed !== 'object') invalid('INVALID_CURSOR');
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.d !== 'number' || !Number.isFinite(candidate.d)) {
    invalid('INVALID_CURSOR');
  }
  if (candidate.c !== undefined && typeof candidate.c !== 'string') {
    invalid('INVALID_CURSOR');
  }
  if (candidate.s !== undefined && typeof candidate.s !== 'string') {
    invalid('INVALID_CURSOR');
  }
  if (
    candidate.b !== undefined &&
    candidate.b !== 'FIXED_SLOT' &&
    candidate.b !== 'OPEN_TIME'
  ) {
    invalid('INVALID_CURSOR');
  }
  if (
    candidate.a !== undefined &&
    candidate.a !== null &&
    typeof candidate.a !== 'string'
  ) {
    invalid('INVALID_CURSOR');
  }
  return {
    d: candidate.d as number,
    ...(candidate.c !== undefined ? { c: candidate.c as string } : {}),
    ...(candidate.s !== undefined ? { s: candidate.s as string } : {}),
    ...(candidate.b !== undefined ? { b: candidate.b as BookingMode } : {}),
    ...(candidate.a !== undefined ? { a: candidate.a as string | null } : {}),
  };
}

interface VenueCursor {
  d: number;
  v?: string;
}

function compareVenue(
  left: { rawDistanceMeters: number; venueId: string },
  right: VenueCursor,
): number {
  if (left.rawDistanceMeters !== right.d) {
    return left.rawDistanceMeters < right.d ? -1 : 1;
  }
  if (right.v === undefined) return 1;
  return compareStrings(left.venueId, right.v);
}

function encodeVenueCursor(value: VenueCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeVenueCursor(value?: string): VenueCursor | null {
  if (!value) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const legacy = /^(\d{12})\|([a-fA-F0-9]{24})$/.exec(text);
    if (!legacy) invalid('INVALID_CURSOR');
    return { d: Number(legacy![1]), v: legacy![2]! };
  }
  if (!parsed || typeof parsed !== 'object') invalid('INVALID_CURSOR');
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.d !== 'number' || !Number.isFinite(candidate.d)) {
    invalid('INVALID_CURSOR');
  }
  if (candidate.v !== undefined && typeof candidate.v !== 'string') {
    invalid('INVALID_CURSOR');
  }
  return {
    d: candidate.d as number,
    ...(candidate.v !== undefined ? { v: candidate.v as string } : {}),
  };
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
