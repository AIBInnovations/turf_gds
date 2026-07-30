import { ObjectId, type Document } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { AdminVenueService } from '../../venue/admin-venue.service.js';
import type { BookingDocument } from '../../booking/booking.types.js';

type Environment = 'SANDBOX' | 'PRODUCTION';
type Dimension = 'VENUE' | 'PARTNER';
interface ReportFilter {
  environment: Environment;
  from: Date;
  to: Date;
  venueId?: string;
  partnerId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface AdminEpic08Service {
  venues: AdminVenueService;
  bookingReport(input: ReportFilter): Promise<Record<string, unknown>>;
  revenueReport(input: ReportFilter & { groupBy?: 'DAY' | Dimension }): Promise<Record<string, unknown>>;
  activityReport(input: ReportFilter & { dimension: Dimension }): Promise<Record<string, unknown>>;
  exportReport(kind: 'bookings' | 'revenue' | 'activity', input: ReportFilter & {
    groupBy?: 'DAY' | Dimension;
    dimension?: Dimension;
  }): Promise<string>;
  dispute(bookingId: string, environment: Environment): Promise<Record<string, unknown>>;
  addDisputeNote(input: {
    bookingId: string;
    environment: Environment;
    adminId: string;
    expectedVersion: number;
    correlationId: string;
    note: string;
  }): Promise<{ bookingId: string; version: number }>;
  inventoryHealth(input: {
    environment?: Environment;
    venueId?: string;
    health?: 'HEALTHY' | 'STALE' | 'EMPTY' | 'DISABLED';
    page?: number;
    limit?: number;
  }): Promise<Record<string, unknown>>;
}

export function createAdminEpic08Service(input: {
  database: DatabaseConnection;
  venues: AdminVenueService;
  minimumCoverageDays: number;
  now?: () => Date;
}): AdminEpic08Service {
  const now = input.now ?? (() => new Date());
  const db = input.database.db;

  async function bookingReport(values: ReportFilter) {
    validateRange(values);
    const { page, limit } = pagination(values.page, values.limit);
    const match = bookingMatch(values);
    const [items, total, totals] = await Promise.all([
      db.collection('bookings').aggregate([
        { $match: match }, { $sort: { starts_at: -1, _id: -1 } },
        { $skip: (page - 1) * limit }, { $limit: limit },
        { $lookup: { from: 'venues', localField: 'venue_id', foreignField: '_id', as: 'venue' } },
        { $lookup: { from: 'partners', localField: 'partner_id', foreignField: '_id', as: 'partner' } },
        { $project: {
          bookingId: { $toString: '$_id' }, venueId: { $toString: '$venue_id' },
          partnerId: { $toString: '$partner_id' }, courtId: { $toString: '$court_id' },
          venueName: { $arrayElemAt: ['$venue.display_name', 0] },
          partnerName: { $arrayElemAt: ['$partner.display_name', 0] },
          environment: 1, status: 1, bookingType: '$booking_type',
          startsAt: '$starts_at', endsAt: '$ends_at',
          grossAmountMinor: '$gross_amount_minor',
          commissionAmountMinor: '$commission_amount_minor',
          taxAmountMinor: '$tax_amount_minor',
          venueNetAmountMinor: '$venue_net_amount_minor', currency: 1,
        } },
      ]).toArray(),
      db.collection('bookings').countDocuments(match),
      db.collection('bookings').aggregate([
        { $match: match }, { $group: {
          _id: null, bookings: { $sum: 1 },
          grossAmountMinor: { $sum: '$gross_amount_minor' },
          commissionAmountMinor: { $sum: '$commission_amount_minor' },
          taxAmountMinor: { $sum: '$tax_amount_minor' },
          venueNetAmountMinor: { $sum: '$venue_net_amount_minor' },
        } },
      ]).next(),
    ]);
    return { items, totals: totals ?? emptyTotals(), page, limit, total };
  }

  async function revenueReport(values: ReportFilter & { groupBy?: 'DAY' | Dimension }) {
    validateRange(values);
    const match: Document = {
      environment: values.environment,
      effective_at: { $gte: values.from, $lt: values.to },
      ...(values.venueId ? { venue_id: oid(values.venueId) } : {}),
      ...(values.partnerId ? { partner_id: oid(values.partnerId) } : {}),
    };
    const groupExpression = values.groupBy === 'DAY'
      ? { $dateToString: { format: '%Y-%m-%d', date: '$effective_at', timezone: 'UTC' } }
      : values.groupBy === 'VENUE' ? '$venue_id'
      : values.groupBy === 'PARTNER' ? '$partner_id' : null;
    const pipeline: Document[] = [{ $match: match }];
    if (values.status) {
      pipeline.push(
        { $lookup: { from: 'bookings', localField: 'booking_id', foreignField: '_id', as: 'booking' } },
        { $match: { 'booking.status': values.status } },
      );
    }
    pipeline.push({
      $set: {
        component: { $ifNull: ['$metadata.component', '$metadata.original_component'] },
        signed: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amount_minor', { $multiply: ['$amount_minor', -1] }] },
      },
    }, {
      $group: {
        _id: groupExpression,
        grossAmountMinor: { $sum: { $cond: [{ $eq: ['$component', 'GROSS'] }, { $multiply: ['$signed', -1] }, 0] } },
        commissionAmountMinor: { $sum: { $cond: [{ $eq: ['$component', 'COMMISSION'] }, '$signed', 0] } },
        taxAmountMinor: { $sum: { $cond: [{ $eq: ['$component', 'TAX'] }, '$signed', 0] } },
        venueNetAmountMinor: { $sum: { $cond: [{ $eq: ['$component', 'VENUE_NET'] }, '$signed', 0] } },
        refundAmountMinor: { $sum: { $cond: [{ $eq: ['$entry_type', 'REVERSAL'] }, '$amount_minor', 0] } },
        adjustmentAmountMinor: { $sum: { $cond: [{ $eq: ['$entry_type', 'ADJUSTMENT'] }, '$signed', 0] } },
        entryCount: { $sum: 1 },
      },
    }, { $sort: { _id: 1 } });
    const buckets = await db.collection('ledger_entries').aggregate(pipeline).toArray();
    const totals = buckets.reduce((result, row) => {
      for (const key of ['grossAmountMinor', 'commissionAmountMinor', 'taxAmountMinor', 'venueNetAmountMinor', 'refundAmountMinor', 'adjustmentAmountMinor', 'entryCount']) {
        result[key] = (result[key] ?? 0) + Number(row[key] ?? 0);
      }
      return result;
    }, {} as Record<string, number>);
    const settlementMatch = { environment: values.environment, period_start: { $lt: values.to }, period_end: { $gt: values.from }, ...(values.partnerId ? { partner_id: oid(values.partnerId) } : {}) };
    const [settlements, payouts] = await Promise.all([
      db.collection('settlements').aggregate([{ $match: settlementMatch }, { $group: { _id: '$status', count: { $sum: 1 }, amountMinor: { $sum: '$net_amount_minor' } } }, { $sort: { _id: 1 } }]).toArray(),
      db.collection('payouts').aggregate([{ $match: { environment: values.environment, created_at: { $gte: values.from, $lt: values.to }, ...(values.venueId ? { venue_id: oid(values.venueId) } : {}) } }, { $group: { _id: '$status', count: { $sum: 1 }, amountMinor: { $sum: '$amount_minor' } } }, { $sort: { _id: 1 } }]).toArray(),
    ]);
    return { totals, buckets: buckets.map((value) => ({ ...value, key: value._id?.toHexString?.() ?? value._id, _id: undefined })), settlements, payouts, currency: 'INR' };
  }

  async function activityReport(values: ReportFilter & { dimension: Dimension }) {
    validateRange(values);
    const match = bookingMatch(values);
    const field = values.dimension === 'VENUE' ? '$venue_id' : '$partner_id';
    const nameCollection = values.dimension === 'VENUE' ? 'venues' : 'partners';
    const rows = await db.collection('bookings').aggregate([
      { $match: match },
      { $group: {
        _id: field, bookingCount: { $sum: 1 },
        confirmedCount: { $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] } },
        cancelledCount: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
        grossAmountMinor: { $sum: '$gross_amount_minor' },
        lastBookingAt: { $max: '$starts_at' },
      } },
      { $lookup: { from: nameCollection, localField: '_id', foreignField: '_id', as: 'subject' } },
      { $project: { _id: 0, subjectId: { $toString: '$_id' }, name: { $arrayElemAt: ['$subject.display_name', 0] }, bookingCount: 1, confirmedCount: 1, cancelledCount: 1, grossAmountMinor: 1, lastBookingAt: 1 } },
      { $sort: { bookingCount: -1, subjectId: 1 } },
    ]).toArray();
    const { page, limit } = pagination(values.page, values.limit);
    return { items: rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length, dimension: values.dimension };
  }

  return {
    venues: input.venues,
    bookingReport,
    revenueReport,
    activityReport,
    async exportReport(kind, values) {
      let rows: Document[];
      if (kind === 'bookings') {
        rows = [];
        for (let page = 1; page <= 100; page += 1) {
          const result = await bookingReport({ ...values, page, limit: 100 });
          if (result.total > 10_000) {
            throw new AppError({ code: 'EXPORT_ROW_LIMIT_EXCEEDED', message: 'CSV export exceeds 10000 rows', statusCode: 413 });
          }
          rows.push(...result.items);
          if (rows.length >= result.total || result.items.length === 0) break;
        }
      } else if (kind === 'revenue') {
        rows = (await revenueReport(values)).buckets;
      } else {
        rows = [];
        for (let page = 1; page <= 100; page += 1) {
          const result = await activityReport({
            ...values,
            dimension: values.dimension ?? 'VENUE',
            page,
            limit: 100,
          });
          if (result.total > 10_000) {
            throw new AppError({ code: 'EXPORT_ROW_LIMIT_EXCEEDED', message: 'CSV export exceeds 10000 rows', statusCode: 413 });
          }
          rows.push(...result.items);
          if (rows.length >= result.total || result.items.length === 0) break;
        }
      }
      if (rows.length > 10_000) throw new AppError({ code: 'EXPORT_ROW_LIMIT_EXCEEDED', message: 'CSV export exceeds 10000 rows', statusCode: 413 });
      return renderAdminCsv(rows);
    },
    async dispute(bookingId, environment) {
      const id = oid(bookingId);
      const booking = await db.collection('bookings').findOne({ _id: id, environment });
      if (!booking) throw notFound('BOOKING_NOT_FOUND', 'Booking not found');
      const [cancellation, venue, court, partner, slot, ledger, outbox] = await Promise.all([
        db.collection('booking_cancellations').findOne({ booking_id: id }),
        db.collection('venues').findOne({ _id: booking.venue_id }),
        db.collection('courts').findOne({ _id: booking.court_id }),
        db.collection('partners').findOne({ _id: booking.partner_id }),
        db.collection('slots').findOne({ _id: booking.slot_id, environment }),
        db.collection('ledger_entries').find({ booking_id: id, environment }).sort({ effective_at: 1, _id: 1 }).toArray(),
        db.collection('outbox_events').find({ aggregate_type: 'BOOKING', aggregate_id: id, environment }).project({ payload: 0, webhook_endpoint_ids: 0 }).toArray(),
      ]);
      const settlementIds = [...new Map(ledger.filter((entry) => entry.settlement_id).map((entry) => [entry.settlement_id.toHexString(), entry.settlement_id])).values()];
      const settlements = settlementIds.length ? await db.collection('settlements').find({ _id: { $in: settlementIds }, environment }).toArray() : [];
      const [reconciliations, payouts] = await Promise.all([
        settlementIds.length ? db.collection('reconciliations').find({ settlement_id: { $in: settlementIds }, environment }).toArray() : [],
        settlementIds.length ? db.collection('payouts').find({ settlement_id: { $in: settlementIds }, environment }).toArray() : [],
      ]);
      return {
        booking, cancellation, venue: summary(venue), court: summary(court),
        partner: summary(partner), slot, ledgerEntries: ledger, settlements,
        reconciliations, payouts, outboxEvents: outbox,
        reconciliationIds: reconciliations.map(({ _id }) => _id.toHexString()),
      };
    },
    async addDisputeNote(values) {
      const note = values.note.trim();
      if (!note || note.length > 2_000) throw bad('INVALID_DISPUTE_NOTE', 'note must contain 1 to 2000 characters');
      const result = await db.collection<BookingDocument>('bookings').findOneAndUpdate(
        { _id: oid(values.bookingId), environment: values.environment, version: values.expectedVersion },
        {
          $inc: { version: 1 },
          $set: { updated_at: now() },
          $push: { audit_history: { $each: [{
            event_type: 'DISPUTE_NOTE_ADDED', actor_type: 'ADMIN',
            actor_id: oid(values.adminId), correlation_id: values.correlationId,
            changes: { note }, occurred_at: now(),
          }], $slice: -100 } },
        },
        { returnDocument: 'after' },
      );
      if (!result) {
        if (!await db.collection('bookings').findOne({ _id: oid(values.bookingId), environment: values.environment })) throw notFound('BOOKING_NOT_FOUND', 'Booking not found');
        throw new AppError({ code: 'BOOKING_VERSION_CONFLICT', message: 'Booking version is stale', statusCode: 409 });
      }
      return { bookingId: result._id.toHexString(), version: result.version };
    },
    async inventoryHealth(values) {
      const { page, limit } = pagination(values.page, values.limit);
      const current = now();
      const threshold = new Date(current.getTime() + input.minimumCoverageDays * 86_400_000);
      const match: Document = { ...(values.environment ? { environment: values.environment } : {}), ...(values.venueId ? { _id: oid(values.venueId) } : {}) };
      const venues = await db.collection('venues').find(match).sort({ display_name: 1, _id: 1 }).toArray();
      const rows: Document[] = [];
      for (const venue of venues) {
        const venueCourts = await db.collection('courts').find({ venue_id: venue._id }).sort({ name: 1 }).toArray();
        for (const court of venueCourts) {
          const slots = await db.collection('slots').find({ court_id: court._id, environment: venue.environment, ends_at: { $gt: current } }).toArray();
          const fixed = slots.filter((slot) => slot.booking_type === 'FIXED_SLOT');
          const coverageThrough = fixed.reduce<Date | null>((max, slot) => !max || slot.ends_at > max ? slot.ends_at : max, null);
          const counts = Object.fromEntries(['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'].map((status) => [status, slots.filter((slot) => slot.status === status).length]));
          const activeOpenTimeBlocks = slots.filter((slot) => slot.booking_type === 'OPEN_TIME' && slot.status === 'BLOCKED').length;
          const expiredHolds = await db.collection('slots').countDocuments({ court_id: court._id, environment: venue.environment, status: 'HELD', hold_expires_at: { $lte: current } });
          const health = venue.status !== 'ACTIVE' || court.status !== 'AVAILABLE' ? 'DISABLED'
            : fixed.length === 0 && ['FIXED_SLOT', 'BOTH'].includes(court.booking_mode) ? 'EMPTY'
            : ['FIXED_SLOT', 'BOTH'].includes(court.booking_mode) && (!coverageThrough || coverageThrough < threshold) ? 'STALE' : 'HEALTHY';
          rows.push({
            venueId: venue._id.toHexString(), venueName: venue.display_name,
            venueStatus: venue.status, environment: venue.environment,
            courtId: court._id.toHexString(), courtName: court.name,
            courtStatus: court.status, bookingMode: court.booking_mode, health,
            coverageThrough, latestGeneratedAt: fixed.reduce<Date | null>((max, slot) => !max || slot.created_at > max ? slot.created_at : max, null),
            statusCounts: counts, activeOpenTimeBlocks, expiredHolds,
          });
        }
      }
      const filtered = values.health ? rows.filter(({ health }) => health === values.health) : rows;
      return { items: filtered.slice((page - 1) * limit, page * limit), page, limit, total: filtered.length, minimumCoverageDays: input.minimumCoverageDays };
    },
  };
}

