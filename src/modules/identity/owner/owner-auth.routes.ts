import type { FastifyPluginAsync } from 'fastify';

import { maskPhone } from './msg91-otp.provider.js';
import type { IdentityService } from './owner-auth.service.js';
import type {
  LoginVenueOwnerInput,
  OtpLoginVenueOwnerInput,
  RegisterVenueOwnerInput,
} from './owner.types.js';

interface IdentityRoutesOptions {
  service: IdentityService;
}

const registerSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['legalName', 'email', 'phoneE164', 'venue'],
    // Exactly one credential path — the legacy password path is kept only until every client
    // has moved to phone+OTP registration (see the phone-login migration plan).
    oneOf: [{ required: ['password'] }, { required: ['accessToken'] }],
    properties: {
      legalName: { type: 'string', minLength: 2, maxLength: 200 },
      email: { type: 'string', format: 'email', maxLength: 320 },
      phoneE164: {
        type: 'string',
        pattern: '^\\+[1-9][0-9]{7,14}$',
      },
      password: { type: 'string', minLength: 12, maxLength: 128 },
      accessToken: { type: 'string', minLength: 1, maxLength: 4096 },
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
            required: ['line1', 'city', 'state', 'postalCode', 'country'],
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

const otpLoginSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['phoneE164', 'accessToken'],
    properties: {
      phoneE164: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
      accessToken: { type: 'string', minLength: 1, maxLength: 4096 },
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
      const phone = maskPhone(request.body.phoneE164 ?? '');
      const credential = request.body.accessToken ? 'otp' : 'password';
      request.log.info({ phone, credential }, 'Owner registration attempt');
      try {
        const result = await options.service.registerVenueOwner(request.body);
        request.log.info(
          { phone, credential, ownerId: result.ownerId, venueId: result.venueId },
          'Owner registration succeeded',
        );
        return reply.status(201).send(result);
      } catch (error) {
        request.log.warn(
          { phone, credential, code: (error as { code?: string }).code ?? 'UNKNOWN' },
          'Owner registration failed',
        );
        throw error;
      }
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

  fastify.post<{
    Body: Pick<OtpLoginVenueOwnerInput, 'phoneE164' | 'accessToken'>;
  }>('/otp/verify', { schema: otpLoginSchema }, async (request) => {
    const phone = maskPhone(request.body.phoneE164);
    request.log.info({ phone }, 'Owner OTP sign-in attempt');
    try {
      const result = await options.service.loginVenueOwnerWithOtp({
        ...request.body,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? 'unknown',
      });
      request.log.info(
        { phone, ownerId: result.owner.id },
        'Owner OTP sign-in succeeded',
      );
      return result;
    } catch (error) {
      // Re-thrown for the error handler; logged here because the code is what distinguishes an
      // unknown number from a replayed token from an unconfigured provider — all three look
      // the same from the client.
      request.log.warn(
        { phone, code: (error as { code?: string }).code ?? 'UNKNOWN' },
        'Owner OTP sign-in failed',
      );
      throw error;
    }
  });
};

export default identityRoutes;
