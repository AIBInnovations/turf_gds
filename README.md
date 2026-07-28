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
npm run build
npm start
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
