export type SecuritySchemeName =
  | 'ownerBearer'
  | 'partnerPortalBearer'
  | 'adminBearer'
  | 'partnerHmac'
  | 'connectorSignature'
  | 'razorpaySignature';

/**
 * Per-route documentation.
 *
 * Deliberately carried on the route's `config`, never in `schema.response`:
 * populating `schema.response` activates fast-json-stringify, which silently
 * strips any property the schema omits. Across a surface with no response-body
 * tests that would truncate real Partner payloads in production. Fastify passes
 * `config` through untouched, so this is inert at runtime.
 */
export interface RouteDocs {
  tag: string;
  summary: string;
  description?: string;
  operationId?: string;
  /** OR-ed alternatives. 'none' marks a deliberately public route. */
  security: readonly SecuritySchemeName[] | 'none';
  /** Partner scopes required; rendered into the description. */
  scopes?: readonly string[];
  /** Emits the required Idempotency-Key header parameter. */
  idempotent?: boolean;
  /** Emits the X-RateLimit-* response headers. */
  rateLimited?: boolean;
  responses?: Readonly<
    Record<string, { description: string; schema?: Record<string, unknown> }>
  >;
  deprecated?: boolean;
  /** Owner/Admin surface: excluded from the Partner-facing spec. */
  internal?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    docs?: RouteDocs;
  }
}
