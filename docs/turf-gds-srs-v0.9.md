# Software Requirements Specification
## Turf Booking GDS

> Historical requirements baseline. For persisted collections, fields,
> relationships, and states, the live Eraser workspace
> `CJ18BOmjmz5dXHe9I9gF` is authoritative. See
> `eraser-authoritative-migration-2026-07-29.md`.

Version 0.9 - MongoDB-only persistence, reduced collections, and production outbox routing revision.

### Source-Of-Truth Order

For v0.9, `turf-gds-production-erd.dsl` is the canonical collection, field,
relationship, and state definition. This SRS defines system invariants, the
module architecture defines ownership, and the user stories define observable
behavior. Eraser diagrams and module references are synchronized views, not
independent sources that may introduce different collections or state names.

## 1. Persistence Decision

The system uses MongoDB as the only persistent database for v1.

All domain data is stored in MongoDB collections, including:

- admin, venue owner, partner, and embedded owner session data
- venues, courts, pricing, slots, and booking intervals
- KYC metadata and embedded venue/court media metadata
- partner contracts and cancellation terms
- bookings, cancellations, idempotency, ledger, settlement, payout, invoices
- outbox events with embedded webhook delivery attempts, embedded notifications and audit history, and flexible venue content

Redis may still be used as an ephemeral cache or short-lived hold accelerator, but Redis is not a persistent source of truth.

## 2. Consequences Of MongoDB-Only

MongoDB-only is acceptable for a smaller v1, but the system must replace relational guarantees with explicit MongoDB patterns:

- Use MongoDB multi-document transactions for booking confirmation, cancellation, settlement, payout, ledger posting, and outbox insertion.
- Use unique indexes for idempotency keys, API key prefixes, webhook endpoint uniqueness, settlement periods, payout idempotency, and membership uniqueness.
- Use JSON schema validators for enum values, required fields, money fields, date ordering, and document shape.
- Use optimistic locking with `version` fields on mutable documents such as `Venue`, `Court`, `Slot`, and `Booking`.
- Use service-level reference checks because MongoDB does not enforce foreign keys.
- Use application-level interval overlap checks because MongoDB does not natively enforce time-range exclusion constraints.
- Use restricted database permissions to keep ledger entries append-only and application validators to make embedded audit history append-only.

## 3. Admin Identity

The internal staff collection is `AdminUser`.

This replaces the older `PlatformUser` name and makes the admin table explicit.

No separate admin profile collection is needed for v1 unless admin preferences or HR-style metadata become product requirements.

## 4. Booking Modes

The system supports two booking modes:

- `OPEN_TIME`: a partner can book any valid interval of at least 60 minutes.
- `FIXED_SLOT`: a partner can book only venue-defined slots.
- `BOTH`: a court supports both models.

`Court.booking_mode` defines allowed mode per court.

`PartnerVenueContract.allowed_booking_modes` defines what a partner is commercially allowed to book for that venue.

For open-time booking:

- `Court.min_booking_minutes` must be at least 60.
- `Court.booking_increment_minutes` controls valid start/end increments.
- The requested interval must fit inside `Court.operating_hours`.
- The system must reject overlaps with active `BOOKED`, `BLOCKED`, or `UNAVAILABLE` intervals.

For fixed-slot booking:

- The system pre-generates `Slot` documents from court rules.
- Partners book only available offered slots.

## 5. Slot Concurrency

MongoDB does not provide a native exclusion constraint for overlapping time ranges.

To prevent double booking:

- Hold requests atomically change the relevant `Slot` to `HELD` and store `hold_id`, `hold_partner_id`, `hold_expires_at`, and `hold_created_at` on it. Redis may mirror this state as an accelerator.
- Confirm requests run inside a MongoDB transaction.
- Before inserting/updating a booking interval, the service must query for overlapping `HELD`, `BOOKED`, `BLOCKED`, or `UNAVAILABLE` intervals for the same `court_id` and `environment`.
- The transaction must update the relevant `Slot` and `Booking` audit histories and insert the `Booking`, `LedgerEntry`, and `OutboxEvent` together.
- `version` fields must be checked during updates to avoid lost writes.
- An indexed recovery worker must release expired fixed-slot holds and remove expired provisional open-time slots. A TTL index must not be used because it would delete pre-generated fixed slots.

