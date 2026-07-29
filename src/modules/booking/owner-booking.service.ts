import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
  BookingStatus,
} from './booking.types.js';
import type { OwnerBookingRepository } from './owner-booking.repository.js';

export interface OwnerBookingView {
  id: string;
  partnerId: string;
  venueId: string;
  courtId: string;
  slotId: string;
  contractId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  externalBookingReference: string | null;
  bookingType: 'OPEN_TIME' | 'FIXED_SLOT';
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  grossAmountMinor: number;
  commissionAmountMinor: number;
  taxAmountMinor: number;
  venueNetAmountMinor: number;
  currency: 'INR';
  version: number;
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerBookingDetailView extends OwnerBookingView {
  cancellation: {
    reasonCode: string;
    reasonText: string | null;
    refundPercent: number;
    refundAmountMinor: number;
    slotDisposition: 'RELEASE_TO_INVENTORY' | 'KEEP_UNAVAILABLE';
    cancelledAt: string;
  } | null;
}

export interface OwnerBookingService {
  list(input: {
    actorOwnerId: string;
    venueId: string;
    courtId?: string;
    status?: BookingStatus;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    items: OwnerBookingView[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
  }>;
  getDetail(input: {
    actorOwnerId: string;
    venueId: string;
    bookingId: string;
  }): Promise<OwnerBookingDetailView>;
}

export function createOwnerBookingService(input: {
  repository: OwnerBookingRepository;
  ownerAccessService: OwnerAccessService;
}): OwnerBookingService {
  async function requireAccess(
    actorOwnerId: string,
    venueId: string,
  ): Promise<ObjectId> {
    await input.ownerAccessService.requirePermission(
      actorOwnerId,
      venueId,
      'VIEW_BOOKINGS',
    );
    return toObjectId(venueId);
  }

  return {
    async list(values) {
      const venueId = await requireAccess(
        values.actorOwnerId,
        values.venueId,
      );
      const from = values.from ? toDate(values.from) : undefined;
      const to = values.to ? toDate(values.to) : undefined;

      if (from && to && from >= to) {
        throw new AppError({
          code: 'INVALID_BOOKING_DATE_RANGE',
          message: 'The booking filter start must be before its end',
          statusCode: 400,
        });
      }

      const page = values.page ?? 1;
      const limit = values.limit ?? 50;
      if (!Number.isInteger(page) || page < 1) {
        throw new AppError({
          code: 'INVALID_BOOKING_PAGE',
          message: 'Booking page must be a positive integer',
          statusCode: 400,
        });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError({
          code: 'INVALID_BOOKING_LIMIT',
          message: 'Booking limit must be an integer from 1 to 100',
          statusCode: 400,
        });
      }
      const result = await input.repository.listForVenue(venueId, {
        ...(values.courtId
          ? { courtId: toObjectId(values.courtId) }
          : {}),
        ...(values.status ? { status: values.status } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        page,
        limit,
      });

      return {
        items: result.bookings.map(toView),
        pagination: {
          page,
          limit,
          total: result.total,
          pages: Math.ceil(result.total / limit),
        },
      };
    },

    async getDetail(values) {
      const venueId = await requireAccess(
        values.actorOwnerId,
        values.venueId,
      );
      const booking = await input.repository.findForVenue(
        venueId,
        toObjectId(values.bookingId),
      );

      if (!booking) {
        throw new AppError({
          code: 'BOOKING_NOT_FOUND',
          message: 'Booking was not found',
          statusCode: 404,
        });
      }

      const cancellation = await input.repository.findCancellation(
        booking._id,
      );
      return toDetailView(booking, cancellation);
    },
  };
}

function toView(booking: BookingDocument): OwnerBookingView {
  return {
    id: booking._id.toHexString(),
    partnerId: booking.partner_id.toHexString(),
    venueId: booking.venue_id.toHexString(),
    courtId: booking.court_id.toHexString(),
    slotId: booking.slot_id.toHexString(),
    contractId: booking.contract_id.toHexString(),
    environment: booking.environment,
    externalBookingReference: booking.external_booking_reference,
    bookingType: booking.booking_type,
    startsAt: booking.starts_at.toISOString(),
    endsAt: booking.ends_at.toISOString(),
    status: booking.status,
    grossAmountMinor: booking.gross_amount_minor,
    commissionAmountMinor: booking.commission_amount_minor,
    taxAmountMinor: booking.tax_amount_minor,
    venueNetAmountMinor: booking.venue_net_amount_minor,
    currency: booking.currency,
    version: booking.version,
    confirmedAt: booking.confirmed_at.toISOString(),
    createdAt: booking.created_at.toISOString(),
    updatedAt: booking.updated_at.toISOString(),
  };
}

function toDetailView(
  booking: BookingDocument,
  cancellation: BookingCancellationDocument | null,
): OwnerBookingDetailView {
  return {
    ...toView(booking),
    cancellation: cancellation
      ? {
          reasonCode: cancellation.reason_code,
          reasonText: cancellation.reason_text,
          refundPercent: cancellation.refund_percent,
          refundAmountMinor: cancellation.refund_amount_minor,
          slotDisposition: cancellation.slot_disposition,
          cancelledAt: cancellation.cancelled_at.toISOString(),
        }
      : null,
  };
}

function toDate(value: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      code: 'INVALID_BOOKING_DATE',
      message: 'Booking date filters must be valid ISO-8601 timestamps',
      statusCode: 400,
    });
  }
  return date;
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'INVALID_ID',
      message: 'A supplied identifier is invalid',
      statusCode: 400,
    });
  }
  return new ObjectId(value);
}
