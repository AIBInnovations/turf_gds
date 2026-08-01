import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminContext,
} from '../identity/shared/auth-context.js';
import { AppError } from '../../shared/errors/app-error.js';
import type {
  ContractService,
  SaveContractInput,
} from './contract.service.js';

export interface ContractRoutesOptions {
  service: ContractService;
  adminAuthService: AdminAuthService;
}

const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } as const;
const bps = { type: 'integer', minimum: 0, maximum: 10_000 } as const;

const contractRoutes: FastifyPluginAsync<ContractRoutesOptions> =
  async (fastify, options) => {
    const authenticate = createAdminAuthenticationHook(
      options.adminAuthService,
    );

    fastify.post<{ Body: Omit<SaveContractInput, 'adminId'> }>(
      '/',
      {
        preHandler: authenticate,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: [
              'partnerId',
              'venueId',
              'commissionRateBps',
              'taxRateBps',
              'settlementCycle',
              'settlementLagDays',
              'allowedBookingModes',
              'effectiveFrom',
            ],
            properties: {
              partnerId: objectId,
              venueId: objectId,
              commissionRateBps: bps,
              taxRateBps: bps,
              settlementCycle: {
                type: 'string',
                enum: ['T_PLUS_N', 'WEEKLY', 'MONTHLY'],
              },
              settlementLagDays: { type: 'integer', minimum: 0 },
              allowedBookingModes: {
                type: 'string',
                enum: ['OPEN_TIME', 'FIXED_SLOT', 'BOTH'],
              },
              cancellationTerms: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'cancellationAllowed',
                  'defaultRefundBps',
                  'releaseInventory',
                ],
                properties: {
                  cancellationAllowed: { type: 'boolean' },
                  defaultRefundBps: bps,
                  releaseInventory: { type: 'boolean' },
                },
              },
              refundRules: {
                type: 'array',
                maxItems: 50,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'minMinutesBeforeStart',
                    'refundBps',
                    'releaseInventory',
                  ],
                  properties: {
                    minMinutesBeforeStart: {
                      type: 'integer',
                      minimum: 0,
                    },
                    refundBps: bps,
                    releaseInventory: { type: 'boolean' },
                  },
                },
              },
              resaleCutoffMinutes: { type: 'integer', minimum: 0 },
              effectiveFrom: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      async (request, reply) => {
        const admin = requireAdminContext(request);
        if (admin.role !== 'ADMIN') {
          throw new AppError({
            code: 'ADMIN_ROLE_REQUIRED',
            message: 'The ADMIN role is required to configure contracts',
            statusCode: 403,
          });
        }
        const contract = await options.service.saveVersion({
          adminId: admin.adminId,
          ...request.body,
        });
        return reply.status(201).send(contract);
      },
    );

    fastify.get<{
      Querystring: { partnerId?: string; venueId?: string };
    }>(
      '/',
      {
        preHandler: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              partnerId: objectId,
              venueId: objectId,
            },
          },
        },
      },
      async (request) => {
        requireAdminContext(request);
        return options.service.list(request.query);
      },
    );

    fastify.get<{ Params: { contractId: string } }>(
      '/:contractId',
      {
        preHandler: authenticate,
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['contractId'],
            properties: { contractId: objectId },
          },
        },
      },
      async (request) => {
        requireAdminContext(request);
        return options.service.get(request.params.contractId);
      },
    );
  };

export default contractRoutes;
