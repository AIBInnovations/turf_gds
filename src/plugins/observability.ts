import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { AppConfig } from '../config/env.js';
import { timingSafeEqualStrings } from '../shared/auth/partner-signature.js';
import { AppError } from '../shared/errors/app-error.js';
import {
  createMetricRegistry,
  DEFAULT_DURATION_BUCKETS,
  type MetricRegistry,
} from '../shared/observability/registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricRegistry;
  }
}

export interface ObservabilityPluginOptions {
  config: AppConfig['metrics'];
  registry?: MetricRegistry;
}

const observabilityPlugin: FastifyPluginAsync<
  ObservabilityPluginOptions
> = async (fastify, options) => {
  const registry = options.registry ?? createMetricRegistry();
  fastify.decorate('metrics', registry);

  const requests = registry.counter({
    name: 'gds_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_class'],
  });
  const errors = registry.counter({
    name: 'gds_http_errors_total',
    help: 'Total HTTP 5xx responses',
    labelNames: ['method', 'route'],
  });
  // A histogram, not a summary: summary quantiles cannot be aggregated across
  // replicas, which is the whole reason p95 is wanted here.
  const duration = registry.histogram({
    name: 'gds_http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'route'],
    buckets: DEFAULT_DURATION_BUCKETS,
  });

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const processMetrics = {
    residentMemory: registry.gauge({
      name: 'gds_process_resident_memory_bytes',
      help: 'Resident set size in bytes',
    }),
    heapUsed: registry.gauge({
      name: 'gds_process_heap_used_bytes',
      help: 'Heap in use in bytes',
    }),
    uptime: registry.gauge({
      name: 'gds_process_uptime_seconds',
      help: 'Process uptime in seconds',
    }),
    eventLoopP99: registry.gauge({
      name: 'gds_process_event_loop_delay_p99_ms',
      help: 'Event loop delay p99 in milliseconds',
    }),
  };
  registry.addCollector(() => {
    const memory = process.memoryUsage();
    processMetrics.residentMemory.set(undefined, memory.rss);
    processMetrics.heapUsed.set(undefined, memory.heapUsed);
    processMetrics.uptime.set(undefined, process.uptime());
    processMetrics.eventLoopP99.set(undefined, eventLoop.percentile(99) / 1e6);
  });
  fastify.addHook('onClose', async () => {
    eventLoop.disable();
  });

  const started = new WeakMap<object, number>();
  fastify.addHook('onRequest', async (request) => {
    started.set(request, performance.now());
  });
  fastify.addHook('onResponse', async (request, reply) => {
    // The route *pattern*, never the raw URL: `/venues/:venueId/availability`
    // is one series, whereas the URL would be one series per venue.
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = { method: request.method, route };
    const elapsed = Math.max(
      0,
      performance.now() - (started.get(request) ?? performance.now()),
    );
    duration.observe(labels, elapsed);
    requests.inc({
      ...labels,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    });
    if (reply.statusCode >= 500) errors.inc(labels);
  });

  if (!options.config.enabled) return;

  fastify.get(options.config.path, async (request, reply) => {
    authorizeScrape(request.headers.authorization, request.ip, options.config);
    return reply.type('text/plain; version=0.0.4').send(registry.collect());
  });
};

/**
 * Default-closed. Without a token, only the loopback allowlist may scrape, so
 * an unconfigured deployment refuses remote scrapes rather than exposing
 * operational data.
 */
function authorizeScrape(
  authorization: string | undefined,
  ip: string,
  config: AppConfig['metrics'],
): void {
  if (config.authToken) {
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';
    if (supplied && timingSafeEqualStrings(supplied, config.authToken)) return;
  }
  if (config.allowedIps.includes(ip)) return;
  throw new AppError({
    code: 'METRICS_UNAUTHORIZED',
    message: 'Metrics access requires authorization',
    statusCode: 401,
  });
}

export default fp(observabilityPlugin, {
  name: 'observability',
  fastify: '5.x',
});