## 5.1 Embedded Sessions, FCM Tokens, And Media

- `VenueOwner.sessions` embeds a bounded array of hashed dashboard sessions. The auth service must prune expired and revoked entries because MongoDB TTL indexes cannot remove individual array elements.
- `AdminUser.fcm_tokens` and `VenueOwner.fcm_tokens` store per-device token documents (`token`, `device_id`, `platform`, timestamps). Tokens must be removed when FCM reports them invalid.
- `VenueOwner.notifications` stores a bounded recent dashboard-notification inbox on the owner document.
- Venue and court media metadata is embedded in `Venue.media` and `Court.media`. The binary files remain in object storage.
- KYC file metadata is embedded in `KycDocument.file` so KYC documents do not depend on a general media collection.
- Mutable business aggregates store bounded `audit_history` arrays instead of using a general audit collection.
- `OutboxEvent.webhook_deliveries` stores per-endpoint delivery state and bounded request/response attempts.
- `OutboxEvent.partner_id`, `venue_id`, and `webhook_endpoint_ids` provide explicit routing relationships while `aggregate_type + aggregate_id` remains the polymorphic source identity.
- Every outbox event carries an `environment` and must target endpoints in the same environment.
- Workers atomically claim events by changing `PENDING` to `PROCESSING` and setting `locked_by` and `locked_until`. Expired claims can be recovered.

## 6. Court Operating Hours

`CourtOperatingHour` is removed.

Court timing is embedded in `Court.operating_hours`.

This is intentionally simpler for v1. If operating hour versioning, holiday exceptions, seasonal calendars, or historical audits become complex, split operating hours into a dedicated collection later.

## 7. Cancellation Terms

`CancellationPolicy` and `CancellationPolicyTier` are removed.

Cancellation terms are stored in `PartnerVenueContract`:

- `cancellation_terms`
- `refund_rules`
- `resale_cutoff_minutes`
- `terms_version`

`Booking.cancellation_terms_snapshot` captures the terms at confirmation time.

Venue owners cannot change cancellation terms directly from the Owner Dashboard. Changes require a new or updated partner-venue contract.

## 8. Settlement, Reconciliation, And Payout Stability

`Settlement` and `Payout` remain first-class core collections and should not be removed.

Because `Settlement` must remain stable, reconciliation is not merged into `Settlement`.

`Reconciliation` remains a separate MongoDB collection with:

- `settlement_id`
- `reported_amount_minor`
- `bank_reference`
- `evidence_uri`
- `status`
- `reconciled_by`
- `reconciled_at`
- `notes`

Reason: removing `Reconciliation` would require adding reconciliation fields to `Settlement`, which conflicts with the decision that settlement should not change.

Detailed reconciliation attempts are embedded in `Reconciliation.attempt_history`.

## 9. Settlement And Payout Allocation

`SettlementItem` and `PayoutItem` are removed for v1.

`LedgerEntry` directly stores:

- `settlement_id`
- `payout_id`

This is acceptable while each ledger entry belongs to one settlement and one payout allocation. If partial settlement, split payout, many-to-many allocation, or complex adjustment allocation appears, restore separate allocation collections.

## 10. Core Collections

Primary MongoDB collections:

- `AdminUser`
- `VenueOwner`
- `Venue`
- `VenueOwnerMembership`
- `VenueRolePermission`
- `VenuePayoutAccount`
- `KycVerification`
- `KycDocument`
- `Court`
- `PricingRule`
- `Slot`
- `Partner`
- `PartnerApiKey`
- `ApiUsageDaily`
- `WebhookEndpoint`
- `PartnerVenueContract`
- `Booking`
- `BookingCancellation`
- `ApiIdempotencyRecord`
- `LedgerEntry`
- `Settlement`
- `Reconciliation`
- `Payout`
- `Invoice`
- `OutboxEvent`
- `VenueContent`

