import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import openapiCollectorPlugin from '../src/plugins/openapi.js';
import openapiRoutes from '../src/routes/openapi.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import { buildOpenApiSpec } from '../src/shared/openapi/build-spec.js';

interface SpecShape {
  openapi: string;
  paths: Record<string, Record<string, {
    operationId?: string;
    parameters?: Array<{ name: string; in: string; required?: boolean }>;
    requestBody?: { content: Record<string, { schema: unknown }> };
    security?: Array<Record<string, string[]>>;
    responses: Record<string, unknown>;
    tags?: string[];
  }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

async function specFrom(
  register: (app: Awaited<ReturnType<typeof Fastify>>) => Promise<void>,
  query = '',
): Promise<SpecShape> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(openapiCollectorPlugin);
  await register(app);
  await app.register(openapiRoutes, { prefix: '/api/v1' });
  const response = await app.inject({ url: `/api/v1/openapi.json${query}` });
  assert.equal(response.statusCode, 200);
  const spec = response.json<SpecShape>();
  await app.close();
  return spec;
}

test('path parameters are converted to OpenAPI syntax and marked required', async () => {
  const spec = await specFrom(async (app) => {
    app.get('/api/v1/venues/:venueId/courts/:courtId', {
      schema: {
        params: {
          type: 'object',
          required: ['venueId', 'courtId'],
          properties: {
            venueId: { type: 'string' },
            courtId: { type: 'string' },
          },
        },
      },
    }, async () => ({}));
  });

  const operation = spec.paths['/api/v1/venues/{venueId}/courts/{courtId}']?.get;
  assert.ok(operation, 'the converted path must be present');
  const params = operation.parameters ?? [];
  assert.deepEqual(
    params.map((value) => `${value.in}:${value.name}:${value.required}`).sort(),
    ['path:courtId:true', 'path:venueId:true'],
  );
});

test('querystring, headers and body schemas are carried through unchanged', async () => {
  const body = {
    oneOf: [
      { type: 'object', required: ['slotId'], properties: { slotId: { type: 'string' } } },
      { type: 'object', required: ['courtId'], properties: { courtId: { type: 'string' } } },
    ],
  };
  const spec = await specFrom(async (app) => {
    app.post('/api/v1/things', {
      schema: {
        body,
        querystring: {
          type: 'object',
          required: ['limit'],
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
    }, async () => ({}));
  });

  const operation = spec.paths['/api/v1/things']?.post;
  // OpenAPI 3.1 schemas are JSON Schema 2020-12, so `oneOf` at a body root
  // survives verbatim.
  assert.deepEqual(operation?.requestBody?.content['application/json']?.schema, body);
  const params = operation?.parameters ?? [];
  assert.deepEqual(
    params.map((value) => `${value.in}:${value.name}:${value.required}`).sort(),
    ['query:cursor:false', 'query:limit:true'],
  );
});

test('every registered route appears in the spec', async () => {
  const routes = [
    '/api/v1/alpha',
    '/api/v1/beta/:id',
    '/api/v1/gamma/nested/deep',
  ];
  const spec = await specFrom(async (app) => {
    for (const route of routes) {
      app.get(route, async () => ({}));
      app.post(route, async () => ({}));
    }
  });

  for (const route of routes) {
    const path = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    assert.ok(spec.paths[path]?.get, `${path} GET missing`);
    assert.ok(spec.paths[path]?.post, `${path} POST missing`);
  }
  // The spec route documents itself too.
  assert.ok(spec.paths['/api/v1/openapi.json']?.get);
});

test('RouteDocs drive security, scopes, idempotency and responses', async () => {
  const spec = await specFrom(async (app) => {
    app.post('/api/v1/bookings/confirm', {
      config: {
        docs: {
          tag: 'Bookings',
          summary: 'Confirm a held booking',
          security: ['partnerHmac'],
          scopes: ['bookings:write'],
          idempotent: true,
          rateLimited: true,
          internal: false,
          responses: { '201': { description: 'Booking confirmed' } },
        },
      },
    }, async () => ({}));
  });

  const operation = spec.paths['/api/v1/bookings/confirm']?.post;
  assert.deepEqual(operation?.security, [{ partnerHmac: [] }]);
  assert.deepEqual(operation?.tags, ['Bookings']);
  assert.ok(
    operation?.parameters?.some(
      (value) => value.name === 'Idempotency-Key' && value.required === true,
    ),
    'idempotent operations must document the required header',
  );
  assert.ok(operation?.responses['201']);
  // The standard error envelope is attached to every operation.
  assert.ok(operation?.responses.default);
  assert.ok(spec.components.schemas.Error);
});

test('the partner view excludes internal operations', async () => {
  const register = async (app: Awaited<ReturnType<typeof Fastify>>) => {
    app.get('/api/v1/partners/me/bookings', {
      config: {
        docs: {
          tag: 'Partner',
          summary: 'Partner bookings',
          security: ['partnerHmac'],
          internal: false,
        },
      },
    }, async () => ({}));
    app.get('/api/v1/owner/venues', {
      config: {
        docs: {
          tag: 'Owner',
          summary: 'Owner venues',
          security: ['ownerBearer'],
          internal: true,
        },
      },
    }, async () => ({}));
    app.get('/api/v1/undocumented', async () => ({}));
  };

  const full = await specFrom(register);
  assert.ok(full.paths['/api/v1/partners/me/bookings']);
  assert.ok(full.paths['/api/v1/owner/venues']);
  assert.ok(full.paths['/api/v1/undocumented']);

  const partner = await specFrom(register, '?partner=true');
  assert.ok(partner.paths['/api/v1/partners/me/bookings']);
  assert.equal(partner.paths['/api/v1/owner/venues'], undefined);
  // Undocumented routes are not Partner-facing by default.
  assert.equal(partner.paths['/api/v1/undocumented'], undefined);
});

test('HEAD and OPTIONS routes are not documented', () => {
  const spec = buildOpenApiSpec({
    title: 't',
    version: '1',
    description: 'd',
    serverUrl: '/api/v1',
    routes: [
      { method: 'HEAD', url: '/api/v1/thing' },
      { method: 'OPTIONS', url: '/api/v1/thing' },
      { method: 'GET', url: '/api/v1/thing' },
    ],
  }) as unknown as SpecShape;

  assert.deepEqual(Object.keys(spec.paths['/api/v1/thing'] ?? {}), ['get']);
});

test('operation ids are unique across the generated spec', async () => {
  const spec = await specFrom(async (app) => {
    app.get('/api/v1/a', async () => ({}));
    app.post('/api/v1/a', async () => ({}));
    app.get('/api/v1/a/:id', async () => ({}));
  });

  const ids = Object.values(spec.paths)
    .flatMap((methods) => Object.values(methods))
    .map((operation) => operation.operationId);
  assert.equal(new Set(ids).size, ids.length);
});
