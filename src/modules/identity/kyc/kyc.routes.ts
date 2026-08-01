import type { FastifyPluginAsync } from 'fastify';

import { AppError } from '../../../shared/errors/app-error.js';
import type { AdminAuthService } from '../platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  createOwnerAuthenticationHook,
  createPartnerPortalAuthenticationHook,
  requireAdminRole,
  requireAdminContext,
  requireOwnerContext,
  requirePartnerPortalContext,
} from '../shared/auth-context.js';
import type { KycService } from './kyc.service.js';
import type { OwnerAccessService } from '../owner/owner-access.service.js';
import type { PartnerAccessService } from '../partner/partner-access.service.js';

export interface KycRoutesOptions {
  service: KycService;
  ownerAccessService: OwnerAccessService;
  adminAuthService: AdminAuthService;
  partnerAccessService?: PartnerAccessService;
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
  if (options.partnerAccessService) {
  const partnerPortalAuth = createPartnerPortalAuthenticationHook(options.partnerAccessService);

  fastify.post<{ Body: { verificationType: string } }>('/partner/verifications', {
    preHandler: partnerPortalAuth,
    schema: { body: { type: 'object', additionalProperties: false, required: ['verificationType'], properties: { verificationType: { type: 'string', minLength: 2, maxLength: 100 } } } },
  }, async (request, reply) => {
    const partner = requirePartnerPortalContext(request);
    return reply.status(201).send(await options.service.createDraft({ subjectType: 'PARTNER', subjectId: partner.partnerId, verificationType: request.body.verificationType }));
  });

  fastify.post<{ Params: { verificationId: string }; Querystring: { documentType: string } }>('/partner/verifications/:verificationId/documents', {
    preHandler: partnerPortalAuth,
    schema: { params: { type: 'object', additionalProperties: false, required: ['verificationId'], properties: { verificationId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } }, querystring: { type: 'object', additionalProperties: false, required: ['documentType'], properties: { documentType: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,99}$' } } } },
  }, async (request, reply) => {
    const partner = requirePartnerPortalContext(request); const part = await request.file();
    if (!part) throw new AppError({ code: 'KYC_FILE_REQUIRED', message: 'A multipart file is required', statusCode: 400 });
    return reply.status(201).send(await options.service.uploadDocument({ verificationId: request.params.verificationId, subjectId: partner.partnerId, documentType: request.query.documentType, filename: part.filename, mimeType: part.mimetype, buffer: await part.toBuffer() }));
  });

  fastify.post<{ Params: { verificationId: string } }>('/partner/verifications/:verificationId/submit', {
    preHandler: partnerPortalAuth,
    schema: { params: { type: 'object', additionalProperties: false, required: ['verificationId'], properties: { verificationId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } } },
  }, async (request, reply) => { const partner=requirePartnerPortalContext(request); await options.service.submit({ verificationId:request.params.verificationId,subjectId:partner.partnerId,correlationId:request.id }); return reply.status(204).send(); });

  fastify.get<{ Params: { verificationType: string } }>('/partner/verifications/current/:verificationType', {
    preHandler: partnerPortalAuth,
    schema: { params: { type: 'object', additionalProperties: false, required: ['verificationType'], properties: { verificationType: { type: 'string', minLength: 2, maxLength: 100 } } } },
  }, async(request)=>{const partner=requirePartnerPortalContext(request);return options.service.getCurrent({subjectType:'PARTNER',subjectId:partner.partnerId,verificationType:request.params.verificationType});});
  fastify.patch<{Params:{verificationId:string;documentId:string};Body:{documentType:string;details:Record<string,string>}}>('/partner/verifications/:verificationId/documents/:documentId/details',{preHandler:partnerPortalAuth,schema:documentDetailsSchema()},async(request,reply)=>{const partner=requirePartnerPortalContext(request);await options.service.updateDocumentDetails!({verificationId:request.params.verificationId,documentId:request.params.documentId,subjectId:partner.partnerId,...request.body});return reply.status(204).send();});
  fastify.get<{Params:{verificationId:string}}>('/partner/verifications/:verificationId/documents',{preHandler:partnerPortalAuth,schema:{params:verificationParams()}},async request=>options.service.listDocuments!({verificationId:request.params.verificationId,subjectId:requirePartnerPortalContext(request).partnerId}));
  }

  fastify.patch<{Params:{verificationId:string;documentId:string};Body:{documentType:string;details:Record<string,string>}}>('/owner/verifications/:verificationId/documents/:documentId/details',{preHandler:ownerAuth,schema:documentDetailsSchema()},async(request,reply)=>{const owner=requireOwnerContext(request);await options.service.updateDocumentDetails!({verificationId:request.params.verificationId,documentId:request.params.documentId,subjectId:owner.ownerId,...request.body});return reply.status(204).send();});
  fastify.get<{Params:{verificationId:string}}>('/owner/verifications/:verificationId/documents',{preHandler:ownerAuth,schema:{params:verificationParams()}},async request=>options.service.listDocuments!({verificationId:request.params.verificationId,subjectId:requireOwnerContext(request).ownerId}));

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
        throw new AppError({
          code: 'KYC_FILE_REQUIRED',
          message: 'A multipart file is required',
          statusCode: 400,
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

  fastify.patch<{Params:{partnerId:string;verificationId:string;documentId:string};Body:{documentType:string;details:Record<string,string>}}>(
    '/admin/partners/:partnerId/verifications/:verificationId/documents/:documentId/details',
    {preHandler:adminAuth,schema:{...documentDetailsSchema(),params:{type:'object',additionalProperties:false,required:['partnerId','verificationId','documentId'],properties:{partnerId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},documentId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},
    async(request,reply)=>{requireAdminRole(request);await options.service.updateDocumentDetails!({verificationId:request.params.verificationId,documentId:request.params.documentId,subjectId:request.params.partnerId,...request.body});return reply.status(204).send();},
  );
  fastify.get<{Params:{partnerId:string;verificationId:string}}>(
    '/admin/partners/:partnerId/verifications/:verificationId/documents',
    {preHandler:adminAuth,schema:{params:{type:'object',additionalProperties:false,required:['partnerId','verificationId'],properties:{partnerId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},
    async request=>{requireAdminRole(request);return options.service.listDocuments!({verificationId:request.params.verificationId,subjectId:request.params.partnerId});},
  );
  fastify.get<{Params:{ownerId:string;verificationId:string}}>(
    '/admin/owners/:ownerId/verifications/:verificationId/documents',
    {preHandler:adminAuth,schema:{params:{type:'object',additionalProperties:false,required:['ownerId','verificationId'],properties:{ownerId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},
    async request=>{requireAdminRole(request);return options.service.listDocuments!({verificationId:request.params.verificationId,subjectId:request.params.ownerId});},
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
        correlationId: request.id,
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
      const admin = requireAdminRole(request);
      await options.service.review({
        verificationId: request.params.verificationId,
        adminId: admin.adminId,
        correlationId: request.id,
        ...request.body,
      });
      return reply.status(204).send();
    },
  );

  fastify.post<{Params:{verificationId:string};Body:{status:'APPROVED'|'REJECTED';checklist:Record<string,boolean>;notes?:string}}>(
    '/admin/verifications/:verificationId/preliminary-review',
    {preHandler:adminAuth,schema:{params:{type:'object',additionalProperties:false,required:['verificationId'],properties:{verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}},body:{type:'object',additionalProperties:false,required:['status','checklist'],properties:{status:{enum:['APPROVED','REJECTED']},checklist:{type:'object',additionalProperties:false,required:['documentReadable','detailsMatch','gstChecked','panChecked','bankChecked','aadhaarMasked'],properties:{documentReadable:{type:'boolean'},detailsMatch:{type:'boolean'},gstChecked:{type:'boolean'},panChecked:{type:'boolean'},bankChecked:{type:'boolean'},aadhaarMasked:{type:'boolean'}}},notes:{type:'string',maxLength:2000}}}}},
    async(request,reply)=>{const actor=requireAdminContext(request);if(actor.role==='SUPPORT')throw new AppError({code:'KYC_REVIEW_ROLE_REQUIRED',message:'ADMIN or OPS role is required for preliminary KYC review',statusCode:403});if(!options.service.preliminaryReview)throw new AppError({code:'KYC_PRELIMINARY_REVIEW_UNAVAILABLE',message:'Preliminary KYC review is unavailable',statusCode:503});await options.service.preliminaryReview({verificationId:request.params.verificationId,reviewerId:actor.adminId,correlationId:request.id,...request.body});return reply.status(204).send();},
  );

  fastify.post<{
    Params: { partnerId: string };
    Body: { verificationType: string };
  }>(
    '/admin/partners/:partnerId/verifications',
    { preHandler: adminAuth },
    async (request, reply) => {
      requireAdminRole(request);
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
      requireAdminRole(request);
      const part = await request.file();

      if (!part) {
        throw new AppError({
          code: 'KYC_FILE_REQUIRED',
          message: 'A multipart file is required',
          statusCode: 400,
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
      requireAdminRole(request);
      await options.service.submit({
        verificationId: request.params.verificationId,
        subjectId: request.params.partnerId,
        correlationId: request.id,
      });
      return reply.status(204).send();
    },
  );
};

export default kycRoutes;

function documentDetailsSchema(){return{params:{type:'object',additionalProperties:false,required:['verificationId','documentId'],properties:{verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},documentId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}},body:{type:'object',additionalProperties:false,required:['documentType','details'],properties:{documentType:{enum:['GST_CERTIFICATE','PAN','PASSBOOK','AADHAAR']},details:{type:'object',minProperties:2,maxProperties:8,additionalProperties:{type:'string',minLength:1,maxLength:200}}}}};}
function verificationParams(){return{type:'object',additionalProperties:false,required:['verificationId'],properties:{verificationId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}} as const;}