function validateRange(values: ReportFilter) {
  if (!(values.from instanceof Date) || Number.isNaN(values.from.valueOf()) || !(values.to instanceof Date) || Number.isNaN(values.to.valueOf()) || values.from >= values.to) throw bad('INVALID_DATE_RANGE', 'from must be earlier than to');
  if (values.to.valueOf() - values.from.valueOf() > 366 * 86_400_000) throw bad('REPORT_RANGE_TOO_LARGE', 'Report range cannot exceed 366 days');
}
function bookingMatch(values: ReportFilter): Document {
  return {
    environment: values.environment, starts_at: { $gte: values.from, $lt: values.to },
    ...(values.venueId ? { venue_id: oid(values.venueId) } : {}),
    ...(values.partnerId ? { partner_id: oid(values.partnerId) } : {}),
    ...(values.status ? { status: values.status } : {}),
  };
}
function pagination(page = 1, limit = 20) { if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('INVALID_PAGINATION', 'page and limit are out of range'); return { page, limit }; }
function oid(value: string) { if (!ObjectId.isValid(value)) throw bad('INVALID_ID', 'A supplied identifier is invalid'); return new ObjectId(value); }
function bad(code: string, message: string) { return new AppError({ code, message, statusCode: 400 }); }
function notFound(code: string, message: string) { return new AppError({ code, message, statusCode: 404 }); }
function emptyTotals() { return { bookings: 0, grossAmountMinor: 0, commissionAmountMinor: 0, taxAmountMinor: 0, venueNetAmountMinor: 0 }; }
function summary(value: Document | null) { if (!value) return null; return { id: value._id.toHexString(), displayName: value.display_name ?? value.name ?? null, status: value.status ?? null }; }
export function renderAdminCsv(rows: Document[]) {
  if (!rows.length) return '\uFEFF\r\n';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] === null || ['string', 'number', 'boolean'].includes(typeof row[key]) || row[key] instanceof Date)))];
  const cell = (value: unknown) => {
    let text = value instanceof Date ? value.toISOString() : value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${headers.map(cell).join(',')}\r\n${rows.map((row) => headers.map((header) => cell(row[header])).join(',')).join('\r\n')}\r\n`;
}
