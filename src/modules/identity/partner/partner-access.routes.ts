import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  createPartnerAuthenticationHook,
  requireAdminContext,
  requirePartnerScope,
} from '../shared/auth-context.js';
import type { PartnerAccessService } from './partner-access.service.js';
import type { PartnerEnvironment } from './partner-access.types.js';

export interface PartnerAccessRoutesOptions {
  service: PartnerAccessService;
  adminAuthService: AdminAuthService;
}

const partnerAccessRoutes: FastifyPluginAsync<PartnerAccessRoutesOptions> =
  async (fastify, options) => {
    const startedAt = new WeakMap<object, number>();
    const adminAuth = createAdminAuthenticationHook(
      options.adminAuthService,
    );
    const partnerAuth = createPartnerAuthenticationHook(options.service);

    fastify.addHook('onRequest', async (request) => {
      startedAt.set(request, performance.now());
    });
    fastify.addHook('onResponse', async (request, reply) => {
      const partner = request.identity;

      if (partner?.actorType !== 'PARTNER') {
        return;
      }

      await options.service
        .recordApiUsage({
          partnerId: partner.partnerId,
          environment: partner.environment,
          statusCode: reply.statusCode,
          latencyMs: performance.now() - (startedAt.get(request) ?? 0),
          rateLimited: reply.statusCode === 429,
        })
        .catch((error: unknown) => {
          request.log.error({ err: error }, 'Failed to record API usage');
        });
    });

    fastify.post<{
      Body: { legalName: string; displayName: string; email: string };
    }>(
      '/applications',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['legalName', 'displayName', 'email'],
            properties: {
              legalName: { type: 'string', minLength: 2, maxLength: 200 },
              displayName: {
                type: 'string',
                minLength: 2,
                maxLength: 200,
              },
              email: { type: 'string', format: 'email', maxLength: 320 },
            },
          },
        },
      },
      async (request, reply) =>
        reply.status(201).send(await options.service.apply(request.body)),
    );

    fastify.patch<{
      Params: { partnerId: string };
      Body: { status: 'PENDING' | 'PASSED' | 'FAILED' };
    }>(
      '/admin/:partnerId/integration-review',
      {
        preHandler: adminAuth,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { enum: ['PENDING', 'PASSED', 'FAILED'] },
            },
          },
        },
      },
      async (request, reply) => {
        await options.service.recordIntegrationReview({
          partnerId: request.params.partnerId,
          status: request.body.status,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{ Params: { partnerId: string } }>(
      '/admin/:partnerId/approve-sandbox',
      { preHandler: adminAuth },
      async (request, reply) => {
        const admin = requireAdminContext(request);
        await options.service.approveSandbox({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{ Params: { partnerId: string } }>(
      '/admin/:partnerId/approve-production',
      { preHandler: adminAuth },
      async (request, reply) => {
        const admin = requireAdminContext(request);

        if (admin.role !== 'ADMIN') {
          return reply.status(403).send({
            error: {
              code: 'ADMIN_ROLE_REQUIRED',
              message: 'ADMIN role is required',
              requestId: request.id,
            },
          });
        }

        await options.service.approveProduction({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{
      Params: { partnerId: string };
      Body: {
        environment: PartnerEnvironment;
        scopes: string[];
        expiresAt?: string;
      };
    }>(
      '/admin/:partnerId/keys',
      {
        preHandler: adminAuth,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['environment', 'scopes'],
            properties: {
              environment: { enum: ['SANDBOX', 'PRODUCTION'] },
              scopes: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 100 },
              },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      async (request, reply) =>
        reply.status(201).send(
          await options.service.issueKey({
            partnerId: request.params.partnerId,
            ...request.body,
          }),
        ),
    );

    fastify.delete<{ Params: { keyId: string } }>(
      '/admin/keys/:keyId',
      { preHandler: adminAuth },
      async (request, reply) => {
        await options.service.revokeKey(request.params.keyId);
        return reply.status(204).send();
      },
    );

    fastify.post<{
      Body: { url: string; subscribedEvents: string[] };
    }>(
      '/webhooks',
      {
        config: { rawBody: true },
        preHandler: partnerAuth,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['url', 'subscribedEvents'],
            properties: {
              url: { type: 'string', format: 'uri', maxLength: 2048 },
              subscribedEvents: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const partner = requirePartnerScope(request, 'webhooks:write');
        return reply.status(201).send(
          await options.service.registerWebhook({
            partnerId: partner.partnerId,
            environment: partner.environment,
            ...request.body,
          }),
        );
      },
    );

    fastify.delete<{ Params: { webhookId: string } }>(
      '/webhooks/:webhookId',
      {
        config: { rawBody: true },
        preHandler: partnerAuth,
      },
      async (request, reply) => {
        const partner = requirePartnerScope(request, 'webhooks:write');
        await options.service.disableWebhook({
          webhookId: request.params.webhookId,
          partnerId: partner.partnerId,
          environment: partner.environment,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{ Params: { webhookId: string } }>(
      '/admin/webhooks/:webhookId/verify',
      { preHandler: adminAuth },
      async (request, reply) => {
        await options.service.verifyWebhook(request.params.webhookId);
        return reply.status(204).send();
      },
    );
  };

export default partnerAccessRoutes;
