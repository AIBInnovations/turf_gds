import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const ISSUER = 'turf-gds-api';
const AUDIENCE = 'turf-gds-admin';

export interface AdminJwtPayload {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  sub: string;
  jti: string;
  actor: 'ADMIN';
  role: 'ADMIN' | 'OPS' | 'SUPPORT';
  iat: number;
  nbf: number;
  exp: number;
}

type AdminJwtClaims = Pick<
  AdminJwtPayload,
  'sub' | 'actor' | 'role' | 'iat' | 'exp'
> & {
  jti?: string;
};

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signature(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value).digest();
}

export function createAdminJwt(
  claims: AdminJwtClaims,
  secret: string,
): string {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: ISSUER,
    aud: AUDIENCE,
    ...claims,
    jti: claims.jti ?? randomUUID(),
    nbf: claims.iat,
  } satisfies AdminJwtPayload);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${signature(signingInput, secret).toString('base64url')}`;
}

export function verifyAdminJwt(
  token: string,
  secret: string,
  nowInSeconds = Math.floor(Date.now() / 1_000),
): AdminJwtPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = signature(signingInput, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return undefined;
  }

  try {
    const header = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<AdminJwtPayload>;

    if (
      header.alg !== 'HS256' ||
      header.typ !== 'JWT' ||
      payload.iss !== ISSUER ||
      payload.aud !== AUDIENCE ||
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      payload.jti.length < 16 ||
      payload.actor !== 'ADMIN' ||
      !['ADMIN', 'OPS', 'SUPPORT'].includes(payload.role ?? '') ||
      typeof payload.iat !== 'number' ||
      typeof payload.nbf !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.nbf > nowInSeconds ||
      payload.exp <= nowInSeconds ||
      payload.exp <= payload.iat
    ) {
      return undefined;
    }

    return payload as AdminJwtPayload;
  } catch {
    return undefined;
  }
}
