import 'dotenv/config';

export const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
export const LOG_LEVEL_VALUES = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type NodeEnvironment = (typeof NODE_ENV_VALUES)[number];
export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: LogLevel;
  readinessCacheTtlMs: number;
  runMigrationsOnStartup?: boolean;
  /**
   * Passed straight to Fastify. `false` means `request.ip` is the socket peer.
   * MUST be set before deploying behind a load balancer, or every client
   * appears as the balancer and the IP rate limiter becomes one global bucket.
   */
  trustProxy: boolean | string;
  ipRateLimit: {
    enabled: boolean;
    /** Deny when both Redis and MongoDB are unavailable. */
    failClosed: boolean;
    authBurstLimit: number;
    authSustainedLimit: number;
    signedLimit: number;
    globalLimit: number;
    hashSecret?: string;
  };
  metrics: {
    enabled: boolean;
    path: string;
    authToken?: string;
    /** Exact addresses allowed to scrape without a token. */
    allowedIps: string[];
  };
  mongodb: {
    uri: string;
    database: string;
    serverSelectionTimeoutMs: number;
    maxPoolSize: number;
  };
  redis?: {
    url?: string;
    connectTimeoutMs: number;
    keyPrefix: string;
  };
  auth: {
    sessionTtlHours: number;
    maxSessions: number;
    maxLoginAttempts: number;
    lockMinutes: number;
    adminAccessTokenSecret: string;
    adminAccessTokenTtlMinutes: number;
    partnerCredentialMasterSecret: string;
    partnerHmacMaxSkewSeconds: number;
  };
  kyc: {
    maxFileBytes: number;
    allowedMimeTypes: string[];
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
    folder: string;
  };
  communications: {
    pollIntervalMs: number;
    batchSize: number;
    leaseSeconds: number;
    requestTimeoutMs: number;
    maxWebhookAttempts: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  };
  fcm: {
    enabled: boolean;
    projectId?: string;
    clientEmail?: string;
    privateKey?: string;
  };
  adminOperations?: {
    inventoryMinimumCoverageDays: number;
  };
  razorpay?: {
    enabled: boolean;
    keyId?: string;
    keySecret?: string;
    webhookSecret?: string;
    accountNumber?: string;
    baseUrl: string;
  };
  msg91?: {
    enabled: boolean;
    /** Server-side account auth key for verifyAccessToken. Never shipped to clients. */
    authKey?: string;
    /** Verification host — distinct from the client SDK's control.msg91.com. */
    baseUrl: string;
  };
}

function readEnum<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const candidate = value ?? fallback;

  if (!allowed.includes(candidate as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }

  return candidate as T;
}

