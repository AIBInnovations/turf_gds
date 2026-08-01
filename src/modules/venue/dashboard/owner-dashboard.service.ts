import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { BookingDocument } from '../../booking/booking.types.js';
import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import type { VenueOwnerDocument } from '../../identity/owner/owner.types.js';
import type { PayoutDocument } from '../../financial-close/financial-close.types.js';
import type { SlotDocument } from '../inventory/inventory.types.js';
import type { CourtDocument } from '../courts/court.types.js';

export interface OwnerDashboardService {
  get(input: { actorOwnerId: string; venueId: string; from?: string; to?: string }): Promise<Record<string, unknown>>;
}

export function createOwnerDashboardService(input: {
  database: DatabaseConnection;
  ownerAccessService: OwnerAccessService;
  now?: () => Date;
}): OwnerDashboardService {
  const now = input.now ?? (() => new Date());
  return {
    async get(values) {
      await input.ownerAccessService.requirePermission(values.actorOwnerId, values.venueId, 'VIEW_BOOKINGS');
      const venueId = oid(values.venueId);
      const ownerId = oid(values.actorOwnerId);
      const start = values.from ? instant(values.from) : startUtcDay(now());
      const end = values.to ? instant(values.to) : new Date(start.getTime() + 86_400_000);
      if (start >= end || end.getTime() - start.getTime() > 31 * 86_400_000) {
        throw new AppError({ code: 'INVALID_DASHBOARD_RANGE', message: 'Dashboard range must be positive and no longer than 31 days', statusCode: 400 });
      }
      const db = input.database.db;
      const [bookings, upcoming, courts, slots, payouts, owner] = await Promise.all([
        db.collection<BookingDocument>('bookings').find({ venue_id: venueId, starts_at: { $gte: start, $lt: end } }).toArray(),
        db.collection<BookingDocument>('bookings').find({ venue_id: venueId, status: 'CONFIRMED', starts_at: { $gte: now() } }).sort({ starts_at: 1 }).limit(10).toArray(),
        db.collection<CourtDocument>('courts').find({ venue_id: venueId }).toArray(),
        db.collection<SlotDocument>('slots').find({ venue_id: venueId, starts_at: { $gte: start, $lt: end } }).toArray(),
        db.collection<PayoutDocument>('payouts').find({ venue_id: venueId }).sort({ created_at: -1 }).limit(10).toArray(),
        db.collection<VenueOwnerDocument>('venue_owners').findOne({ _id: ownerId }),
      ]);
      const confirmed = bookings.filter((value) => value.status === 'CONFIRMED');
      const available = slots.filter((value) => value.status === 'AVAILABLE').length;
      const occupied = slots.filter((value) => ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'].includes(value.status)).length;
      const notifications = (owner?.notifications ?? []) as Array<{ venue_id?: ObjectId; read_at?: Date | null }>;
      return {
        venueId: values.venueId,
        range: { from: start.toISOString(), to: end.toISOString() },
        bookings: {
          total: bookings.length,
          confirmed: confirmed.length,
          cancelled: bookings.filter((value) => value.status === 'CANCELLED').length,
          direct: bookings.filter((value) => value.booking_type === 'DIRECT').length,
          grossAmountMinor: confirmed.reduce((sum, value) => sum + value.gross_amount_minor, 0),
          venueNetAmountMinor: confirmed.reduce((sum, value) => sum + value.venue_net_amount_minor, 0),
          currency: 'INR',
        },
        inventory: { available, occupied, total: slots.length, occupancyPercent: slots.length ? Math.round((occupied / slots.length) * 10_000) / 100 : 0 },
        courts: { total: courts.length, available: courts.filter((value) => value.status === 'AVAILABLE').length, unavailable: courts.filter((value) => value.status === 'UNAVAILABLE').length },
        notifications: { unread: notifications.filter((value) => value.venue_id?.equals(venueId) && !value.read_at).length },
        upcomingBookings: upcoming.map((value) => ({ bookingId: value._id.toHexString(), courtId: value.court_id.toHexString(), bookingType: value.booking_type, customerReference: value.customer_reference, startsAt: value.starts_at.toISOString(), endsAt: value.ends_at.toISOString(), status: value.status })),
        recentPayouts: payouts.map((value) => ({ payoutId: value._id.toHexString(), settlementId: value.settlement_id.toHexString(), amountMinor: value.amount_minor, currency: value.currency, status: value.status, paidAt: value.paid_at?.toISOString() ?? null })),
        generatedAt: now().toISOString(),
      };
    },
  };
}
function oid(value: string) { if (!ObjectId.isValid(value)) throw new AppError({ code: 'INVALID_ID', message: 'Identifier is invalid', statusCode: 400 }); return new ObjectId(value); }
function instant(value: string) { const result = new Date(value); if (Number.isNaN(result.getTime())) throw new AppError({ code: 'INVALID_DATE', message: 'Dashboard dates must be ISO date-times', statusCode: 400 }); return result; }
function startUtcDay(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
