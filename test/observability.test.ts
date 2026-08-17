import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import observabilityPlugin from '../src/plugins/observability.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import { createMetricRegistry } from '../src/shared/observability/registry.js';

function lines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

test('histogram buckets are cumulative and terminate at +Inf', () => {
  const registry = createMetricRegistry();
  const histogram = registry.histogram({
    name: 'test_duration_ms',
    help: 'Test durations',
    buckets: [10, 100],
  });

  histogram.observe(undefined, 5);
  histogram.observe(undefined, 50);
  histogram.observe(undefined, 5_000);

  const output = lines(registry.collect());
  // An observation counts in its own bucket and every bucket above it.
  assert.ok(output.includes('test_duration_ms_bucket{le="10"} 1'));
  assert.ok(output.includes('test_duration_ms_bucket{le="100"} 2'));
  assert.ok(output.includes('test_duration_ms_bucket{le="+Inf"} 3'));
  assert.ok(output.includes('test_duration_ms_sum 5055'));
  assert.ok(output.includes('test_duration_ms_count 3'));
});

test('a value exactly on a bucket boundary counts in that bucket', () => {
  const registry = createMetricRegistry();
  const histogram = registry.histogram({
    name: 'edge_ms',
    help: 'Edge',
    buckets: [10],
  });

  histogram.observe(undefined, 10);

  // `le` is less-than-or-equal.
  assert.ok(lines(registry.collect()).includes('edge_ms_bucket{le="10"} 1'));
});

test('bucket ordering is enforced at registration', () => {
  const registry = createMetricRegistry();
  assert.throws(() =>
    registry.histogram({
      name: 'bad_ms',
      help: 'Bad',
      buckets: [100, 10],
    }),
  );
});

test('label values are escaped', () => {
  const registry = createMetricRegistry();
  const counter = registry.counter({
    name: 'escaped_total',
    help: 'Escaping',
    labelNames: ['route'],
  });

  counter.inc({ route: 'a"b\\c' });

  assert.ok(
    lines(registry.collect()).includes('escaped_total{route="a\\"b\\\\c"} 1'),
  );
});

test('metric and label names are validated', () => {
  const registry = createMetricRegistry();
  assert.throws(() => registry.counter({ name: '1bad', help: 'x' }));
  assert.throws(() =>
    registry.counter({ name: 'ok_total', help: 'x', labelNames: ['bad-label'] }),
  );
});

test('a metric cannot change type', () => {
  const registry = createMetricRegistry();
  registry.counter({ name: 'shared', help: 'x' });
  assert.throws(() => registry.gauge({ name: 'shared', help: 'x' }));
});

test('unbounded labels fold into an overflow series', () => {
  const registry = createMetricRegistry({ maxSeriesPerMetric: 3 });
  const counter = registry.counter({
    name: 'cardinality_total',
    help: 'Cardinality guard',
    labelNames: ['id'],
  });

  for (let index = 0; index < 50; index += 1) {
    counter.inc({ id: `id-${index}` });
  }

  const output = lines(registry.collect());
  const series = output.filter((line) => line.startsWith('cardinality_total{'));
  // Three real series plus one overflow bucket, not fifty.
  assert.equal(series.length, 4);
  assert.ok(
    output.includes('cardinality_total{id="__overflow__"} 47'),
  );
});

test('gauges report the latest value and non-finite numbers are formatted', () => {
  const registry = createMetricRegistry();
  const gauge = registry.gauge({ name: 'level', help: 'Level' });
  gauge.set(undefined, 5);
  gauge.set(undefined, 2);
  assert.ok(lines(registry.collect()).includes('level 2'));

  gauge.set(undefined, Number.POSITIVE_INFINITY);
  assert.ok(lines(registry.collect()).includes('level +Inf'));
  gauge.set(undefined, Number.NaN);
  assert.ok(lines(registry.collect()).includes('level NaN'));
});

test('collectors run before each scrape', () => {
  const registry = createMetricRegistry();
  const gauge = registry.gauge({ name: 'collected', help: 'Collected' });
  let runs = 0;
  registry.addCollector(() => {
    runs += 1;
    gauge.set(undefined, runs);
  });

  registry.collect();
  assert.ok(lines(registry.collect()).includes('collected 2'));
});

test('requests are labelled by route pattern, not the raw URL', async () => {
  const registry = createMetricRegistry();
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {
    config: { enabled: true, path: '/metrics', allowedIps: ['127.0.0.1'] },
    registry,
  });
  app.get('/venues/:venueId/availability', async () => ({ ok: true }));

  await app.inject({ url: '/venues/687f00000000000000000801/availability' });
  await app.inject({ url: '/venues/687f00000000000000000802/availability' });

  const body = (await app.inject({ url: '/metrics' })).body;
  // Two requests to different venues must be one series, not two.
  assert.match(
    body,
    /gds_http_requests_total\{method="GET",route="\/venues\/:venueId\/availability",status_class="2xx"\} 2/,
  );
  assert.doesNotMatch(body, /687f00000000000000000801/);

  await app.close();
});

test('unmatched routes are labelled as unmatched', async () => {
  const registry = createMetricRegistry();
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {
    config: { enabled: true, path: '/metrics', allowedIps: ['127.0.0.1'] },
    registry,
  });

  await app.inject({ url: '/nope' });

  assert.match((await app.inject({ url: '/metrics' })).body, /route="unmatched"/);
  await app.close();
});

test('metrics are default-closed to remote scrapes', async () => {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {
    config: { enabled: true, path: '/metrics', allowedIps: ['127.0.0.1'] },
  });

  const remote = await app.inject({
    url: '/metrics',
    remoteAddress: '203.0.113.9',
  });
  assert.equal(remote.statusCode, 401);
  assert.equal(remote.json().error.code, 'METRICS_UNAUTHORIZED');

  const loopback = await app.inject({ url: '/metrics' });
  assert.equal(loopback.statusCode, 200);

  await app.close();
});

test('a bearer token authorises a remote scrape', async () => {
  const authToken = 'a-metrics-token-of-at-least-32-characters';
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {
    config: { enabled: true, path: '/metrics', allowedIps: [], authToken },
  });

  const authorised = await app.inject({
    url: '/metrics',
    remoteAddress: '203.0.113.9',
    headers: { authorization: `Bearer ${authToken}` },
  });
  assert.equal(authorised.statusCode, 200);

  const wrong = await app.inject({
    url: '/metrics',
    remoteAddress: '203.0.113.9',
    headers: { authorization: 'Bearer not-the-token' },
  });
  assert.equal(wrong.statusCode, 401);

  await app.close();
});

test('the metrics endpoint can be disabled entirely', async () => {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {
    config: { enabled: false, path: '/metrics', allowedIps: ['127.0.0.1'] },
  });

  assert.equal((await app.inject({ url: '/metrics' })).statusCode, 404);
  await app.close();
});
