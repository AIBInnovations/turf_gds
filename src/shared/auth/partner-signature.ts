import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function hashCredential(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function createPartnerApiKey(
  environment: 'SANDBOX' | 'PRODUCTION',
): { apiKey: string; prefix: string } {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const environmentCode = environment === 'SANDBOX' ? 'sbx' : 'prd';
  return {
    apiKey: `gds_${environmentCode}_${prefix}_${secret}`,
    prefix,
  };
}

export function deriveSigningSecret(
  masterSecret: string,
  purpose: string,
): string {
  return createHmac('sha256', masterSecret)
    .update(purpose, 'utf8')
    .digest('base64url');
}

export function extractKeyPrefix(apiKey: string): string | undefined {
  const match = /^gds_(?:sbx|prd)_([a-f0-9]{12})_[A-Za-z0-9_-]+$/.exec(
    apiKey,
  );
  return match?.[1];
}

export function hashRequestBody(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function createCanonicalRequest(input: {
  timestamp: string;
  method: string;
  path: string;
  body: Buffer;
}): string {
  return [
    input.timestamp,
    input.method.toUpperCase(),
    input.path,
    hashRequestBody(input.body),
  ].join('\n');
}

export function verifyHmacSignature(
  canonicalRequest: string,
  signingSecret: string,
  suppliedSignature: string,
): boolean {
  const normalized = suppliedSignature.startsWith('sha256=')
    ? suppliedSignature.slice(7)
    : suppliedSignature;
  const expected = createHmac('sha256', signingSecret)
    .update(canonicalRequest, 'utf8')
    .digest();

  let actual: Buffer;

  try {
    actual = Buffer.from(normalized, 'hex');
  } catch {
    return false;
  }

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
