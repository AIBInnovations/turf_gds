import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { AppConfig } from '../config/env.js';
import { AppError } from '../shared/errors/app-error.js';
import type {
  IpRateLimitDecision,
  IpRateLimiter,
} from '../shared/rate-limit/ip-rate-limiter.js';

declare module 'fastify' {
  interface FastifyRequest {
    ipRateLimit?: IpRateLimitDecision;
  }
}

export interface IpRateLimitPluginOptions {
  config: AppConfig['ipRateLimit'];
  limiter: IpRateLimiter;
}

export type IpRateLimitBucket = 'AUTH' | 'SIGNED' | 'GLOBAL' | 'SKIP';

/** Infrastructure probes must never be throttled. */
const SKIP_ROUTES = new Set(['/health', '/ready', '/metrics']);

/** The credential-stuffing and account-lockout-DoS surface. */
const AUTH_ROUTES = new Set([
  '/api/v1/auth/venue-owners/login',
  '/api/v1/auth/venue-owners/register',
  '/api/v1/auth/venue-owners/otp/verify',
  '/api/v1/auth/admin/login',
  '/api/v1/auth/admin/otp/verify',
  '/api/v1/partners/auth/login',
  // Unauthenticated Partner signup.
  '/api/v1/partners/applications',
]);

/** Signed endpoints that do not carry `config.rawBody`. */
const SIGNED_ROUTES = new Set([
  '/api/v1/inventory-connectors/reference/:connectorId/events',
  '/api/v1/provider-webhooks/razorpay',
]);

/**
 * Table-driven so it is directly testable against every registered route
 * pattern rather than only through the HTTP surface.
 */
export function resolveIpRateLimitBucket(
  routeUrl: string | undefined,
  routeConfig: { rawBody?: boolean } | undefined,
): IpRateLimitBucket {
  if (routeUrl !== undefined && SKIP_ROUTES.has(routeUrl)) return 'SKIP';
  if (routeUrl !== undefined && AUTH_ROUTES.has(routeUrl)) return 'AUTH';
  // Partner HMAC routes all opt into raw-body capture. Every *failed*
  // signature check costs an HMAC plus a Mongo lookup, and the per-partner
  // limiter cannot run until authentication has already succeeded.
  if (routeConfig?.rawBody === true) return 'SIGNED';
  if (routeUrl !== undefined && SIGNED_ROUTES.has(routeUrl)) return 'SIGNED';
  // Unmatched routes (404 scans) land here deliberately.
  return 'GLOBAL';
}

const ipRateLimitPlugin: FastifyPluginAsync<IpRateLimitPluginOptions> = async (
  fastify,
  options,
) => {
  if (!options.config.enabled) return;

  fastify.addHook('onRequest', async (request) => {
    const routeConfig = request.routeOptions?.config as
      { rawBody?: boolean } | undefined;
    const bucket = resolveIpRateLimitBucket(
      request.routeOptions?.url,
      routeConfig,
    );
    if (bucket === 'SKIP') return;

    const ip = request.ip;
    const checks =
      bucket === 'AUTH'
        ? [
            {
              scope: 'AUTH_BURST' as const,
              limit: options.config.authBurstLimit,
              windowMs: 60_000,
            },
            {
              scope: 'AUTH_SUSTAINED' as const,
              limit: options.config.authSustainedLimit,
              windowMs: 3_600_000,
            },
          ]
        : [
            {
              scope: bucket,
              limit:
                bucket === 'SIGNED'
                  ? options.config.signedLimit
                  : options.config.globalLimit,
              windowMs: 60_000,
            },
          ];

    let worst: IpRateLimitDecision | undefined;
    for (const check of checks) {
      const decision = await options.limiter.consume({
        scope: check.scope,
        ip,
        limit: check.limit,
        windowMs: check.windowMs,
        now: new Date(),
      });
      // Report whichever window is closest to its ceiling, and deny if either
      // is exceeded.
      if (!worst || decision.remaining < worst.remaining) worst = decision;
      if (!decision.allowed) worst = decision;
      if (!decision.allowed) break;
    }

    if (!worst) return;
    request.ipRateLimit = worst;
    if (!worst.allowed) {
      throw new AppError({
        code: 'IP_RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this network address',
        statusCode: 429,
        details: {
          limit: worst.limit,
          remaining: 0,
          resetAt: worst.resetAt.toISOString(),
          scope: worst.scope,
        },
      });
    }
  });
};

export default fp(ipRateLimitPlugin, {
  name: 'ip-rate-limit',
  fastify: '5.x',
});
