import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  createOwnerAuthenticationHook,
  requireAdminContext,
  requireOwnerContext,
} from '../shared/auth-context.js';
import type { KycService } from './kyc.service.js';
import type { OwnerAccessService } from '../owner/owner-access.service.js';

export interface KycRoutesOptions {
  service: KycService;
  ownerAccessService: OwnerAccessService;
  adminAuthService: AdminAuthService;
}

const kycRoutes: FastifyPluginAsync<KycRoutesOptions> = async (
  fastify,
  options,
) => {
  const ownerAuth = createOwnerAuthenticationHook(
    options.ownerAccessService,
  );
  const adminAuth = createAdminAuthenticationHook(
    options.adminAuthService,
  );

  fastify.post<{ Body: { verificationType: string } }>(
    '/owner/verifications',
    {
      preHandler: ownerAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationType'],
          properties: {
            verificationType: {
              type: 'string',
              minLength: 2,
              maxLength: 100,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const result = await options.service.createDraft({
        subjectType: 'VENUE_OWNER',
        subjectId: owner.ownerId,
        verificationType: request.body.verificationType,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post<{
    Params: { verificationId: string };
    Querystring: { documentType: string };
  }>(
    '/owner/verifications/:verificationId/documents',
    {
      preHandler: ownerAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationId'],
          properties: {
            verificationId: {
              type: 'string',
              pattern: '^[a-fA-F0-9]{24}$',
            },
          },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['documentType'],
          properties: {
            documentType: {
              type: 'string',
              pattern: '^[A-Za-z][A-Za-z0-9_-]{1,99}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      const part = await request.file();

      if (!part) {
        return reply.status(400).send({
          error: {
            code: 'KYC_FILE_REQUIRED',
            message: 'A multipart file is required',
            requestId: request.id,
          },
        });
      }

      const result = await options.service.uploadDocument({
        verificationId: request.params.verificationId,
        subjectId: owner.ownerId,
        documentType: request.query.documentType,
        filename: part.filename,
        mimeType: part.mimetype,
        buffer: await part.toBuffer(),
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post<{ Params: { verificationId: string } }>(
    '/owner/verifications/:verificationId/submit',
    {
      preHandler: ownerAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationId'],
          properties: {
            verificationId: {
              type: 'string',
              pattern: '^[a-fA-F0-9]{24}$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = requireOwnerContext(request);
      await options.service.submit({
        verificationId: request.params.verificationId,
        subjectId: owner.ownerId,
      });
      return reply.status(204).send();
    },
  );

  fastify.get<{ Params: { verificationType: string } }>(
    '/owner/verifications/current/:verificationType',
    {
      preHandler: ownerAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationType'],
          properties: {
            verificationType: {
              type: 'string',
              pattern: '^[A-Za-z][A-Za-z0-9_-]{1,99}$',
            },
          },
        },
      },
    },
    async (request) => {
      const owner = requireOwnerContext(request);
      return options.service.getCurrent({
        subjectType: 'VENUE_OWNER',
        subjectId: owner.ownerId,
        verificationType: request.params.verificationType,
      });
    },
  );

  fastify.patch<{
    Params: { verificationId: string };
    Body: {
      status: 'VERIFIED' | 'REJECTED';
      rejectionReason?: string;
      expiresAt?: string;
    };
  }>(
    '/admin/verifications/:verificationId/review',
    {
      preHandler: adminAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['verificationId'],
          properties: {
            verificationId: {
              type: 'string',
              pattern: '^[a-fA-F0-9]{24}$',
            },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: { enum: ['VERIFIED', 'REJECTED'] },
            rejectionReason: { type: 'string', maxLength: 1000 },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireAdminContext(request);
      await options.service.review({
        verificationId: request.params.verificationId,
        adminId: admin.adminId,
        ...request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.post<{
    Params: { partnerId: string };
    Body: { verificationType: string };
  }>(
    '/admin/partners/:partnerId/verifications',
    { preHandler: adminAuth },
    async (request, reply) => {
      const result = await options.service.createDraft({
        subjectType: 'PARTNER',
        subjectId: request.params.partnerId,
        verificationType: request.body.verificationType,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post<{
    Params: { partnerId: string; verificationId: string };
    Querystring: { documentType: string };
  }>(
    '/admin/partners/:partnerId/verifications/:verificationId/documents',
    { preHandler: adminAuth },
    async (request, reply) => {
      const part = await request.file();

      if (!part) {
        return reply.status(400).send({
          error: {
            code: 'KYC_FILE_REQUIRED',
            message: 'A multipart file is required',
            requestId: request.id,
          },
        });
      }

      const result = await options.service.uploadDocument({
        verificationId: request.params.verificationId,
        subjectId: request.params.partnerId,
        documentType: request.query.documentType,
        filename: part.filename,
        mimeType: part.mimetype,
        buffer: await part.toBuffer(),
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post<{
    Params: { partnerId: string; verificationId: string };
  }>(
    '/admin/partners/:partnerId/verifications/:verificationId/submit',
    { preHandler: adminAuth },
    async (request, reply) => {
      await options.service.submit({
        verificationId: request.params.verificationId,
        subjectId: request.params.partnerId,
      });
      return reply.status(204).send();
    },
  );
};

export default kycRoutes;
