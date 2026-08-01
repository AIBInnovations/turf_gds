import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { CourtDocument } from '../venue/courts/court.types.js';
import type { SlotDocument } from '../venue/inventory/inventory.types.js';
import type { VenueDocument } from '../venue/profile/venue.types.js';
import type {
  BookingCancellationDocument,
  BookingDocument,
  BookingPaymentDocument,
  BookingStatus,
} from './booking.types.js';
import type { OwnerBookingRepository } from './owner-booking.repository.js';
import type { OutboxRepository } from '../../shared/communications/outbox.repository.js';

export interface OwnerBookingView {
  id: string;
  partnerId: string | null;
  venueId: string;
  courtId: string;
  slotId: string | null;
  contractId: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  bookingType: 'OPEN_TIME' | 'FIXED_SLOT' | 'DIRECT';
  externalBookingReference: string | null;
  customerReference: string | null;
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
  payment: ReturnType<typeof paymentView> | null;
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
    pagination: { page: number; limit: number; total: number; pages: number };
  }>;
  getDetail(input: {
    actorOwnerId: string;
    venueId: string;
    bookingId: string;
  }): Promise<OwnerBookingDetailView>;
  // [UPDATED 2026-07-31] Owner direct booking creation
  createDirectBooking(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
    startsAt: string;
    endsAt: string;
    customerName?: string;
    customerPhone?: string;
    reasonNote?: string;
    correlationId: string;
  }): Promise<OwnerBookingView>;
  // [UPDATED 2026-07-31] Owner booking cancellation
  cancelBooking(input: {
    actorOwnerId: string;
    venueId: string;
    bookingId: string;
    reasonCode: string;
    reasonText?: string;
    correlationId: string;
  }): Promise<{ bookingId: string; status: 'CANCELLED'; cancelledAt: string }>;
  recordPayment(input:{actorOwnerId:string;venueId:string;bookingId:string;amountMinor:number;method:BookingPaymentDocument['method'];reference?:string;notes?:string;correlationId:string}):Promise<ReturnType<typeof paymentView>>;
  refundPayment(input:{actorOwnerId:string;venueId:string;bookingId:string;amountMinor:number;version:number;notes?:string;correlationId:string}):Promise<ReturnType<typeof paymentView>>;
}

