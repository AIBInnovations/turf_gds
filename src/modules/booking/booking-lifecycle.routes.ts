import type { FastifyPluginAsync } from 'fastify';

import type { PartnerAccessService } from '../identity/partner/partner-access.service.js';
import type { AdminAuthService } from '../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  createPartnerAuthenticationHook,
  requireAdminContext,
  requirePartnerScope,
} from '../identity/shared/auth-context.js';
import type { BookingLifecycleService } from './booking-lifecycle.service.js';

export interface BookingLifecycleRoutesOptions {
  service: BookingLifecycleService;
  partnerAccessService: PartnerAccessService;
  adminAuthService: AdminAuthService;
}

const bookingLifecycleRoutes: FastifyPluginAsync<
  BookingLifecycleRoutesOptions
> = async (fastify, options) => {
  const partnerAuth = createPartnerAuthenticationHook(
    options.partnerAccessService,
  );
  const adminAuth = createAdminAuthenticationHook(options.adminAuthService);
  const startedAt = new WeakMap<object, number>();

  fastify.addHook('onRequest', async (request) => {
    startedAt.set(request, performance.now());
  });
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.identity?.actorType !== 'PARTNER') return;
    await options.partnerAccessService
      .recordApiUsage({
        partnerId: request.identity.partnerId,
        environment: request.identity.environment,
        statusCode: reply.statusCode,
        latencyMs: performance.now() - (startedAt.get(request) ?? 0),
        rateLimited: reply.statusCode === 429,
      })
      .catch((error: unknown) => {
        request.log.error({ err: error }, 'Failed to record API usage');
      });
  });

  fastify.post<{
    Body: {
      bookingType: 'FIXED_SLOT' | 'OPEN_TIME';
      slotId?: string;
      venueId?: string;
      courtId?: string;
      startsAt?: string;
      endsAt?: string;
    };
  }>(
    '/hold',
    {
      config: {
        rawBody: true,
        docs: {
          tag: 'Bookings',
          summary: 'Create a short-lived inventory hold',
          description:
            'Holds the requested inventory for a bounded window. An ' +
            'OPEN_TIME hold also consumes any overlapping generated ' +
            'FIXED_SLOT inventory for the same court, so the same court hour ' +
            'can never be sold twice. Releasing or expiring the hold ' +
            'restores it.',
          security: ['partnerHmac'],
          scopes: ['bookings:write'],
          idempotent: false,
          rateLimited: true,
          internal: false,
          responses: {
            '201': { description: 'Hold created' },
            '400': { description: 'Invalid interval or booking type' },
            '409': {
              description: 'Inventory is unavailable or changed concurrently',
            },
          },
        },
      },
      preHandler: partnerAuth,
      schema: {
        body: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['bookingType', 'slotId'],
              properties: {
                bookingType: { const: 'FIXED_SLOT' },
                slotId: objectIdSchema(),
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'bookingType',
                'venueId',
                'courtId',
                'startsAt',
                'endsAt',
              ],
              properties: {
                bookingType: { const: 'OPEN_TIME' },
                venueId: objectIdSchema(),
                courtId: objectIdSchema(),
                startsAt: { type: 'string', format: 'date-time' },
                endsAt: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const partner = requirePartnerScope(request, 'bookings:write');
      return reply.status(201).send(
        await options.service.hold({
          ...request.body,
          partnerId: partner.partnerId,
          environment: partner.environment,
          correlationId: request.id,
        }),
      );
    },
  );

  fastify.post<{
    Body: {
      holdId: string;
      externalBookingReference: string;
      customerReference?: string;
      partnerPaymentReference?: string;
    };
  }>(
    '/confirm',
    {
      config: {
        rawBody: true,
        docs: {
          tag: 'Bookings',
          summary: 'Confirm a held booking',
          description:
            'Requires an Idempotency-Key. Replaying the key returns the original booking; reusing it with a different body is rejected.',
          security: ['partnerHmac'],
          scopes: ['bookings:write'],
          idempotent: true,
          rateLimited: true,
          internal: false,
          responses: {
            '201': { description: 'Booking confirmed' },
            '409': {
              description:
                'The hold expired or the key was reused with a different request',
            },
          },
        },
      },
      preHandler: partnerAuth,
      schema: {
        headers: idempotencyHeaders(),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['holdId', 'externalBookingReference'],
          properties: {
            holdId: { type: 'string', minLength: 1, maxLength: 200 },
            externalBookingReference: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
            customerReference: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
            partnerPaymentReference: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const partner = requirePartnerScope(request, 'bookings:write');
      return reply.status(201).send(
        await options.service.confirm({
          partnerId: partner.partnerId,
          environment: partner.environment,
          idempotencyKey: request.headers['idempotency-key'] as string,
          correlationId: request.id,
          ...request.body,
        }),
      );
    },
  );

  fastify.post<{
    Params: { bookingId: string };
    Body: { reasonCode: string; reasonText?: string };
  }>(
    '/:bookingId/cancel',
    {
      config: {
        rawBody: true,
        docs: {
          tag: 'Bookings',
          summary: 'Cancel a confirmed booking',
          description:
            'Refund and inventory disposition follow the cancellation terms snapshotted onto the booking at confirmation time, not current policy.',
          security: ['partnerHmac'],
          scopes: ['bookings:write'],
          idempotent: true,
          rateLimited: true,
          internal: false,
          responses: {
            '200': { description: 'Cancellation outcome' },
            '409': {
              description:
                'The booking is not cancellable under its snapshotted terms',
            },
          },
        },
      },
      preHandler: partnerAuth,
      schema: {
        headers: idempotencyHeaders(),
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['bookingId'],
          properties: { bookingId: objectIdSchema() },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reasonCode'],
          properties: {
            reasonCode: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              pattern: '^[A-Za-z0-9_-]+$',
            },
            reasonText: {
              type: 'string',
              minLength: 1,
              maxLength: 1000,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const partner = requirePartnerScope(request, 'bookings:write');
      return reply.status(201).send(
        await options.service.cancel({
          partnerId: partner.partnerId,
          environment: partner.environment,
          bookingId: request.params.bookingId,
          idempotencyKey: request.headers['idempotency-key'] as string,
          correlationId: request.id,
          ...request.body,
        }),
      );
    },
  );

  fastify.get<{ Params: { bookingId: string } }>(
    '/admin/:bookingId/audit',
    {
      preHandler: adminAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['bookingId'],
          properties: { bookingId: objectIdSchema() },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.getAudit({
        bookingId: request.params.bookingId,
      });
    },
  );
};

function objectIdSchema() {
  return {
    type: 'string',
    pattern: '^[a-fA-F0-9]{24}$',
  };
}

function idempotencyHeaders() {
  return {
    type: 'object',
    required: ['idempotency-key'],
    properties: {
      'idempotency-key': {
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    },
  };
}

export default bookingLifecycleRoutes;