Removed from the prior model:

- `PlatformUser` renamed to `AdminUser`
- `VenueOwnerSession`, replaced by bounded `VenueOwner.sessions`
- `MediaAsset`, with metadata embedded in `Venue.media`, `Court.media`, and `KycDocument.file`
- `VenueMedia` and `CourtMedia` join tables, replaced by embedded media arrays
- `SlotLock`, replaced by hold fields and `HELD` status on `Slot`
- `CourtOperatingHour`
- `CancellationPolicy`
- `CancellationPolicyTier`
- `VenueOwnerNotification`, replaced by bounded `VenueOwner.notifications`
- `WebhookDelivery`, replaced by `OutboxEvent.webhook_deliveries`
- `WebhookPayloadArchive`, replaced by bounded delivery-attempt payloads inside `OutboxEvent`
- `AuditEvent`, `BookingAuditLog`, and `InventoryStateTransition`, replaced by bounded parent `audit_history` arrays
- `SettlementItem`
- `PayoutItem`

## 11. Required Indexes

Required unique indexes:

- `AdminUser.email`
- `VenueOwner.email`
- `VenueOwner.sessions.token_hash` multikey
- `AdminUser.fcm_tokens.token` multikey
- `VenueOwner.fcm_tokens.token` multikey
- `KycDocument.file.storage_key`
- `KycDocument(kyc_verification_id, document_type, file.checksum)`
- `VenueOwnerMembership(owner_id, venue_id)`
- `VenueRolePermission(role, permission)`
- `VenuePayoutAccount.vault_account_token`
- `KycVerification(subject_type, subject_id, verification_type)` where `is_current = true`
- `Court(venue_id, name)`
- `PartnerApiKey.key_prefix`
- `ApiUsageDaily(partner_id, environment, usage_date)`
- `WebhookEndpoint(partner_id, environment, url)`
- `PartnerVenueContract(partner_id, venue_id, effective_from)`
- `Booking(contract_id, environment, confirm_idempotency_key)`
- `Booking(contract_id, environment, external_booking_reference)` partial where external reference exists
- `ApiIdempotencyRecord(partner_id, environment, operation, idempotency_key)`
- `Settlement(partner_id, environment, period_start, period_end)`
- `Reconciliation(settlement_id, bank_reference)` partial where bank reference exists
- `Payout.idempotency_key`
- `Payout(settlement_id, venue_id)`
- `Invoice.invoice_number`
- `OutboxEvent(aggregate_type, aggregate_id, event_type, correlation_id)`
- `VenueContent.venue_id`

Required non-unique indexes:

- `Venue.geo` as `2dsphere`
- `Venue(environment, status)`
- `Court(venue_id, status, booking_mode)`
- `Slot(court_id, environment, starts_at, ends_at, status)`
- `Slot(status, hold_expires_at)`
- `Booking(partner_id, environment, status, starts_at)`
- `Booking(venue_id, environment, status, starts_at)`
- `LedgerEntry(settlement_id)`
- `LedgerEntry(payout_id)`
- `OutboxEvent(status, available_at, locked_until)`
- `OutboxEvent(webhook_deliveries.status, webhook_deliveries.next_attempt_at)` multikey

Required TTL indexes:

- `ApiIdempotencyRecord.expires_at`

Expired embedded owner sessions and slot holds require indexed application workers; TTL cannot safely remove individual session array elements or reset reusable slot documents.

Embedded notifications, audit histories, webhook deliveries, and delivery attempts must have explicit caps and retention rules so parent documents cannot grow without limit or approach MongoDB's 16 MB document limit.

## 12. Non-Negotiable Service Rules

- No double booking under concurrency.
- No booking shorter than 60 minutes for open-time booking.
- No booking outside court operating hours.
- No booking mode outside both `Court.booking_mode` and `PartnerVenueContract.allowed_booking_modes`.
- No cancellation rule changes outside contract update/re-contract.
- No mutable ledger entries.
- No payout unless settlement is completed, KYC is verified, and payout account is verified.
- No sandbox-production data mixing.
- No raw bank account or card data stored in MongoDB.
