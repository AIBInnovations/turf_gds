# Turf Booking GDS — Module Reference

Version 0.9 — aligned with the MongoDB-only production ERD.

This document defines the business-module boundaries for the Turf Booking GDS.
The ERD is the persistence source of truth. Modules own business behavior around
the ERD's collections and embedded documents; they must not introduce parallel
collections that the ERD intentionally removed.

## 1. System Purpose

The Turf Booking GDS is a backend inventory, booking, and financial-close
platform for turf and ground venues.

Its users are:

- **Venue Users** — owners, managers, and staff using the Owner Dashboard.
- **Booking Partners** — third-party applications using the Partner API.
- **Platform Users** — administrators, operations staff, and support staff using
  the Admin Dashboard.

Booking Partners are the Merchant of Record. They collect customer payment
outside the GDS. The GDS records booking value, reconciles Partner remittance,
and pays Venue Users after commission and tax.

MongoDB is the only persistent database. Redis is temporary coordination and
rate-limiting infrastructure. Object storage contains file bytes; MongoDB
contains embedded file metadata.

## 2. Module Map

The system has seven business modules:

1. `identity`
2. `venue`
3. `contracts`
4. `booking`
5. `ledger`
6. `financial-close`
7. `admin`

Shared infrastructure:

- `shared/auth`
- `shared/db`
- `shared/redis`
- `shared/media`
- `shared/communications`
- `shared/observability`

Media and Communications are infrastructure capabilities, not independent
business-data owners:

- Media metadata remains embedded in its owning Identity or Venue aggregate.
- Notifications remain embedded in `VenueOwner.notifications`.
- Webhook delivery state remains embedded in
  `OutboxEvent.webhook_deliveries`.

## 3. Collection Ownership

| Module | Owned collections |
|---|---|
| `identity` | `AdminUser`, `VenueOwner`, `VenueOwnerMembership`, `VenueRolePermission`, `KycVerification`, `KycDocument`, `Partner`, `PartnerApiKey`, `ApiUsageDaily`, `WebhookEndpoint` |
| `venue` | `Venue`, `Court`, `PricingRule`, `Slot`, `VenuePayoutAccount` |
| `contracts` | `PartnerVenueContract` |
| `booking` | `Booking`, `BookingCancellation`, `ApiIdempotencyRecord` |
| `ledger` | `LedgerEntry` |
| `financial-close` | `Settlement`, `Reconciliation`, `Payout`, `Invoice` |
| `admin` | No collections; privileged orchestration only |
| `shared/communications` | `OutboxEvent` transport behavior; the originating business module creates the event transactionally |

## 4. Module Reference

### 4.1 `identity`

Identity answers who is acting and whether that actor may perform an action.

Responsibilities:

- Register and authenticate Platform Users, Venue Users, and Booking Partners.
- Issue short-lived standards-compliant HS256 JWTs for Platform Users and
  revalidate their current account status and role on every request.
- Maintain bounded hashed sessions in `VenueOwner.sessions`.
- Maintain device tokens and the bounded notification inbox embedded in
  `VenueOwner`.
- Manage venue membership, roles, and permissions.
- Manage KYC verification and its `KycDocument` records.
- Manage sandbox and production Partner API keys.
- Authenticate Partner API keys and HMAC signatures.
- Record daily Partner API usage.
- Register and verify environment-specific webhook endpoints.

Embedded ownership:

- `VenueOwner.sessions`
- `VenueOwner.fcm_tokens`
- `VenueOwner.notifications`
- `KycDocument.file`

Rules:

- `AdminUser` is the internal staff identity; `PlatformUser` is not used.
- Privileged mutations require the `ADMIN` role. `OPS` and `SUPPORT` are
  restricted to explicitly read-only capabilities.
- Owner sessions are embedded and explicitly pruned; no separate
  `VenueOwnerSession` collection exists.
- KYC file metadata is embedded in `KycDocument.file`; no general
  `MediaAsset` collection exists.
- Only one current KYC verification may exist for a subject and verification
  type.
- KYC review requires a submitted current verification with an active
  document and atomically updates verification, document, derived subject
  status, and bounded audit history.
- Production key issuance requires verified business KYC and completed go-live
  review.
- Webhook endpoint and credential environments must never cross.

Public capabilities:

- `registerVenueOwner()`
- `authenticate()`
- `authenticatePartnerRequest()`
- `requirePermission()`
- `submitKycDocument()`
- `isVerified()`
- `issuePartnerKey()`
- `reviewKyc()`
- `registerWebhookEndpoint()`
- `recordApiUsage()`

### 4.2 `venue`

Venue owns venue configuration and bookable inventory.

