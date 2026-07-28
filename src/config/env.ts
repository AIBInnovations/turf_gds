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
  auth: {
    sessionTtlHours: number;
    maxSessions: number;
    maxLoginAttempts: number;
    lockMinutes: number;
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
    folder: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
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
  };
}
