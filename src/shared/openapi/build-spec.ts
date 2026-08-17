import type { RouteDocs, SecuritySchemeName } from './route-docs.js';

export interface CollectedRoute {
  method: string;
  /** Fully-prefixed Fastify pattern, e.g. /api/v1/venues/:venueId. */
  url: string;
  schema?: Record<string, unknown> | undefined;
  docs?: RouteDocs | undefined;
}

export interface BuildSpecOptions {
  title: string;
  version: string;
  description: string;
  serverUrl: string;
  routes: readonly CollectedRoute[];
  /** Emit only Partner-facing operations. */
  partnerOnly?: boolean;
}

const HIDDEN_METHODS = new Set(['HEAD', 'OPTIONS']);

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: {},
      },
    },
  },
} as const;

const SECURITY_SCHEMES: Record<SecuritySchemeName, Record<string, unknown>> = {
  ownerBearer: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Opaque, revocable Venue Owner session token from ' +
      'POST /auth/venue-owners/login.',
  },
  partnerPortalBearer: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Partner developer-portal session from POST /partners/auth/login.',
  },
  adminBearer: {
    type: 'http',
    scheme: 'bearer',
    description: 'Short-lived HS256 JWT for Platform Users.',
  },
  partnerHmac: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Api-Key',
    description:
      'Send X-Api-Key plus X-Timestamp (Unix seconds), an optional unique ' +
      'X-Request-Id, and X-Signature. The signature is ' +
      'hex(HMAC-SHA256(signingSecret, canonicalRequest)) where ' +
      'canonicalRequest is timestamp, uppercase method, request path with ' +
      'query string, and hex SHA-256 of the raw body, joined by newlines, ' +
      'with X-Request-Id appended as a final line when present. Timestamps ' +
      'outside PARTNER_HMAC_MAX_SKEW_SECONDS are rejected, and a given ' +
      'signature may only be used once.',
  },
  connectorSignature: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Connector-Signature',
    description: 'hex(HMAC-SHA256(connectorSecret, rawBody)).',
  },
  razorpaySignature: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Razorpay-Signature',
    description: 'Razorpay webhook signature over the raw body.',
  },
};

/** `/venues/:venueId` -> `/venues/{venueId}` */
function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationIdFor(method: string, url: string): string {
  const slug = toOpenApiPath(url)
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .join('-');
  return `${method.toLowerCase()}-${slug}`;
}

function parametersFrom(
  schema: Record<string, unknown> | undefined,
  location: 'query' | 'path' | 'header',
  key: 'querystring' | 'params' | 'headers',
): Array<Record<string, unknown>> {
  const source = schema?.[key] as
    { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (!source?.properties) return [];
  const required = new Set(source.required ?? []);
  return Object.entries(source.properties).map(([name, definition]) => ({
    name,
    in: location,
    // Path parameters are always required by the specification.
    required: location === 'path' ? true : required.has(name),
    schema: definition as Record<string, unknown>,
  }));
}

/**
 * Generates the spec from the JSON Schemas Fastify already validates against.
 *
 * OpenAPI 3.1 Schema Objects are JSON Schema 2020-12, a superset of what Ajv
 * accepts, so the schemas pass through untouched — `oneOf` at a body root,
 * `const`, `format`, `pattern` and `additionalProperties` all keep their
 * meaning. Only the structure around them is rearranged.
 */
export function buildOpenApiSpec(
  options: BuildSpecOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedSchemes = new Set<SecuritySchemeName>();

  for (const route of options.routes) {
    if (HIDDEN_METHODS.has(route.method.toUpperCase())) continue;
    if (options.partnerOnly && route.docs?.internal !== false) continue;

    const path = toOpenApiPath(route.url);
    const method = route.method.toLowerCase();
    const docs = route.docs;

    const parameters = [
      ...parametersFrom(route.schema, 'path', 'params'),
      ...parametersFrom(route.schema, 'query', 'querystring'),
      ...parametersFrom(route.schema, 'header', 'headers'),
    ];
    if (docs?.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          'Replaying a key returns the original response. Reusing it with a ' +
          'different request body is rejected with IDEMPOTENCY_KEY_REUSED.',
        schema: { type: 'string', maxLength: 200 },
      });
    }

    const responses: Record<string, unknown> = {};
    for (const [status, value] of Object.entries(docs?.responses ?? {})) {
      responses[status] = {
        description: value.description,
        ...(value.schema
          ? { content: { 'application/json': { schema: value.schema } } }
          : {}),
        ...(docs?.rateLimited
          ? {
              headers: {
                'X-RateLimit-Limit': { schema: { type: 'integer' } },
                'X-RateLimit-Remaining': { schema: { type: 'integer' } },
                'X-RateLimit-Reset': { schema: { type: 'integer' } },
              },
            }
          : {}),
      };
    }
    if (Object.keys(responses).length === 0) {
      responses['200'] = { description: 'Successful response' };
    }
    responses.default = {
      description: 'Error',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      },
    };

    let security: Array<Record<string, string[]>> | undefined;
    if (docs) {
      if (docs.security === 'none') security = [];
      else {
        security = docs.security.map((scheme) => {
          usedSchemes.add(scheme);
          return { [scheme]: [] };
        });
      }
    }

    const description = [
      docs?.description,
      docs?.scopes?.length
        ? `Requires the ${docs.scopes.join(', ')} Partner scope.`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');

    const operation: Record<string, unknown> = {
      operationId: docs?.operationId ?? operationIdFor(route.method, route.url),
      ...(docs?.tag ? { tags: [docs.tag] } : {}),
      ...(docs?.summary ? { summary: docs.summary } : {}),
      ...(description ? { description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.schema?.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: route.schema.body as Record<string, unknown>,
                },
              },
            },
          }
        : {}),
      ...(security ? { security } : {}),
      ...(docs?.deprecated ? { deprecated: true } : {}),
      responses,
    };

    paths[path] ??= {};
    paths[path]![method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      description: options.description,
    },
    servers: [{ url: options.serverUrl }],
    security: [],
    components: {
      securitySchemes: Object.fromEntries(
        (Object.keys(SECURITY_SCHEMES) as SecuritySchemeName[])
          .filter((name) => usedSchemes.size === 0 || usedSchemes.has(name))
          .map((name) => [name, SECURITY_SCHEMES[name]]),
      ),
      schemas: { Error: ERROR_SCHEMA },
    },
    paths,
  };
}