Code is separated into `profile`, `courts`, `inventory`, and
`payout-accounts` subdomains under `src/modules/venue`. Payout-account
verification and tokenized banking metadata are not owned by Inventory.

Responsibilities:

- Manage venues, courts, pricing, content, and payout accounts.
- Embed public venue and court media metadata in `Venue.media` and
  `Court.media`.
- Support `FIXED_SLOT`, `OPEN_TIME`, and `BOTH` court booking modes.
- Generate fixed-slot inventory.
- Represent open-time provisional and blocked intervals using Slot documents.
- Search availability.
- Maintain embedded, bounded inventory audit history.
- Enforce environment isolation and interval-overlap rules.

Rules:

- `Court.operating_hours` is embedded; no `CourtOperatingHour` collection
  exists.
- Fixed-slot holds atomically set `Slot.status = HELD` and persist
  `hold_id`, `hold_partner_id`, `hold_expires_at`, and `hold_created_at`.
- Redis may mirror a durable hold but is not its source of truth.
- Open-time requests must be at least 60 minutes, follow booking increments,
  fit within operating hours, and not overlap active `HELD`, `BOOKED`,
  `BLOCKED`, or `UNAVAILABLE` intervals.
- Court mode and contract mode must both allow the requested booking mode.
- Venue and court media metadata remains embedded; there is no `MediaAsset`
  collection.
- Inventory history is embedded in the parent aggregate; there is no
  `InventoryStateTransition` collection.

Public capabilities:

- `createInitialVenue()`
- `createVenue()`
- `approveVenue()`
- `updateVenue()`
- `updateCourt()`
- `setPricingRule()`
- `generateFixedSlots()`
- `searchAvailability()`
- `holdAvailability()`
- `blockAvailability()`
- `releaseAvailability()`

### 4.3 `contracts`

Contracts owns the effective-dated commercial relationship between one Booking
Partner and one Venue.

Responsibilities:

- Version Partner–venue agreements.
- Define commission and tax terms.
- Define settlement cycles.
- Define allowed booking modes.
- Define cancellation and refund rules.
- Define resale cutoff rules.

Rules:

- Cancellation terms belong to `PartnerVenueContract`, not Venue.
- Historical contract terms are immutable.
- Booking snapshots the effective commercial and cancellation terms.
- A requested booking mode must be allowed by both the Court and Contract.

Public capabilities:

- `getActiveContract()`
- `getCancellationTerms()`
- `isBookingModeAllowed()`

### 4.4 `booking`

Booking orchestrates confirmation and cancellation across Identity, Venue,
Contracts, Ledger, and Communications.

Responsibilities:

- Hold fixed-slot and open-time inventory.
- Confirm `FIXED_SLOT`, `OPEN_TIME`, and `BOTH`-court bookings.
- Enforce idempotent Partner mutations.
- Snapshot contract and cancellation terms.
- Persist bounded `Booking.audit_history`.
- Create a separate `BookingCancellation` record for cancellation details.
- Post Ledger entries.
- Create Outbox events in the business transaction.

Rules:

- Fixed-slot holds are durable on `Slot`; Redis is an optional accelerator.
- Open-time requests use provisional Slot intervals and transactional overlap
  checks.
- Confirmation checks optimistic versions and runs in a MongoDB transaction.
- Confirmation writes Booking, Slot state/audit, Ledger entries, idempotency
  state, and Outbox event atomically.
- Cancellation details belong to `BookingCancellation`; they are not embedded
  in Booking.
- Booking history is embedded in `Booking.audit_history`; no
  `BookingAuditLog` collection exists.
- Customer card data and gateway secrets are never stored.

Public capabilities:

- `holdAvailability()`
- `confirmBooking()`
- `cancelBooking()`
- `getBookingHistory()`

### 4.5 `ledger`

Ledger is the append-only financial record.

Responsibilities:

- Post balanced booking, commission, tax, and reversal entries.
- Allocate partial-refund rounding residuals without unbalancing a journal.
- Validate one Booking/Partner/Venue/Contract/environment scope per journal.
- Post documented, actor-attributed balanced adjustments.
- Link Ledger entries directly to one Settlement and one Payout.
- Preserve immutable financial history.

Rules:

- Entries are never edited or deleted.
- Corrections use new reversal entries.
- `settlement_id` and `payout_id` are linked conditionally.
- Reversal references are validated and cannot be repeated by the Ledger
  service.
- `SettlementItem` and `PayoutItem` do not exist in v1.

Public capabilities:

- `postBooking()`
- `postCancellation()`
- `postAdjustment()`
- `linkToSettlement()`
- `linkToPayout()`

### 4.6 `financial-close`

Financial Close owns settlement, reconciliation, payout, and Partner billing.

Responsibilities:

