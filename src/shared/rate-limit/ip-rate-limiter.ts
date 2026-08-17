import { createHash, createHmac } from 'node:crypto';

import type { RedisClientType } from 'redis';

/**
 * Pre-authentication rate limiting, keyed on the client address.
 *
 * The Partner limiter only runs after `authenticateRequest` succeeds, so
 * without this the login endpoints and every *failed* HMAC verification are
 * unthrottled — and the HMAC path does scrypt plus a Mongo lookup before it can
 * reject anything.
 */
export type IpRateLimitScope =
  'AUTH_BURST' | 'AUTH_SUSTAINED' | 'SIGNED' | 'GLOBAL';

export interface IpRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  scope: IpRateLimitScope;
  source: 'REDIS' | 'MONGODB' | 'UNAVAILABLE';
}

export interface IpRateLimitFallback {
  consumeIpRateLimitWindow(input: {
    scope: IpRateLimitScope;
    ipHash: string;
    windowStartedAt: Date;
    windowMs: number;
    now: Date;
  }): Promise<{ count: number }>;
}

export interface IpRateLimiterOptions {
  redis: RedisClientType | null;
  fallback: IpRateLimitFallback;
  keyPrefix: string;
  /** Allow the request when both Redis and MongoDB are unavailable. */
  failOpen?: boolean;
  hashIp?: (ip: string) => string;
  log?: (message: string, values: Record<string, unknown>) => void;
}

export interface IpRateLimiter {
  consume(input: {
    scope: IpRateLimitScope;
    ip: string;
    limit: number;
    windowMs: number;
    now?: Date;
  }): Promise<IpRateLimitDecision>;
}

/**
 * Pseudonymises the address before it is stored or logged.
 *
 * With a secret this is an HMAC. Without one it is a bare SHA-256, matching the
 * existing audit-trail convention — but be honest about what that is: an IPv4
 * space is 2^32, so a plain digest is brute-forceable. Set `IP_HASH_SECRET` in
 * production.
 */
export function createIpHasher(secret?: string): (ip: string) => string {
  if (secret) {
    return (ip) =>
      createHmac('sha256', secret).update(ip.slice(0, 64)).digest('hex');
  }
  return (ip) => createHash('sha256').update(ip.slice(0, 64)).digest('hex');
}

export function createIpRateLimiter(
  options: IpRateLimiterOptions,
): IpRateLimiter {
  const hashIp = options.hashIp ?? createIpHasher();
  const failOpen = options.failOpen ?? true;
  let lastUnavailableLog = 0;

  function reportUnavailable(error: unknown, now: Date): void {
    // Once a minute, not once a request: a dependency outage must not itself
    // become a log flood.
    if (now.getTime() - lastUnavailableLog < 60_000) return;
    lastUnavailableLog = now.getTime();
    options.log?.('IP rate limiter unavailable', {
      error: error instanceof Error ? error.message : String(error),
      failOpen,
    });
  }

  return {
    async consume(input) {
      const now = input.now ?? new Date();
      const windowStartedAt = new Date(
        Math.floor(now.getTime() / input.windowMs) * input.windowMs,
      );
      const resetAt = new Date(windowStartedAt.getTime() + input.windowMs);
      const ipHash = hashIp(input.ip);

      if (options.redis?.isReady) {
        try {
          const key = [
            options.keyPrefix,
            'ip-rate-limit',
            input.scope,
            ipHash,
            windowStartedAt.toISOString(),
          ].join(':');
          const count = Number(
            await options.redis.eval(
              "local c=redis.call('INCR',KEYS[1]); " +
                "if c==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; " +
                'return c',
              { keys: [key], arguments: [String(input.windowMs * 2)] },
            ),
          );
          return decision(count, input, resetAt, 'REDIS');
        } catch {
          // MongoDB is the deliberate correctness fallback.
        }
      }

      try {
        const result = await options.fallback.consumeIpRateLimitWindow({
          scope: input.scope,
          ipHash,
          windowStartedAt,
          windowMs: input.windowMs,
          now,
        });
        return decision(result.count, input, resetAt, 'MONGODB');
      } catch (error) {
        reportUnavailable(error, now);
        // Fail open by default: if MongoDB is down every business route is
        // already failing, and refusing traffic on top of that converts a
        // degraded dependency into a total outage.
        return {
          allowed: failOpen,
          limit: input.limit,
          remaining: 0,
          resetAt,
          scope: input.scope,
          source: 'UNAVAILABLE',
        };
      }
    },
  };
}

function decision(
  count: number,
  input: { scope: IpRateLimitScope; limit: number },
  resetAt: Date,
  source: 'REDIS' | 'MONGODB',
): IpRateLimitDecision {
  return {
    allowed: count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    resetAt,
    scope: input.scope,
    source,
  };
}
