import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

import { AppError } from '../../../shared/errors/app-error.js';
import type { AdminAuthService } from '../platform/auth.service.js';
import type { OwnerAccessService } from '../owner/owner-access.service.js';
import type { PartnerAccessService } from '../partner/partner-access.service.js';
import type { RateLimitDecision } from '../../../shared/rate-limit/partner-rate-limiter.js';

export type IdentityContext =
  | {
      actorType: 'OWNER';
      ownerId: string;
      status: 'PENDING' | 'ACTIVE';
    }
  | {
      actorType: 'ADMIN';
      adminId: string;
      role: 'ADMIN' | 'OPS' | 'SUPPORT';
    }
  | {
      actorType: 'PARTNER';
      partnerId: string;
      keyId: string;
      environment: 'SANDBOX' | 'PRODUCTION';
      scopes: string[];
    };

declare module 'fastify' {
  interface FastifyRequest {
    identity?: IdentityContext;
    partnerRateLimit?: RateLimitDecision;
  }
}

export function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    throw authenticationRequired();
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    throw authenticationRequired();
  }

  return token;
}

export function createOwnerAuthenticationHook(
  service: OwnerAccessService,
): preHandlerHookHandler {
  return async (request) => {
    request.identity = await service.authenticateOwner(
      getBearerToken(request),
    );
  };
}

export function createAdminAuthenticationHook(
  service: AdminAuthService,
): preHandlerHookHandler {
  return async (request) => {
    request.identity = await service.authenticate(getBearerToken(request));
  };
}

export function createPartnerAuthenticationHook(
  service: PartnerAccessService,
): preHandlerHookHandler {
  return async (request) => {
    const apiKey = request.headers['x-api-key'];
    const signature = request.headers['x-signature'];
    const timestamp = request.headers['x-timestamp'];

    if (
      typeof apiKey !== 'string' ||
      typeof signature !== 'string' ||
      typeof timestamp !== 'string'
    ) {
      throw authenticationRequired();
    }

    const identity = await service.authenticateRequest({
      apiKey,
      signature,
      timestamp,
      method: request.method,
      path: request.url,
      body:
        typeof request.rawBody === 'string'
          ? Buffer.from(request.rawBody, 'utf8')
          : request.rawBody ?? Buffer.alloc(0),
    });
    request.identity = identity;
    if (!service.consumeRateLimit) return;
    const rateLimit = await service.consumeRateLimit({
      partnerId: identity.partnerId,
      environment: identity.environment,
    });
    request.partnerRateLimit = rateLimit;
    if (!rateLimit.allowed) {
      throw new AppError({
        code: 'PARTNER_RATE_LIMIT_EXCEEDED',
        message: 'The Partner request rate limit has been exceeded',
        statusCode: 429,
        details: {
          limit: rateLimit.limit,
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt.toISOString(),
          source: rateLimit.source,
        },
      });
    }
  };
}

export function requireOwnerContext(
  request: FastifyRequest,
): Extract<IdentityContext, { actorType: 'OWNER' }> {
  if (request.identity?.actorType !== 'OWNER') {
    throw authenticationRequired();
  }

  return request.identity;
}

export function requireAdminContext(
  request: FastifyRequest,
): Extract<IdentityContext, { actorType: 'ADMIN' }> {
  if (request.identity?.actorType !== 'ADMIN') {
    throw authenticationRequired();
  }

  return request.identity;
}

export function requireAdminRole(
  request: FastifyRequest,
): Omit<
  Extract<IdentityContext, { actorType: 'ADMIN' }>,
  'role'
> & { role: 'ADMIN' } {
  const admin = requireAdminContext(request);
  if (admin.role !== 'ADMIN') {
    throw new AppError({
      code: 'ADMIN_ROLE_REQUIRED',
      message: 'The ADMIN role is required for this operation',
      statusCode: 403,
    });
  }
  return { ...admin, role: 'ADMIN' };
}

export function requirePartnerContext(
  request: FastifyRequest,
): Extract<IdentityContext, { actorType: 'PARTNER' }> {
  if (request.identity?.actorType !== 'PARTNER') {
    throw authenticationRequired();
  }

  return request.identity;
}

export function requirePartnerScope(
  request: FastifyRequest,
  scope: string,
): Extract<IdentityContext, { actorType: 'PARTNER' }> {
  const partner = requirePartnerContext(request);

  if (!partner.scopes.includes(scope)) {
    throw new AppError({
      code: 'PARTNER_SCOPE_REQUIRED',
      message: `The ${scope} scope is required`,
      statusCode: 403,
    });
  }

  return partner;
}

function authenticationRequired(): AppError {
  return new AppError({
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Valid authentication is required',
    statusCode: 401,
  });
}