function readRequired(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function readSecret(name: string, value: string | undefined): string {
  const secret = readRequired(name, value);

  if (secret.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }

  return secret;
}

function readInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function readBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * `true` trusts any `X-Forwarded-For`, which lets a client forge — or poison —
 * its own rate-limit bucket. Prefer a CIDR/hop list, which Fastify passes to
 * proxy-addr.
 */
function readTrustProxy(value: string | undefined): boolean | string {
  const normalized = value?.trim();
  if (!normalized) return false;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return normalized;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fcmEnabled = readBoolean('FCM_ENABLED', env.FCM_ENABLED, false);
  const fcm = fcmEnabled
    ? {
        enabled: true,
        projectId: readRequired('FCM_PROJECT_ID', env.FCM_PROJECT_ID),
        clientEmail: readRequired('FCM_CLIENT_EMAIL', env.FCM_CLIENT_EMAIL),
        privateKey: readRequired(
          'FCM_PRIVATE_KEY',
          env.FCM_PRIVATE_KEY,
        ).replace(/\\n/g, '\n'),
      }
    : { enabled: false };
  const razorpayEnabled = readBoolean(
    'RAZORPAY_ENABLED',
    env.RAZORPAY_ENABLED,
    false,
  );
  const msg91Enabled = readBoolean('MSG91_ENABLED', env.MSG91_ENABLED, false);
  const config: AppConfig = {
    nodeEnv: readEnum('NODE_ENV', env.NODE_ENV, NODE_ENV_VALUES, 'development'),
    host: env.HOST?.trim() || '0.0.0.0',
    port: readInteger('PORT', env.PORT, 3000, 1, 65_535),
    logLevel: readEnum('LOG_LEVEL', env.LOG_LEVEL, LOG_LEVEL_VALUES, 'info'),
    readinessCacheTtlMs: readInteger(
      'READINESS_CACHE_TTL_MS',
      env.READINESS_CACHE_TTL_MS,
      60_000,
      0,
      300_000,
    ),
    runMigrationsOnStartup: readBoolean(
      'DB_RUN_MIGRATIONS_ON_STARTUP',
      env.DB_RUN_MIGRATIONS_ON_STARTUP,
      env.NODE_ENV !== 'production',
    ),
    trustProxy: readTrustProxy(env.TRUST_PROXY),
    ipRateLimit: {
      enabled: readBoolean(
        'IP_RATE_LIMIT_ENABLED',
        env.IP_RATE_LIMIT_ENABLED,
        true,
      ),
      failClosed: readBoolean(
        'IP_RATE_LIMIT_FAIL_CLOSED',
        env.IP_RATE_LIMIT_FAIL_CLOSED,
        false,
      ),
      authBurstLimit: readInteger(
        'IP_RATE_LIMIT_AUTH_BURST',
        env.IP_RATE_LIMIT_AUTH_BURST,
        10,
        1,
        10_000,
      ),
      authSustainedLimit: readInteger(
        'IP_RATE_LIMIT_AUTH_SUSTAINED',
        env.IP_RATE_LIMIT_AUTH_SUSTAINED,
        60,
        1,
        100_000,
      ),
      // Must stay above the highest Partner tier (ENTERPRISE = 1000/min) or
      // this, rather than the contractual per-Partner limit, becomes the
      // binding constraint — with trustProxy off, all of a Partner's traffic
      // arrives from one egress address.
      signedLimit: readInteger(
        'IP_RATE_LIMIT_SIGNED',
        env.IP_RATE_LIMIT_SIGNED,
        2_000,
        1,
        1_000_000,
      ),
      globalLimit: readInteger(
        'IP_RATE_LIMIT_GLOBAL',
        env.IP_RATE_LIMIT_GLOBAL,
        600,
        1,
        1_000_000,
      ),
      ...(env.IP_HASH_SECRET?.trim()
        ? { hashSecret: env.IP_HASH_SECRET.trim() }
        : {}),
    },
    metrics: {
      enabled: readBoolean('METRICS_ENABLED', env.METRICS_ENABLED, true),
      path: env.METRICS_PATH?.trim() || '/metrics',
      ...(env.METRICS_AUTH_TOKEN?.trim()
        ? {
            authToken: readSecret('METRICS_AUTH_TOKEN', env.METRICS_AUTH_TOKEN),
          }
        : {}),
      allowedIps: (env.METRICS_ALLOWED_IPS ?? '127.0.0.1,::1')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
    mongodb: {
      uri: readRequired('MONGODB_URI', env.MONGODB_URI),
      database: readRequired('MONGODB_DATABASE', env.MONGODB_DATABASE),
      serverSelectionTimeoutMs: readInteger(
        'MONGODB_SERVER_SELECTION_TIMEOUT_MS',
        env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
        5_000,
        100,
        120_000,
      ),
      maxPoolSize: readInteger(
        'MONGODB_MAX_POOL_SIZE',
        env.MONGODB_MAX_POOL_SIZE,
        20,
        1,
        1_000,
      ),
    },
    redis: {
      ...(env.REDIS_URL?.trim() ? { url: env.REDIS_URL.trim() } : {}),
      connectTimeoutMs: readInteger(
        'REDIS_CONNECT_TIMEOUT_MS',
        env.REDIS_CONNECT_TIMEOUT_MS,
        1_000,
        100,
        30_000,
      ),
      keyPrefix: env.REDIS_KEY_PREFIX?.trim() || 'turf-gds',
    },
    auth: {
      sessionTtlHours: readInteger(
        'AUTH_SESSION_TTL_HOURS',
        env.AUTH_SESSION_TTL_HOURS,
        168,
        1,
        8_760,
      ),
      maxSessions: readInteger(
        'AUTH_MAX_SESSIONS',
        env.AUTH_MAX_SESSIONS,
        5,
        1,
        20,
      ),
      maxLoginAttempts: readInteger(
        'AUTH_MAX_LOGIN_ATTEMPTS',
        env.AUTH_MAX_LOGIN_ATTEMPTS,
        5,
        1,
        100,
      ),
      lockMinutes: readInteger(
        'AUTH_LOCK_MINUTES',
        env.AUTH_LOCK_MINUTES,
        15,
        1,
        1_440,
      ),
      adminAccessTokenSecret: readSecret(
        'ADMIN_ACCESS_TOKEN_SECRET',
        env.ADMIN_ACCESS_TOKEN_SECRET,
      ),
      adminAccessTokenTtlMinutes: readInteger(
        'ADMIN_ACCESS_TOKEN_TTL_MINUTES',
        env.ADMIN_ACCESS_TOKEN_TTL_MINUTES,
        60,
        5,
        1_440,
      ),
      partnerCredentialMasterSecret: readSecret(
        'PARTNER_CREDENTIAL_MASTER_SECRET',
        env.PARTNER_CREDENTIAL_MASTER_SECRET,
      ),
      partnerHmacMaxSkewSeconds: readInteger(
        'PARTNER_HMAC_MAX_SKEW_SECONDS',
        env.PARTNER_HMAC_MAX_SKEW_SECONDS,
        300,
        30,
        3_600,
      ),
    },
    kyc: {
      maxFileBytes: readInteger(
        'KYC_MAX_FILE_BYTES',
        env.KYC_MAX_FILE_BYTES,
        10 * 1024 * 1024,
        1_024,
        50 * 1024 * 1024,
      ),
      allowedMimeTypes: (
        env.KYC_ALLOWED_MIME_TYPES ?? 'image/jpeg,image/png,application/pdf'
      )
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    },
    cloudinary: {
      cloudName: readRequired(
        'CLOUDINARY_CLOUD_NAME',
        env.CLOUDINARY_CLOUD_NAME,
      ),
      apiKey: readRequired('CLOUDINARY_API_KEY', env.CLOUDINARY_API_KEY),
      apiSecret: readRequired(
        'CLOUDINARY_API_SECRET',
        env.CLOUDINARY_API_SECRET,
      ),
      folder: env.CLOUDINARY_FOLDER?.trim() || 'turf-gds/development',
    },
    communications: {
      pollIntervalMs: readInteger(
        'COMMUNICATIONS_POLL_INTERVAL_MS',
        env.COMMUNICATIONS_POLL_INTERVAL_MS,
        1_000,
        100,
        60_000,
      ),
      batchSize: readInteger(
        'COMMUNICATIONS_BATCH_SIZE',
        env.COMMUNICATIONS_BATCH_SIZE,
        20,
        1,
        100,
      ),
      leaseSeconds: readInteger(
        'COMMUNICATIONS_LEASE_SECONDS',
        env.COMMUNICATIONS_LEASE_SECONDS,
        60,
        10,
        3_600,
      ),
      requestTimeoutMs: readInteger(
        'COMMUNICATIONS_REQUEST_TIMEOUT_MS',
        env.COMMUNICATIONS_REQUEST_TIMEOUT_MS,
        10_000,
        100,
        120_000,
      ),
      maxWebhookAttempts: readInteger(
        'COMMUNICATIONS_MAX_WEBHOOK_ATTEMPTS',
        env.COMMUNICATIONS_MAX_WEBHOOK_ATTEMPTS,
        8,
        1,
        8,
      ),
      retryBaseSeconds: readInteger(
        'COMMUNICATIONS_RETRY_BASE_SECONDS',
        env.COMMUNICATIONS_RETRY_BASE_SECONDS,
        30,
        1,
        3_600,
      ),
      retryMaxSeconds: readInteger(
        'COMMUNICATIONS_RETRY_MAX_SECONDS',
        env.COMMUNICATIONS_RETRY_MAX_SECONDS,
        3_600,
        1,
        86_400,
      ),
    },
    fcm,
    adminOperations: {
      inventoryMinimumCoverageDays: readInteger(
        'ADMIN_INVENTORY_MIN_COVERAGE_DAYS',
        env.ADMIN_INVENTORY_MIN_COVERAGE_DAYS,
        7,
        1,
        31,
      ),
    },
    razorpay: razorpayEnabled
      ? {
          enabled: true,
          keyId: readRequired('RAZORPAY_KEY_ID', env.RAZORPAY_KEY_ID),
          keySecret: readRequired(
            'RAZORPAY_KEY_SECRET',
            env.RAZORPAY_KEY_SECRET,
          ),
          webhookSecret: readRequired(
            'RAZORPAY_WEBHOOK_SECRET',
            env.RAZORPAY_WEBHOOK_SECRET,
          ),
          accountNumber: readRequired(
            'RAZORPAY_ACCOUNT_NUMBER',
            env.RAZORPAY_ACCOUNT_NUMBER,
          ),
          baseUrl: env.RAZORPAY_BASE_URL?.trim() || 'https://api.razorpay.com',
        }
      : {
          enabled: false,
          baseUrl: env.RAZORPAY_BASE_URL?.trim() || 'https://api.razorpay.com',
        },
    msg91: msg91Enabled
      ? {
          enabled: true,
          authKey: readRequired('MSG91_AUTH_KEY', env.MSG91_AUTH_KEY),
          baseUrl: env.MSG91_BASE_URL?.trim() || 'https://api.msg91.com',
        }
      : {
          enabled: false,
          baseUrl: env.MSG91_BASE_URL?.trim() || 'https://api.msg91.com',
        },
  };
  if (
    config.auth.adminAccessTokenSecret ===
    config.auth.partnerCredentialMasterSecret
  ) {
    throw new Error(
      'ADMIN_ACCESS_TOKEN_SECRET and PARTNER_CREDENTIAL_MASTER_SECRET must not be equal',
    );
  }
  return config;
}
