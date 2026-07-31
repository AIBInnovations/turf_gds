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

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fcmEnabled = readBoolean('FCM_ENABLED', env.FCM_ENABLED, false);
  const fcm = fcmEnabled
    ? {
        enabled: true,
        projectId: readRequired('FCM_PROJECT_ID', env.FCM_PROJECT_ID),
        clientEmail: readRequired('FCM_CLIENT_EMAIL', env.FCM_CLIENT_EMAIL),
        privateKey: readRequired('FCM_PRIVATE_KEY', env.FCM_PRIVATE_KEY)
          .replace(/\\n/g, '\n'),
      }
    : { enabled: false };
  return {
    nodeEnv: readEnum(
      'NODE_ENV',
      env.NODE_ENV,
      NODE_ENV_VALUES,
      'development',
    ),
    host: env.HOST?.trim() || '0.0.0.0',
    port: readInteger('PORT', env.PORT, 3000, 1, 65_535),
    logLevel: readEnum(
      'LOG_LEVEL',
      env.LOG_LEVEL,
      LOG_LEVEL_VALUES,
      'info',
    ),
    readinessCacheTtlMs: readInteger(
      'READINESS_CACHE_TTL_MS',
      env.READINESS_CACHE_TTL_MS,
      60_000,
      0,
      300_000,
    ),
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
        env.KYC_ALLOWED_MIME_TYPES ??
        'image/jpeg,image/png,application/pdf'
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
  };
}
