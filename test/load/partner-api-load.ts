import { createHmac } from 'node:crypto';

import { createCanonicalRequest } from '../../src/shared/auth/partner-signature.js';

const baseUrl = required('LOAD_BASE_URL');
const apiKey = required('LOAD_PARTNER_API_KEY');
const signingSecret = required('LOAD_PARTNER_SIGNING_SECRET');
const path = process.env.LOAD_PATH ?? '/api/v1/availability';
const method = (process.env.LOAD_METHOD ?? 'GET').toUpperCase();
const body = Buffer.from(process.env.LOAD_BODY ?? '', 'utf8');
const concurrency = integer('LOAD_CONCURRENCY', 50);
const requests = integer('LOAD_REQUESTS', 500);
const thresholdMs = integer('LOAD_P95_THRESHOLD_MS', 300);
const latencies: number[] = [];
let failures = 0;
let cursor = 0;

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (true) {
      const sequence = cursor++;
      if (sequence >= requests) return;
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const canonical = createCanonicalRequest({
        timestamp,
        method,
        path,
        body,
      });
      const signature = createHmac('sha256', signingSecret)
        .update(canonical, 'utf8')
        .digest('hex');
      const startedAt = performance.now();
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          'x-api-key': apiKey,
          'x-signature': signature,
          'x-timestamp': timestamp,
          ...(body.length ? { 'content-type': 'application/json' } : {}),
        },
        ...(body.length ? { body } : {}),
      });
      latencies.push(performance.now() - startedAt);
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    }
  }),
);

latencies.sort((left, right) => left - right);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
console.log(JSON.stringify({
  requests,
  concurrency,
  failures,
  p95LatencyMs: Math.round(p95 * 100) / 100,
  thresholdMs,
}));
if (failures > 0 || p95 >= thresholdMs) process.exitCode = 1;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
