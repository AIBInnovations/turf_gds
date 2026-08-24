import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors/app-error.js';
import type { AdminAuthService } from '../identity/platform/auth.service.js';
import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import type { PartnerAccessService } from '../identity/partner/partner-access.service.js';
import {
  createAdminAuthenticationHook,
  createOwnerAuthenticationHook,
  createPartnerPortalAuthenticationHook,
  requireAdminContext,
  requireOwnerContext,
  requirePartnerPortalContext,
} from '../identity/shared/auth-context.js';
import type { MessagingService } from './messaging.service.js';

/**
 * Three surfaces over one collection:
 *
 *   /admin/messages          staff read every thread and write to any account
 *   /owner/messages          an owner reads and replies to their own thread only
 *   /partners/me/messages    the same, for a partner portal session
 *
 * The recipient routes never take a recipient id from the request. It comes from the session,
 * which is what stops one owner from reading another's thread by editing a query string.
 */

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;

const messageBody = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: {
    subject: { type: 'string', maxLength: 200 },
    body: { type: 'string', minLength: 1, maxLength: 8192 },
  },
} as const;

/** SUPPORT can read the console but not write to a customer in the platform's name. */
function requireMessagingOperator(request: FastifyRequest) {
  const admin = requireAdminContext(request);
  if (admin.role === 'SUPPORT') {
    throw new AppError({
      code: 'MESSAGING_OPERATOR_REQUIRED',
      message: 'ADMIN or OPS role is required to send a message',
      statusCode: 403,
    });
  }
  return admin;
}

export interface AdminMessagingRoutesOptions {
  service: MessagingService;
  adminAuthService: AdminAuthService;
}

export const adminMessagingRoutes: FastifyPluginAsync<
  AdminMessagingRoutesOptions
> = async (fastify, options) => {
  const authenticate = createAdminAuthenticationHook(options.adminAuthService);

  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/threads',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.listThreads(request.query);
    },
  );

  fastify.get<{
    Querystring: {
      recipientType: 'PARTNER' | 'VENUE_OWNER';
      recipientId: string;
      page?: number;
      limit?: number;
    };
  }>(
    '/',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['recipientType', 'recipientId'],
          properties: {
            recipientType: { enum: ['PARTNER', 'VENUE_OWNER'] },
            recipientId: objectId,
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.listThread(request.query);
    },
  );

  fastify.post<{
    Body: {
      recipientType: 'PARTNER' | 'VENUE_OWNER';
      recipientId: string;
      subject?: string;
      body: string;
    };
  }>(
    '/',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['recipientType', 'recipientId', 'body'],
          properties: {
            recipientType: { enum: ['PARTNER', 'VENUE_OWNER'] },
            recipientId: objectId,
            subject: { type: 'string', maxLength: 200 },
            body: { type: 'string', minLength: 1, maxLength: 8192 },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireMessagingOperator(request);
      const message = await options.service.send({
        ...request.body,
        senderAdminId: admin.adminId,
      });
      return reply.status(201).send(message);
    },
  );

  fastify.post<{
    Body: { recipientType: 'PARTNER' | 'VENUE_OWNER'; recipientId: string };
  }>(
    '/read',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['recipientType', 'recipientId'],
          properties: {
            recipientType: { enum: ['PARTNER', 'VENUE_OWNER'] },
            recipientId: objectId,
          },
        },
      },
    },
    async (request) => {
      requireAdminContext(request);
      return options.service.markRead({ ...request.body, side: 'ADMIN' });
    },
  );
};

export interface OwnerMessagingRoutesOptions {
  service: MessagingService;
  ownerAccessService: OwnerAccessService;
}

export const ownerMessagingRoutes: FastifyPluginAsync<
  OwnerMessagingRoutesOptions
> = async (fastify, options) => {
  const authenticate = createOwnerAuthenticationHook(options.ownerAccessService);

  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/messages',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.listThread({
        recipientType: 'VENUE_OWNER',
        recipientId: owner.ownerId,
        ...request.query,
      });
    },
  );

  fastify.post<{ Body: { subject?: string; body: string } }>(
    '/messages',
    { preHandler: authenticate, schema: { body: messageBody } },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const message = await options.service.reply({
        recipientType: 'VENUE_OWNER',
        recipientId: owner.ownerId,
        subject: request.body.subject,
        body: request.body.body,
        senderName: 'Venue owner',
      });
      return reply.status(201).send(message);
    },
  );

  fastify.post(
    '/messages/read',
    { preHandler: authenticate },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.markRead({
        recipientType: 'VENUE_OWNER',
        recipientId: owner.ownerId,
        side: 'RECIPIENT',
      });
    },
  );
};

export interface PartnerMessagingRoutesOptions {
  service: MessagingService;
  partnerAccessService: PartnerAccessService;
}

export const partnerMessagingRoutes: FastifyPluginAsync<
  PartnerMessagingRoutesOptions
> = async (fastify, options) => {
  const authenticate = createPartnerPortalAuthenticationHook(
    options.partnerAccessService,
  );

  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/me/messages',
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const partner = requirePartnerPortalContext(request);
      return options.service.listThread({
        recipientType: 'PARTNER',
        recipientId: partner.partnerId,
        ...request.query,
      });
    },
  );

  fastify.post<{ Body: { subject?: string; body: string } }>(
    '/me/messages',
    { preHandler: authenticate, schema: { body: messageBody } },
    async (request, reply) => {
      const partner = requirePartnerPortalContext(request);
      const message = await options.service.reply({
        recipientType: 'PARTNER',
        recipientId: partner.partnerId,
        subject: request.body.subject,
        body: request.body.body,
        senderName: 'API partner',
      });
      return reply.status(201).send(message);
    },
  );

  fastify.post(
    '/me/messages/read',
    { preHandler: authenticate },
    async (request) => {
      const partner = requirePartnerPortalContext(request);
      return options.service.markRead({
        recipientType: 'PARTNER',
        recipientId: partner.partnerId,
        side: 'RECIPIENT',
      });
    },
  );
};
