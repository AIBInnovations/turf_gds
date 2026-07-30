import { createSign } from 'node:crypto';

import type { AppConfig } from '../../config/env.js';
import type {
  FcmTokenDocument,
  OwnerNotificationDocument,
} from './communications.types.js';

export interface PushDelivery {
  send(input: {
    tokens: FcmTokenDocument[];
    notification: OwnerNotificationDocument;
  }): Promise<{ invalidTokens: string[] }>;
}

export function createDisabledPushDelivery(): PushDelivery {
  return {
    async send() {
      return { invalidTokens: [] };
    },
  };
}

export function createFirebasePushDelivery(
  config: AppConfig['fcm'],
): PushDelivery {
  if (!config.enabled) return createDisabledPushDelivery();
  let cachedAccessToken:
    | { value: string; refreshAt: number }
    | undefined;

  return {
    async send(input) {
      if (input.tokens.length === 0) return { invalidTokens: [] };
      const accessToken = await getAccessToken();
      const outcomes = await Promise.all(input.tokens.map(async (registration) => {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
            config.projectId!,
          )}/messages:send`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: registration.token,
                data: stringifyData({
                  notificationType: input.notification.notification_type,
                  aggregateType: input.notification.aggregate_type,
                  aggregateId:
                    input.notification.aggregate_id.toHexString(),
                  venueId: input.notification.venue_id.toHexString(),
                  ...input.notification.payload,
                }),
              },
            }),
          },
        );
        if (response.ok) return null;
        const body = await response.text();
        if (isInvalidRegistration(response.status, body)) {
          return registration.token;
        }
        throw new Error(`FCM delivery failed with HTTP ${response.status}`);
      }));
      return {
        invalidTokens: outcomes.filter(
          (value): value is string => value !== null,
        ),
      };
    },
  };

  async function getAccessToken(): Promise<string> {
    const current = Math.floor(Date.now() / 1_000);
    if (cachedAccessToken && cachedAccessToken.refreshAt > current) {
      return cachedAccessToken.value;
    }
    const assertion = serviceAccountAssertion({
      clientEmail: config.clientEmail!,
      privateKey: config.privateKey!,
      issuedAt: current,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!response.ok) {
      throw new Error(`FCM OAuth failed with HTTP ${response.status}`);
    }
    const value = await response.json() as {
      access_token?: string;
      expires_in?: number;
    };
    if (!value.access_token) throw new Error('FCM OAuth returned no token');
    cachedAccessToken = {
      value: value.access_token,
      refreshAt: current + Math.max(60, (value.expires_in ?? 3_600) - 300),
    };
    return cachedAccessToken.value;
  }
}

export function serviceAccountAssertion(input: {
  clientEmail: string;
  privateKey: string;
  issuedAt: number;
}): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: input.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: input.issuedAt,
    exp: input.issuedAt + 3_600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(input.privateKey);
  return `${unsigned}.${signature.toString('base64url')}`;
}

function isInvalidRegistration(status: number, body: string): boolean {
  return (
    status === 404 ||
    (status === 400 &&
      (body.includes('"errorCode":"UNREGISTERED"') ||
        body.includes('"errorCode":"INVALID_ARGUMENT"')))
  );
}

function stringifyData(
  value: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'string' ? item : JSON.stringify(item),
    ]),
  );
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
