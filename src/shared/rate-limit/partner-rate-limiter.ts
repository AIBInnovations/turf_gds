import type { RedisClientType } from 'redis';

export type RateLimitTier = 'STARTER' | 'STANDARD' | 'ENTERPRISE';
export type RateLimitEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  source: 'REDIS' | 'MONGODB';
}

export interface RateLimitFallback {
  consumeRateLimitWindow(input: {
    partnerId: string;
    environment: RateLimitEnvironment;
    limit: number;
    windowStartedAt: Date;
    now: Date;
  }): Promise<{ count: number }>;
}

export interface PartnerRateLimiter {
  consume(input: {
    partnerId: string;
    environment: RateLimitEnvironment;
    tier: RateLimitTier;
    now?: Date;
  }): Promise<RateLimitDecision>;
}

export interface PartnerRateLimiterOptions {
  redis: RedisClientType | null;
  fallback: RateLimitFallback;
  keyPrefix: string;
  limits?: Record<RateLimitTier, number>;
}

const DEFAULT_LIMITS: Record<RateLimitTier, number> = {
  STARTER: 100,
  STANDARD: 300,
  ENTERPRISE: 1_000,
};

export function createPartnerRateLimiter(
  options: PartnerRateLimiterOptions,
): PartnerRateLimiter {
  const limits = options.limits ?? DEFAULT_LIMITS;

  return {
    async consume(input) {
      const now = input.now ?? new Date();
      const windowStartedAt = minuteStart(now);
      const resetAt = new Date(windowStartedAt.getTime() + 60_000);
      const limit = limits[input.tier];

      if (options.redis?.isReady) {
        try {
          const key = [
            options.keyPrefix,
            'rate-limit',
            input.environment,
            input.partnerId,
            windowStartedAt.toISOString(),
          ].join(':');
          const count = Number(await options.redis.eval(
            "local c=redis.call('INCR',KEYS[1]); " +
              "if c==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; " +
              'return c',
            { keys: [key], arguments: ['120000'] },
          ));
          return decision(count, limit, resetAt, 'REDIS');
        } catch {
          // MongoDB is the deliberate correctness fallback.
        }
      }

      const result = await options.fallback.consumeRateLimitWindow({
        partnerId: input.partnerId,
        environment: input.environment,
        limit,
        windowStartedAt,
        now,
      });
      return decision(result.count, limit, resetAt, 'MONGODB');
    },
  };
}

function minuteStart(value: Date): Date {
  const result = new Date(value);
  result.setUTCSeconds(0, 0);
  return result;
}

function decision(
  count: number,
  limit: number,
  resetAt: Date,
  source: RateLimitDecision['source'],
): RateLimitDecision {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    source,
  };
}
