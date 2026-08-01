import type { FastifyPluginAsync } from 'fastify';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import {
  createOwnerAuthenticationHook,
  requireOwnerContext,
} from '../identity/shared/auth-context.js';
import type { BookingStatus } from './booking.types.js';
import type { OwnerBookingService } from './owner-booking.service.js';

export interface OwnerBookingRoutesOptions {
  service: OwnerBookingService;
  ownerAccessService: OwnerAccessService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const statuses = [
  'CONFIRMED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
  'DISPUTED',
] as const;

const ownerBookingRoutes: FastifyPluginAsync<OwnerBookingRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createOwnerAuthenticationHook(
      options.ownerAccessService,
    );

    fastify.get<{
      Params: { venueId: string };
      Querystring: {
        courtId?: string;
        status?: BookingStatus;
        from?: string;
        to?: string;
        page?: number;
        limit?: number;
      };
    }>(
      '/:venueId/bookings',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId'],
            properties: { venueId: objectId },
          },
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              courtId: objectId,
              status: { type: 'string', enum: statuses },
              from: dateTime,
              to: dateTime,
              page: { type: 'integer', minimum: 1, default: 1 },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 50,
              },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.list({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          ...request.query,
        });
      },
    );

    fastify.get<{
      Params: { venueId: string; bookingId: string };
    }>(
      '/:venueId/bookings/:bookingId',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId', 'bookingId'],
            properties: { venueId: objectId, bookingId: objectId },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.getDetail({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          bookingId: request.params.bookingId,
        });
      },
    );

    // [UPDATED 2026-07-31] Owner direct booking creation
    fastify.post<{
      Params: { venueId: string };
      Body: {
        courtId: string;
        startsAt: string;
        endsAt: string;
        customerName?: string;
        customerPhone?: string;
        reasonNote?: string;
      };
    }>(
      '/:venueId/bookings',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId'],
            properties: { venueId: objectId },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['courtId', 'startsAt', 'endsAt'],
            properties: {
              courtId: objectId,
              startsAt: dateTime,
              endsAt: dateTime,
              customerName: { type: 'string', minLength: 1, maxLength: 200 },
              customerPhone: { type: 'string', minLength: 1, maxLength: 30 },
              reasonNote: { type: 'string', minLength: 1, maxLength: 500 },
            },
          },
        },
      },
      async (request, reply) => {
        const owner = requireOwnerContext(request);
        const result = await options.service.createDirectBooking({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          correlationId: request.id,
          ...request.body,
        });
        return reply.status(201).send(result);
      },
    );

    // [UPDATED 2026-07-31] Owner booking cancellation
    fastify.post<{
      Params: { venueId: string; bookingId: string };
      Body: { reasonCode: string; reasonText?: string };
    }>(
      '/:venueId/bookings/:bookingId/cancel',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['venueId', 'bookingId'],
            properties: { venueId: objectId, bookingId: objectId },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['reasonCode'],
            properties: {
              reasonCode: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
              reasonText: { type: 'string', minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
      async (request) => {
        const owner = requireOwnerContext(request);
        return options.service.cancelBooking({
          actorOwnerId: owner.ownerId,
          venueId: request.params.venueId,
          bookingId: request.params.bookingId,
          correlationId: request.id,
          ...request.body,
        });
      },
    );
    fastify.post<{Params:{venueId:string;bookingId:string};Body:{amountMinor:number;method:'CASH'|'CARD'|'UPI'|'BANK_TRANSFER'|'OTHER';reference?:string;notes?:string}}>('/:venueId/bookings/:bookingId/payment',{preHandler:authenticate,schema:{params:{type:'object',additionalProperties:false,required:['venueId','bookingId'],properties:{venueId:objectId,bookingId:objectId}},body:{type:'object',additionalProperties:false,required:['amountMinor','method'],properties:{amountMinor:{type:'integer',minimum:0},method:{enum:['CASH','CARD','UPI','BANK_TRANSFER','OTHER']},reference:{type:'string',minLength:1,maxLength:200},notes:{type:'string',minLength:1,maxLength:500}}}}},async(request,reply)=>{const owner=requireOwnerContext(request);return reply.status(201).send(await options.service.recordPayment({actorOwnerId:owner.ownerId,venueId:request.params.venueId,bookingId:request.params.bookingId,correlationId:request.id,...request.body}));});
    fastify.post<{Params:{venueId:string;bookingId:string};Body:{amountMinor:number;version:number;notes?:string}}>('/:venueId/bookings/:bookingId/payment/refund',{preHandler:authenticate,schema:{params:{type:'object',additionalProperties:false,required:['venueId','bookingId'],properties:{venueId:objectId,bookingId:objectId}},body:{type:'object',additionalProperties:false,required:['amountMinor','version'],properties:{amountMinor:{type:'integer',minimum:1},version:{type:'integer',minimum:1},notes:{type:'string',minLength:1,maxLength:500}}}}},async(request)=>{const owner=requireOwnerContext(request);return options.service.refundPayment({actorOwnerId:owner.ownerId,venueId:request.params.venueId,bookingId:request.params.bookingId,correlationId:request.id,...request.body});});
  };

export default ownerBookingRoutes;
