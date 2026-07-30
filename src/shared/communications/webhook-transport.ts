import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

import type { WebhookAttemptDocument } from './communications.types.js';

export interface WebhookTransport {
  deliver(input: {
    url: string;
    secret: string;
    eventId: string;
    eventType: string;
    body: string;
    timeoutMs: number;
    now: Date;
  }): Promise<{
    delivered: boolean;
    retryable: boolean;
    attempt: WebhookAttemptDocument;
  }>;
}

export class UnsafeWebhookDestinationError extends Error {
  public constructor(message = 'Webhook destination is not publicly routable') {
    super(message);
    this.name = 'UnsafeWebhookDestinationError';
  }
}

export function createWebhookSignature(
  timestamp: string,
  body: string,
  secret: string,
): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')}`;
}

export function createSecureWebhookTransport(): WebhookTransport {
  return {
    async deliver(input) {
      const attemptedAt = input.now;
      const timestamp = Math.floor(attemptedAt.getTime() / 1_000).toString();
      const signature = createWebhookSignature(
        timestamp,
        input.body,
        input.secret,
      );
      const headers = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.body).toString(),
        'x-turf-event-id': input.eventId,
        'x-turf-event-type': input.eventType,
        'x-turf-timestamp': timestamp,
        'x-turf-signature': signature,
      };
      try {
        const destination = await resolvePublicDestination(input.url);
        const response = await sendPinned({
          destination,
          body: input.body,
          headers,
          timeoutMs: input.timeoutMs,
        });
        const delivered = response.statusCode >= 200 &&
          response.statusCode < 300;
        const retryable =
          response.statusCode === 408 ||
          response.statusCode === 425 ||
          response.statusCode === 429 ||
          response.statusCode >= 500;
        return {
          delivered,
          retryable: !delivered && retryable,
          attempt: {
            attempted_at: attemptedAt,
            request_payload: truncate(input.body, 16_384),
            redacted_headers: {
              ...headers,
              'x-turf-signature': '[REDACTED]',
            },
            response_code: response.statusCode,
            response_payload: truncate(response.body, 4_096),
            error: delivered
              ? null
              : `Webhook returned HTTP ${response.statusCode}`,
            completed_at: new Date(),
          },
        };
      } catch (error) {
        const message = safeError(error);
        return {
          delivered: false,
          retryable: !(error instanceof UnsafeWebhookDestinationError),
          attempt: {
            attempted_at: attemptedAt,
            request_payload: truncate(input.body, 16_384),
            redacted_headers: {
              ...headers,
              'x-turf-signature': '[REDACTED]',
            },
            response_code: null,
            response_payload: null,
            error: truncate(message, 1_000),
            completed_at: new Date(),
          },
        };
      }
    },
  };
}

interface PublicDestination {
  url: URL;
  address: string;
  family: 4 | 6;
}

export async function resolvePublicDestination(
  rawUrl: string,
): Promise<PublicDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookDestinationError('Webhook URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new UnsafeWebhookDestinationError(
      'Webhook URL must be credential-free HTTPS',
    );
  }
  const normalizedHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalizedHost === 'localhost' ||
    normalizedHost.endsWith('.localhost') ||
    normalizedHost.endsWith('.local')
  ) {
    throw new UnsafeWebhookDestinationError();
  }
  const literalFamily = isIP(normalizedHost);
  const addresses = literalFamily
    ? [{ address: normalizedHost, family: literalFamily }]
    : await lookup(normalizedHost, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new UnsafeWebhookDestinationError();
  }
  const selected = addresses[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

function sendPinned(input: {
  destination: PublicDestination;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: input.destination.url.hostname,
        servername: input.destination.url.hostname,
        port: input.destination.url.port || 443,
        path: `${input.destination.url.pathname}${input.destination.url.search}`,
        method: 'POST',
        headers: input.headers,
        timeout: input.timeoutMs,
        lookup: (_hostname, _options, callback) => {
          callback(
            null,
            input.destination.address,
            input.destination.family,
          );
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let captured = 0;
        response.on('data', (chunk: Buffer) => {
          if (captured >= 4_096) return;
          const remaining = 4_096 - captured;
          const value = chunk.subarray(0, remaining);
          chunks.push(value);
          captured += value.length;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Webhook request timed out'));
    });
    req.on('error', reject);
    req.end(input.body);
  });
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return isPublicAddress(normalized.slice(7));
    }
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Webhook delivery failed';
}