export function createOwnerBookingService(input: {
  repository: OwnerBookingRepository;
  ownerAccessService: OwnerAccessService;
  database: DatabaseConnection;
  outboxRepository: OutboxRepository;
  now?: () => Date;
}): OwnerBookingService {
  const now = input.now ?? (() => new Date());

  async function requireAccess(actorOwnerId: string, venueId: string): Promise<ObjectId> {
    await input.ownerAccessService.requirePermission(actorOwnerId, venueId, 'VIEW_BOOKINGS');
    return toObjectId(venueId);
  }

  return {
    async list(values) {
      const venueId = await requireAccess(values.actorOwnerId, values.venueId);
      const from = values.from ? toDate(values.from) : undefined;
      const to = values.to ? toDate(values.to) : undefined;
      if (from && to && from >= to) {
        throw new AppError({ code: 'INVALID_BOOKING_DATE_RANGE', message: 'The booking filter start must be before its end', statusCode: 400 });
      }
      const page = values.page ?? 1;
      const limit = values.limit ?? 50;
      if (!Number.isInteger(page) || page < 1) {
        throw new AppError({ code: 'INVALID_BOOKING_PAGE', message: 'Booking page must be a positive integer', statusCode: 400 });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError({ code: 'INVALID_BOOKING_LIMIT', message: 'Booking limit must be an integer from 1 to 100', statusCode: 400 });
      }
      const result = await input.repository.listForVenue(venueId, {
        ...(values.courtId ? { courtId: toObjectId(values.courtId) } : {}),
        ...(values.status ? { status: values.status } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        page,
        limit,
      });
      return {
        items: result.bookings.map(toView),
        pagination: { page, limit, total: result.total, pages: Math.ceil(result.total / limit) },
      };
    },

    async getDetail(values) {
      const venueId = await requireAccess(values.actorOwnerId, values.venueId);
      const booking = await input.repository.findForVenue(venueId, toObjectId(values.bookingId));
      if (!booking) {
        throw new AppError({ code: 'BOOKING_NOT_FOUND', message: 'Booking was not found', statusCode: 404 });
      }
      const cancellation = await input.repository.findCancellation(booking._id);
      const payment = await input.repository.findPayment(venueId, booking._id);
      return { ...toDetailView(booking, cancellation), payment: payment ? paymentView(payment) : null };
    },

    async createDirectBooking(values) {
      await input.ownerAccessService.requirePermission(values.actorOwnerId, values.venueId, 'MANAGE_BOOKINGS');
      const venueId = toObjectId(values.venueId);
      const courtId = toObjectId(values.courtId);
      const actorOwnerId = toObjectId(values.actorOwnerId);
      const timestamp = now();
      const startsAt = toDate(values.startsAt);
      const endsAt = toDate(values.endsAt);
      if (startsAt >= endsAt) {
        throw new AppError({ code: 'INVALID_BOOKING_INTERVAL', message: 'startsAt must be before endsAt', statusCode: 400 });
      }
      if ((endsAt.getTime() - startsAt.getTime()) / 60_000 < 60) {
        throw new AppError({ code: 'BOOKING_TOO_SHORT', message: 'Direct bookings must be at least 60 minutes', statusCode: 400 });
      }

      let booking!: BookingDocument;
      await input.database.withTransaction(async ({ session }) => {
        const venue = await input.database.db
          .collection<VenueDocument>('venues')
          .findOne({ _id: venueId }, { session });
        const court = await input.database.db
          .collection<CourtDocument>('courts')
          .findOne({ _id: courtId, venue_id: venueId }, { session });
        if (!venue || venue.status !== 'ACTIVE') {
          throw new AppError({ code: 'VENUE_NOT_ACTIVE', message: 'Venue is not active', statusCode: 409 });
        }
        if (!court || court.status !== 'AVAILABLE') {
          throw new AppError({ code: 'COURT_NOT_AVAILABLE', message: 'Court is not available', statusCode: 409 });
        }
        const overlap = await input.database.db
          .collection<SlotDocument>('slots')
          .findOne({
            court_id: courtId,
            environment: venue.environment,
            status: { $in: ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'] },
            starts_at: { $lt: endsAt },
            ends_at: { $gt: startsAt },
          }, { session });
        if (overlap) {
          throw new AppError({ code: 'INVENTORY_OVERLAP', message: 'The interval overlaps unavailable inventory', statusCode: 409 });
        }
        const bookingId = new ObjectId();
        const slotId = new ObjectId();
        const slot: SlotDocument = {
          _id: slotId,
          court_id: courtId,
          venue_id: venueId,
          environment: venue.environment,
          booking_type: 'OPEN_TIME',
          starts_at: startsAt,
          ends_at: endsAt,
          price_minor: null,
          currency: 'INR',
          status: 'BOOKED',
          hold_id: null,
          hold_partner_id: null,
          hold_expires_at: null,
          hold_created_at: null,
          source: 'OWNER_DASHBOARD',
          booking_id: bookingId,
          audit_history: [{
            event_type: 'SLOT_BOOKED',
            actor_type: 'VENUE_OWNER',
            actor_id: actorOwnerId,
            previous_status: null,
            new_status: 'BOOKED',
            reason: values.reasonNote ?? 'Owner direct booking',
            correlation_id: values.correlationId,
            occurred_at: timestamp,
          }],
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
        };
        await input.database.db.collection<SlotDocument>('slots').insertOne(slot, { session });
        booking = {
          _id: bookingId,
          slot_id: slotId,
          contract_id: null,
          partner_id: null,
          venue_id: venueId,
          court_id: courtId,
          environment: venue.environment,
          booking_type: 'DIRECT',
          starts_at: startsAt,
          ends_at: endsAt,
          external_booking_reference: null,
          confirm_idempotency_key: `direct:${bookingId.toHexString()}`,
          customer_reference: values.customerName?.trim() ?? null,
          partner_payment_reference: values.customerPhone?.trim() ?? null,
          status: 'CONFIRMED',
          gross_amount_minor: 0,
          commission_amount_minor: 0,
          tax_amount_minor: 0,
          venue_net_amount_minor: 0,
          currency: 'INR',
          cancellation_terms_snapshot: {},
          confirmed_at: timestamp,
          cancelled_at: null,
          audit_history: [{
            event_type: 'BOOKING_CONFIRMED',
            actor_type: 'VENUE',
            actor_id: actorOwnerId,
            correlation_id: values.correlationId,
            changes: {
              previous_status: null,
              new_status: 'CONFIRMED',
              reason: values.reasonNote ?? 'Owner direct booking',
              customer_name: values.customerName ?? null,
              customer_phone: values.customerPhone ?? null,
            },
            occurred_at: timestamp,
          }],
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
        };
        await input.repository.insertDirectBooking(booking, session);
        await input.outboxRepository.enqueue({
          aggregateType: 'BOOKING',
          aggregateId: booking._id,
          partnerId: null,
          venueId,
          environment: booking.environment,
          eventType: 'BOOKING_CONFIRMED',
          eventVersion: booking.version,
          correlationId: values.correlationId,
          payload: {
            bookingId: booking._id.toHexString(),
            venueId: venueId.toHexString(),
            courtId: courtId.toHexString(),
            bookingType: 'DIRECT',
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            customerReference: booking.customer_reference,
          },
          now: timestamp,
          session,
        });
      });
      return toView(booking);
    },

    async cancelBooking(values) {
      await input.ownerAccessService.requirePermission(values.actorOwnerId, values.venueId, 'MANAGE_BOOKINGS');
      const venueId = toObjectId(values.venueId);
      const bookingId = toObjectId(values.bookingId);
      const actorOwnerId = toObjectId(values.actorOwnerId);
      const reasonCode = values.reasonCode.trim().toUpperCase();
      const reasonText = values.reasonText?.trim() ?? null;
      const timestamp = now();

      let cancelled!: BookingDocument;
      await input.database.withTransaction(async ({ session }) => {
        const booking = await input.repository.findForVenueWithSession(venueId, bookingId, session);
        if (!booking) {
          throw new AppError({ code: 'BOOKING_NOT_FOUND', message: 'Booking was not found', statusCode: 404 });
        }
        if (booking.status !== 'CONFIRMED') {
          throw new AppError({ code: 'BOOKING_NOT_CANCELLABLE', message: 'Only confirmed bookings can be cancelled', statusCode: 409 });
        }
        if (booking.booking_type !== 'DIRECT') {
          throw new AppError({
            code: 'OWNER_CANCELLATION_DIRECT_ONLY',
            message: 'This endpoint only cancels bookings created by the Venue Owner',
            statusCode: 409,
          });
        }
        const result = await input.repository.cancelOwnerBooking({
          booking, actorOwnerId, reasonCode, reasonText,
          correlationId: values.correlationId, now: timestamp, session,
        });
        if (!result) {
          throw new AppError({ code: 'BOOKING_VERSION_CONFLICT', message: 'Booking changed concurrently', statusCode: 409 });
        }
        cancelled = result;
        const payment = await input.database.db.collection<BookingPaymentDocument>('booking_payments').findOne({booking_id:bookingId,venue_id:venueId},{session});
        const refundAmount = payment ? payment.amount_minor - payment.refunded_amount_minor : 0;
        if (payment && refundAmount > 0) {
          const refundedPayment = await input.database.db.collection<BookingPaymentDocument>('booking_payments').findOneAndUpdate({_id:payment._id,version:payment.version},{$set:{refunded_amount_minor:payment.amount_minor,status:'REFUNDED',refunded_at:timestamp,updated_at:timestamp},$inc:{version:1},$push:{audit_history:{$each:[{event_type:'PAYMENT_REFUNDED',actor_type:'VENUE_OWNER',actor_id:actorOwnerId,amount_minor:refundAmount,reason:'Booking cancelled',correlation_id:values.correlationId,occurred_at:timestamp}],$slice:-100}}},{returnDocument:'after',session});
          if (!refundedPayment) throw new AppError({code:'PAYMENT_REFUND_CONFLICT',message:'Payment changed concurrently',statusCode:409});
          await input.outboxRepository.enqueue({aggregateType:'PAYMENT',aggregateId:payment._id,partnerId:null,venueId,environment:booking.environment,eventType:'PAYMENT_REFUNDED',eventVersion:refundedPayment.version,correlationId:values.correlationId,payload:{paymentId:payment._id.toHexString(),bookingId:bookingId.toHexString(),refundAmountMinor:refundAmount,totalRefundedAmountMinor:payment.amount_minor,currency:'INR'},now:timestamp,session});
        }
        await input.repository.insertCancellation({
          _id: new ObjectId(),
          booking_id: booking._id,
          requested_by_type: 'VENUE',
          requested_by_id: actorOwnerId,
          reason_code: reasonCode,
          reason_text: reasonText,
          refund_percent: payment && payment.amount_minor > 0 ? 100 : 0,
          refund_amount_minor: refundAmount,
          slot_disposition: 'RELEASE_TO_INVENTORY',
          idempotency_key: `owner-cancel:${bookingId.toHexString()}:${timestamp.getTime()}`,
          cancelled_at: timestamp,
          created_at: timestamp,
        }, session);
        if (booking.slot_id) {
          await input.repository.releaseDirectSlot({
            slotId: booking.slot_id,
            bookingId: booking._id,
            actorOwnerId,
            correlationId: values.correlationId,
            now: timestamp,
            session,
          });
        }
        await input.outboxRepository.enqueue({
          aggregateType: 'BOOKING',
          aggregateId: cancelled._id,
          partnerId: cancelled.partner_id,
          venueId,
          environment: cancelled.environment,
          eventType: 'BOOKING_CANCELLED',
          eventVersion: cancelled.version,
          correlationId: values.correlationId,
          payload: {
            bookingId: cancelled._id.toHexString(),
            venueId: venueId.toHexString(),
            courtId: cancelled.court_id.toHexString(),
            reasonCode,
            refundAmountMinor: refundAmount,
            slotDisposition: 'RELEASE_TO_INVENTORY',
          },
          now: timestamp,
          session,
        });
      });
      return {
        bookingId: cancelled._id.toHexString(),
        status: 'CANCELLED',
        cancelledAt: cancelled.cancelled_at!.toISOString(),
      };
    },
    async recordPayment(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_BOOKINGS'); if(!Number.isSafeInteger(values.amountMinor)||values.amountMinor<0)throw new AppError({code:'INVALID_PAYMENT_AMOUNT',message:'Payment amount must be a non-negative integer in minor units',statusCode:400}); const venueId=toObjectId(values.venueId);const bookingId=toObjectId(values.bookingId);const ownerId=toObjectId(values.actorOwnerId);const timestamp=now();let payment!:BookingPaymentDocument;await input.database.withTransaction(async({session})=>{const booking=await input.repository.findForVenueWithSession(venueId,bookingId,session);if(!booking||booking.booking_type!=='DIRECT')throw new AppError({code:'DIRECT_BOOKING_NOT_FOUND',message:'Direct booking was not found',statusCode:404});if(booking.status!=='CONFIRMED')throw new AppError({code:'PAYMENT_BOOKING_NOT_CONFIRMED',message:'Payment can only be recorded for a confirmed direct booking',statusCode:409});payment={_id:new ObjectId(),booking_id:bookingId,venue_id:venueId,amount_minor:values.amountMinor,refunded_amount_minor:0,currency:'INR',method:values.method,status:'PAID',reference:values.reference?.trim()||null,notes:values.notes?.trim()||null,recorded_by:ownerId,paid_at:timestamp,refunded_at:null,version:1,audit_history:[{event_type:'PAYMENT_RECORDED',actor_type:'VENUE_OWNER',actor_id:ownerId,correlation_id:values.correlationId,occurred_at:timestamp}],created_at:timestamp,updated_at:timestamp};await input.database.db.collection<BookingPaymentDocument>('booking_payments').insertOne(payment,{session});await input.database.db.collection<BookingDocument>('bookings').updateOne({_id:bookingId,venue_id:venueId,version:booking.version},{$set:{gross_amount_minor:values.amountMinor,venue_net_amount_minor:values.amountMinor,partner_payment_reference:payment.reference,updated_at:timestamp},$inc:{version:1}},{session});await input.outboxRepository.enqueue({aggregateType:'PAYMENT',aggregateId:payment._id,partnerId:null,venueId,environment:booking.environment,eventType:'PAYMENT_RECORDED',eventVersion:1,correlationId:values.correlationId,payload:{paymentId:payment._id.toHexString(),bookingId:bookingId.toHexString(),amountMinor:values.amountMinor,currency:'INR',method:values.method},now:timestamp,session});});return paymentView(payment);},
    async refundPayment(values){await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_BOOKINGS');if(!Number.isSafeInteger(values.amountMinor)||values.amountMinor<=0)throw new AppError({code:'INVALID_REFUND_AMOUNT',message:'Refund amount must be a positive integer in minor units',statusCode:400});const venueId=toObjectId(values.venueId),bookingId=toObjectId(values.bookingId),ownerId=toObjectId(values.actorOwnerId),timestamp=now();let payment!:BookingPaymentDocument;await input.database.withTransaction(async({session})=>{const existing=await input.database.db.collection<BookingPaymentDocument>('booking_payments').findOne({booking_id:bookingId,venue_id:venueId},{session});if(!existing)throw new AppError({code:'PAYMENT_NOT_FOUND',message:'Booking payment was not found',statusCode:404});if(existing.version!==values.version||existing.refunded_amount_minor+values.amountMinor>existing.amount_minor)throw new AppError({code:'PAYMENT_REFUND_CONFLICT',message:'Payment changed or refund exceeds the remaining paid amount',statusCode:409});const refunded=existing.refunded_amount_minor+values.amountMinor;payment=(await input.database.db.collection<BookingPaymentDocument>('booking_payments').findOneAndUpdate({_id:existing._id,version:values.version},{$set:{refunded_amount_minor:refunded,status:refunded===existing.amount_minor?'REFUNDED':'PARTIALLY_REFUNDED',refunded_at:timestamp,updated_at:timestamp},$inc:{version:1},$push:{audit_history:{$each:[{event_type:'PAYMENT_REFUNDED',actor_type:'VENUE_OWNER',actor_id:ownerId,amount_minor:values.amountMinor,notes:values.notes?.trim()||null,correlation_id:values.correlationId,occurred_at:timestamp}],$slice:-100}}},{returnDocument:'after',session}))!;const booking=await input.repository.findForVenueWithSession(venueId,bookingId,session);if(!booking)throw new AppError({code:'BOOKING_NOT_FOUND',message:'Booking was not found',statusCode:404});await input.outboxRepository.enqueue({aggregateType:'PAYMENT',aggregateId:existing._id,partnerId:null,venueId,environment:booking.environment,eventType:'PAYMENT_REFUNDED',eventVersion:payment.version,correlationId:values.correlationId,payload:{paymentId:existing._id.toHexString(),bookingId:bookingId.toHexString(),refundAmountMinor:values.amountMinor,totalRefundedAmountMinor:refunded,currency:'INR'},now:timestamp,session});});return paymentView(payment);},
  };
}

function paymentView(value:BookingPaymentDocument){return{paymentId:value._id.toHexString(),bookingId:value.booking_id.toHexString(),amountMinor:value.amount_minor,refundedAmountMinor:value.refunded_amount_minor,currency:value.currency,method:value.method,status:value.status,reference:value.reference,notes:value.notes,paidAt:value.paid_at.toISOString(),refundedAt:value.refunded_at?.toISOString()??null,version:value.version};}

function toView(booking: BookingDocument): OwnerBookingView {
  return {
    id: booking._id.toHexString(),
    partnerId: booking.partner_id?.toHexString() ?? null,
    venueId: booking.venue_id.toHexString(),
    courtId: booking.court_id.toHexString(),
    slotId: booking.slot_id?.toHexString() ?? null,
    contractId: booking.contract_id?.toHexString() ?? null,
    environment: booking.environment,
    bookingType: booking.booking_type,
    externalBookingReference: booking.external_booking_reference,
    customerReference: booking.customer_reference,
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
    payment: null,
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
    throw new AppError({ code: 'INVALID_BOOKING_DATE', message: 'Booking date must be a valid ISO-8601 timestamp', statusCode: 400 });
  }
  return date;
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({ code: 'INVALID_ID', message: 'A supplied identifier is invalid', statusCode: 400 });
  }
  return new ObjectId(value);
}
