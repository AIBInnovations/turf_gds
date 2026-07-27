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

function readPort(value: string | undefined): number {
  const port = Number(value ?? '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
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
    port: readPort(env.PORT),
    logLevel: readEnum(
      'LOG_LEVEL',
      env.LOG_LEVEL,
      LOG_LEVEL_VALUES,
      'info',
    ),
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
