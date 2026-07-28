import type { FastifyPluginAsync } from 'fastify';

import type { IdentityService } from './owner-auth.service.js';
import type {
  LoginVenueOwnerInput,
  RegisterVenueOwnerInput,
} from './owner.types.js';

interface IdentityRoutesOptions {
  service: IdentityService;
}

const registerSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['legalName', 'email', 'phoneE164', 'password', 'venue'],
    properties: {
      legalName: { type: 'string', minLength: 2, maxLength: 200 },
      email: { type: 'string', format: 'email', maxLength: 320 },
      phoneE164: {
        type: 'string',
        pattern: '^\\+[1-9][0-9]{7,14}$',
      },
      password: { type: 'string', minLength: 12, maxLength: 128 },
      venue: {
        type: 'object',
        additionalProperties: false,
        required: [
          'legalName',
          'displayName',
          'timezone',
          'address',
          'latitude',
          'longitude',
        ],
        properties: {
          legalName: { type: 'string', minLength: 2, maxLength: 200 },
          displayName: { type: 'string', minLength: 2, maxLength: 200 },
          timezone: { type: 'string', minLength: 3, maxLength: 100 },
          address: {
            type: 'object',
            additionalProperties: false,
            required: [
              'line1',
              'city',
              'state',
              'postalCode',
              'country',
            ],
            properties: {
              line1: { type: 'string', minLength: 2, maxLength: 200 },
              line2: { type: 'string', maxLength: 200 },
              city: { type: 'string', minLength: 2, maxLength: 100 },
              state: { type: 'string', minLength: 2, maxLength: 100 },
              postalCode: { type: 'string', minLength: 3, maxLength: 20 },
              country: {
                type: 'string',
                minLength: 2,
                maxLength: 2,
              },
            },
          },
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  },
} as const;

const loginSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 320 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
} as const;

const identityRoutes: FastifyPluginAsync<IdentityRoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.post<{ Body: RegisterVenueOwnerInput }>(
    '/register',
    { schema: registerSchema },
    async (request, reply) => {
      const result = await options.service.registerVenueOwner(request.body);
      return reply.status(201).send(result);
    },
  );

  fastify.post<{
    Body: Pick<LoginVenueOwnerInput, 'email' | 'password'>;
  }>('/login', { schema: loginSchema }, async (request) => {
    return options.service.loginVenueOwner({
      ...request.body,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? 'unknown',
    });
  });
};

export default identityRoutes;
