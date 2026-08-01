# GDS MVP Operations

## Authentication boundaries

- Venue Owner and Partner onboarding use Bearer sessions.
- Admin APIs use short-lived JWTs; logout revokes the token `jti` until expiry.
- Partner machine APIs use environment-scoped HMAC keys. Sign timestamp,
  method, exact path, raw-body SHA-256 and `X-Request-Id`; send the result in
  `X-Signature`.
- Connector inbound events use `X-Connector-Signature`. Incremental connector
  inventory reads use the one-time connector token returned at creation.

## Contract and cancellation authority

Admin creates a versioned onboarding agreement from a contract template or
explicit terms. The persisted SHA-256 terms hash, template version, proposing
Admin, accepting Venue Owner, IP, user agent and timestamps form the acceptance
record. Production activation requires an accepted agreement.

Partner-Venue contracts contain commercial access and settlement terms. Their
cancellation values are always copied from the Venue Owner's latest accepted
policy. Legacy cancellation input is accepted only when it matches that policy.
Each confirmed booking stores its immutable policy snapshot.

## Reference inventory connector

1. Admin creates a connector and stores the returned webhook secret once.
2. Admin maps external Court identifiers to GDS Courts.
3. The external system posts signed, uniquely identified events to
   `/api/v1/inventory-connectors/reference/:connectorId/events`.
4. The external system incrementally reads GDS slot changes from
   `/api/v1/inventory-connectors/reference/:connectorId/inventory`.
5. Held or booked overlaps create Admin conflicts instead of being overwritten.

Connector runs and conflicts are available through the Admin APIs. Venue Owners
have read-only connector status. Replace the reference transport behind the
same mappings and conflict rules when integrating a named PMS.

## Partner remittance and Venue payout

1. Admin generates and submits the Partner settlement.
2. Partner creates remittance instructions for that settlement.
3. Razorpay Smart Collect supplies the virtual account in live mode; disabled
   mode returns deterministic sandbox references.
4. A signed `virtual_account.credited` webhook adds an idempotent receipt.
5. An exact receipt automatically reconciles and completes the settlement.
6. Manual UTR evidence can be submitted and reviewed as fallback.
7. Venue payout initiation is rejected until Partner funds are fully received.
8. Razorpay payout webhooks record paid, failed or reversed outcomes.

Required live settings are `RAZORPAY_ENABLED`, credentials, webhook secret and
the RazorpayX account number. Raw bank account numbers are never accepted as
payout tokens.

## KYC and protected uploads

BUSINESS KYC for Partner and Venue Owner requires GST certificate, PAN,
passbook and Aadhaar images plus their validated details. Production uploads
are checked by byte signature rather than trusting multipart MIME values and
are stored as authenticated Cloudinary assets.

OPS or ADMIN completes the preliminary checklist. A different ADMIN performs
the final decision. KYC cannot become VERIFIED without both steps.

## Deployment

- Run `npm run db:init` as a release job before starting production processes.
- Set `DB_RUN_MIGRATIONS_ON_STARTUP=false` in production.
- Run the API and communications worker as separate processes.
- `docker-compose.yml` supplies a local MongoDB replica set and Redis.
- CI runs typecheck, build and all tests against a replica set.
- Health endpoints are `/health` and `/ready`; metrics are `/metrics`.