- Generate Settlement batches from Ledger entries.
- Record Partner remittance in a separate Reconciliation collection.
- Retain detailed reconciliation attempts in
  `Reconciliation.attempt_history`.
- Complete Settlements only after reconciliation.
- Verify Venue-owned payout accounts through Admin review.
- Validate canonical active Owner BUSINESS KYC and payout-account gates.
- Create idempotent Venue payouts, allocate Ledger entries transactionally,
  and record manual results.
- Expose owner-scoped Settlement and Payout history with masked account and
  booking-allocation details.
- Maintain structured Invoice persistence and create/issue/void workflows.

Rules:

- `Settlement` and `Reconciliation` are separate stable collections.
- Reconciliation contains `settlement_id`, `reported_amount_minor`,
  `bank_reference`, `evidence_uri`, `status`, `reconciled_by`,
  `reconciled_at`, `notes`, and embedded `attempt_history`.
- A partial unique index on `(settlement_id, bank_reference)` prevents duplicate
  bank-transaction recording.
- Payout requires a completed Settlement, verified KYC, and a verified payout
  account.
- Manual Payout results move from `PENDING` directly to `PAID` or `FAILED`;
  `PROCESSING` is reserved for provider integration.
- Ledger entries link directly to Settlement and Payout.
- Customer invoices are out of scope.

Public capabilities:

- `generateSettlementBatch()`
- `recordReconciliation()`
- `recordReconciliationAttempt()`
- `completeSettlement()`
- `verifyPayoutAccount()`
- `initiatePayout()`
- `recordPayoutResult()`
- `listOwnerSettlements()`
- `listOwnerPayouts()`

Settlement adjustments, Partner statements, and structured Invoice
service/routes are implemented. Downloadable Invoice files remain deferred.

### 4.7 `admin`

Admin is a privileged orchestration module and owns no business collections.

Responsibilities:

- Actor and venue onboarding approvals.
- KYC review.
- Venue and court support operations.
- Contract configuration.
- Booking and dispute support.
- Settlement, Reconciliation, Payout, and Invoice operations.
- Communications monitoring and retry operations.
- Cross-module read-only reporting.
- Synchronous bounded CSV export, Booking dispute aggregation, and derived
  inventory-health monitoring.

Every mutation must call the public capability of the owning module.

The Venue onboarding approval is one Admin-orchestrated MongoDB transaction:

1. Identity verifies current Venue Owner BUSINESS KYC.
2. Identity validates the active `OWNER` membership and activates the
   `VenueOwner`.
3. Venue activates the `Venue`, records `approved_by`/`approved_at`, increments
   its version, and appends approval audit context.

Admin calls Identity and Venue services; it never writes either collection.

## 5. Shared Infrastructure

### `shared/auth`

- Admin authentication.
- Embedded Venue User session authentication.
- Partner API-key and HMAC authentication.

### `shared/db`

- MongoDB connection management.
- Validator and index bootstrap.
- Transaction helpers.
- Optimistic-version helpers.
- Service-level reference checks.

### `shared/redis`

- Optional fixed-slot hold mirrors.
- Open-time coordination locks.
- Partner rate-limit counters.
- Never persistent truth.

### `shared/media`

- Validate file type and size.
- Upload bytes to object storage.
- Return metadata for embedding in `KycDocument.file`, `Venue.media`, or
  `Court.media`.
- Generate protected access URLs where required.
- Own no business collection.

### `shared/communications`

- Append Outbox events transactionally.
- Run a dedicated worker that atomically claims and recovers leased events.
- Create bounded embedded Venue User notifications.
- Maintain bounded embedded Owner FCM device tokens and remove invalid tokens.
- Deliver subscribed, environment-matched Partner webhooks using signed,
  SSRF-safe HTTPS requests and bounded retry backoff.
- Store delivery state and bounded attempts in
  `OutboxEvent.webhook_deliveries`.
- Enforce environment-matched routing.
- Expose Owner inbox/device APIs and Platform monitoring. ADMIN and OPS may
  retry failed deliveries; SUPPORT is read-only.

### `shared/observability`

- Logs, metrics, traces, alerts, audit context, and secret redaction.

## 6. Non-Negotiable Boundaries

1. The ERD collection list is authoritative.
2. Modules must not recreate collections that v0.9 removed.
3. Cross-module mutations use owning-module capabilities.
4. Fixed-slot holds are durable Slot state; Redis may only mirror them.
5. Open-time bookings use interval overlap checks and support a minimum duration
   of 60 minutes.
6. `BOTH` courts support both fixed-slot and open-time requests.
7. Settlement and Reconciliation remain separate collections.
8. Ledger records are append-only.
9. Notifications, audits, media metadata, sessions, and webhook delivery state
   remain embedded where defined by the ERD.
10. Sandbox and production data never mix.
