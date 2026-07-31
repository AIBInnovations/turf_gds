# Turf GDS API Layer

Initial Node.js, TypeScript, Fastify, and Cloudinary foundation for the Turf
Booking GDS described in `docs/`.

## Requirements

- Node.js 22 or newer
- MongoDB replica set or MongoDB Atlas
- A Cloudinary product environment

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`, configure `MONGODB_URI`, and enter the
   Cloudinary cloud name, API key, and API secret from
   **Cloudinary Console > Settings > API Keys**.

3. Start the development server:

   ```sh
   npm run dev
   ```

4. Check:

   - `GET http://localhost:3000/health` for process liveness
   - `GET http://localhost:3000/ready` for MongoDB and Cloudinary readiness
   - `GET http://localhost:3000/api/v1` for API version discovery

Dependency results are cached for `READINESS_CACHE_TTL_MS` so infrastructure
probes do not exhaust Cloudinary Admin API limits.

## Commands

```sh
npm run dev
npm run typecheck
npm test
npm run test:load
npm run build
npm start
npm run worker:dev
npm run worker:start
```

## Media boundary

`src/shared/media` uploads bytes and returns Cloudinary metadata for embedding in
the owning `Venue`, `Court`, or `KycDocument` aggregate. This follows the SRS:
there is no standalone media collection.

Use `fastify.mediaStorage.uploadBuffer(...)` inside application services.
Uploads are public by default; pass `{ access: "authenticated" }` for protected
KYC-style assets.

## MongoDB transactions

The official MongoDB driver is exposed as `fastify.database`. Business services
can use `fastify.database.db` for collections and
`fastify.database.withTransaction(...)` for multi-document workflows. Pass the
provided `session` into every database operation inside the transaction and do
not run transaction operations in parallel.

## Venue Owner authentication

The first Identity vertical slice is available at:

- `POST /api/v1/auth/venue-owners/register`
- `POST /api/v1/auth/venue-owners/login`

Registration creates `VenueOwner`, the initial `Venue`, and the OWNER
`VenueOwnerMembership` in one MongoDB transaction. Passwords use Node.js
`scrypt`. Login returns an opaque token once and stores only its SHA-256 hash in
the bounded `VenueOwner.sessions` array.

New owners start as `ACTIVE` and their initial venues start as `PENDING`.
Onboarding readiness is represented by KYC and Venue state; suspended owners
cannot authenticate.

The completed Identity endpoint and authentication reference is in
`docs/identity-api.md`.

Authentication is actor-specific: Venue Owners use revocable opaque Bearer
sessions, Platform Users use short-lived HS256 JWT Bearer tokens, and Partners
use environment-scoped API keys with HMAC-signed requests.

The completed Venue Owner Venue and Booking endpoint reference is in
`docs/venue-owner-api.md`.

The Contracts module and Admin configuration API are documented in
`docs/contracts-api.md`.

The completed Partner Booking lifecycle is documented in
`docs/booking-api.md`.

The append-only, balanced Ledger posting boundary and its settlement-allocation
rules are documented in `docs/ledger-module.md`.

The completed Venue Owner Financial Close Settlement, Reconciliation, payout,
and owner history API is documented in
`docs/financial-close-api.md`.

The consolidated release verification, including every cURL request, expected
status, actual status, redacted evidence, edge cases, and user/data flows, is in
`docs/final-curl-test-report-2026-07-30.md`.

The completed transactional Outbox worker, Partner webhook delivery, Owner
notification/device APIs, optional FCM adapter, and Admin monitoring surface
are documented in `docs/communications-api.md`.

The completed Epic 08 Venue/Court operations, Ledger-backed reports and CSV
exports, dispute view, and inventory-health API are documented in
`docs/admin-api.md`.

## Partner completion APIs

Partner requests use API-key/HMAC authentication and are rate-limited per
Partner and environment. Redis is the primary counter; MongoDB provides an
atomic fallback. Default per-minute tiers are STARTER 100, STANDARD 300, and
ENTERPRISE 1000.

- `GET /api/v1/availability` (`availability:read`)
- `GET /api/v1/partners/me/usage` (`reports:read`)
- `GET /api/v1/partners/me/bookings` (`reports:read`)
- `GET /api/v1/partners/me/settlements[/:settlementId]` (`finance:read`)
- `GET /api/v1/partners/me/invoices[/:invoiceId]` (`finance:read`)

Financial Close also supports Admin-only post-settlement Ledger adjustments
and structured B2B Invoice creation, issue, and void workflows. Invoice
document rendering remains out of scope.

The load harness defaults to 50 concurrent clients. Configure
`LOAD_BASE_URL`, `LOAD_PARTNER_API_KEY`, `LOAD_PARTNER_SIGNING_SECRET`, and
`LOAD_PATH`; set `LOAD_P95_THRESHOLD_MS=300` for availability or `1000` for a
prepared confirmation workload.
