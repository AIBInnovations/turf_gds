import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  createPartnerAuthenticationHook,
  createPartnerPortalAuthenticationHook,
  requireAdminRole,
  requirePartnerPortalContext,
  requirePartnerScope,
  getBearerToken,
} from '../shared/auth-context.js';
import type { PartnerAccessService } from './partner-access.service.js';
import type { PartnerEnvironment } from './partner-access.types.js';
import {
  EXTERNAL_EVENT_TYPES,
  type ExternalEventType,
} from '../../../shared/communications/communications.types.js';

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
    const portalAuth = createPartnerPortalAuthenticationHook(options.service);

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
      Body: { legalName: string; displayName: string; email: string; phoneE164: string; password: string };
    }>(
      '/applications',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['legalName', 'displayName', 'email', 'phoneE164', 'password'],
            properties: {
              legalName: { type: 'string', minLength: 2, maxLength: 200 },
              displayName: {
                type: 'string',
                minLength: 2,
                maxLength: 200,
              },
              email: { type: 'string', format: 'email', maxLength: 320 },
              phoneE164: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
              password: { type: 'string', minLength: 12, maxLength: 128 },
            },
          },
        },
      },
      async (request, reply) =>
        reply.status(201).send(await options.service.apply(request.body)),
    );

    fastify.post<{ Body: { email: string; password: string } }>('/auth/login', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['email','password'], properties: { email: { type: 'string', format: 'email', maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 128 } } } },
    }, async (request) => options.service.login(request.body));

    fastify.get('/me', { preHandler: portalAuth }, async (request) => {
      const partner = requirePartnerPortalContext(request);
      return { partnerId: partner.partnerId, status: partner.status };
    });
    fastify.post('/auth/logout',{preHandler:portalAuth},async(request,reply)=>{const partner=requirePartnerPortalContext(request);await options.service.logoutPortalSession(partner.partnerId,getBearerToken(request));return reply.status(204).send();});

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
        const admin = requireAdminRole(request);
        await options.service.recordIntegrationReview({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
          status: request.body.status,
          correlationId: request.id,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{ Params: { partnerId: string } }>(
      '/admin/:partnerId/approve-sandbox',
      { preHandler: adminAuth },
      async (request, reply) => {
        const admin = requireAdminRole(request);
        await options.service.approveSandbox({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
          correlationId: request.id,
        });
        return reply.status(204).send();
      },
    );

    fastify.patch<{
      Params: { partnerId: string };
      Body: { tier: 'STARTER' | 'STANDARD' | 'ENTERPRISE' };
    }>(
      '/admin/:partnerId/rate-limit-tier',
      {
        preHandler: adminAuth,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['partnerId'],
            properties: {
              partnerId: {
                type: 'string',
                pattern: '^[a-fA-F0-9]{24}$',
              },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['tier'],
            properties: {
              tier: { enum: ['STARTER', 'STANDARD', 'ENTERPRISE'] },
            },
          },
        },
      },
      async (request, reply) => {
        const admin = requireAdminRole(request);
        await options.service.setRateLimitTier({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
          correlationId: request.id,
          tier: request.body.tier,
        });
        return reply.status(204).send();
      },
    );

    fastify.post<{ Params: { partnerId: string } }>(
      '/admin/:partnerId/approve-production',
      { preHandler: adminAuth },
      async (request, reply) => {
        const admin = requireAdminRole(request);

        await options.service.approveProduction({
          partnerId: request.params.partnerId,
          adminId: admin.adminId,
          correlationId: request.id,
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
      async (request, reply) => {
        requireAdminRole(request);
        return reply.status(201).send(
          await options.service.issueKey({
            partnerId: request.params.partnerId,
            ...request.body,
          }),
        );
      },
    );

    fastify.delete<{ Params: { keyId: string } }>(
      '/admin/keys/:keyId',
      { preHandler: adminAuth },
      async (request, reply) => {
        requireAdminRole(request);
        await options.service.revokeKey(request.params.keyId);
        return reply.status(204).send();
      },
    );

    fastify.post<{
      Body: { url: string; subscribedEvents: ExternalEventType[] };
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
                maxItems: 20,
                uniqueItems: true,
                items: { enum: [...EXTERNAL_EVENT_TYPES] },
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

    fastify.get('/webhooks',{config:{rawBody:true},preHandler:partnerAuth},async request=>{const partner=requirePartnerScope(request,'webhooks:write');return options.service.listWebhooks({partnerId:partner.partnerId,environment:partner.environment});});

    fastify.post<{Params:{webhookId:string}}>('/webhooks/:webhookId/rotate-secret',{config:{rawBody:true},preHandler:partnerAuth,schema:{params:{type:'object',additionalProperties:false,required:['webhookId'],properties:{webhookId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},async request=>{const partner=requirePartnerScope(request,'webhooks:write');return options.service.rotateWebhookSecret({webhookId:request.params.webhookId,partnerId:partner.partnerId,environment:partner.environment});});

    fastify.post<{Params:{webhookId:string}}>('/webhooks/:webhookId/test',{config:{rawBody:true},preHandler:partnerAuth,schema:{params:{type:'object',additionalProperties:false,required:['webhookId'],properties:{webhookId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},async request=>{const partner=requirePartnerScope(request,'webhooks:write');return options.service.testWebhook({webhookId:request.params.webhookId,partnerId:partner.partnerId,environment:partner.environment});});

    fastify.put<{
      Params: { webhookId: string };
      Body: { subscribedEvents: ExternalEventType[] };
    }>(
      '/webhooks/:webhookId/subscriptions',
      {
        config: { rawBody: true },
        preHandler: partnerAuth,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['webhookId'],
            properties: {
              webhookId: {
                type: 'string',
                pattern: '^[a-fA-F0-9]{24}$',
              },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['subscribedEvents'],
            properties: {
              subscribedEvents: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: { enum: [...EXTERNAL_EVENT_TYPES] },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const partner = requirePartnerScope(request, 'webhooks:write');
        await options.service.replaceWebhookSubscriptions({
          webhookId: request.params.webhookId,
          partnerId: partner.partnerId,
          environment: partner.environment,
          subscribedEvents: request.body.subscribedEvents,
        });
        return reply.status(204).send();
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
        requireAdminRole(request);
        await options.service.verifyWebhook(request.params.webhookId);
        return reply.status(204).send();
      },
    );
  };

export default partnerAccessRoutes;
