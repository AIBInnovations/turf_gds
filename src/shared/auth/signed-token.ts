import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export interface SignedTokenPayload {
  sub: string;
  actor: 'ADMIN';
  role: 'ADMIN' | 'OPS' | 'SUPPORT';
  iat: number;
  exp: number;
}

function sign(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function createSignedToken(
  payload: SignedTokenPayload,
  secret: string,
): string {
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    'utf8',
  ).toString('base64url');
  const signature = sign(encodedPayload, secret).toString('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySignedToken(
  token: string,
  secret: string,
  nowInSeconds = Math.floor(Date.now() / 1_000),
): SignedTokenPayload | undefined {
  const [encodedPayload, encodedSignature] = token.split('.');

  if (!encodedPayload || !encodedSignature) {
    return undefined;
  }

  const expected = sign(encodedPayload, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');

  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<SignedTokenPayload>;

    if (
      typeof payload.sub !== 'string' ||
      payload.actor !== 'ADMIN' ||
      !['ADMIN', 'OPS', 'SUPPORT'].includes(payload.role ?? '') ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= nowInSeconds
    ) {
      return undefined;
    }

    return payload as SignedTokenPayload;
  } catch {
    return undefined;
  }
}
