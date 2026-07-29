# Eraser ERD Authoritative Migration

Date: 2026-07-29
Authoritative ERD:
`https://app.eraser.io/workspace/CJ18BOmjmz5dXHe9I9gF`

## Decision

The linked Eraser workspace supersedes the previously checked-in
`turf-gds-production-erd.dsl` model wherever they disagree. No compatibility
collections or duplicate persisted fields may be introduced. API and service
code must translate only to the Eraser field and state model.

## Identity

- `AdminUser` gains bounded `audit_history`.
- `VenueOwner` gains derived `kyc_status` and bounded `audit_history`.
- Owner status becomes `ACTIVE | SUSPENDED`; onboarding is represented by KYC
  and Venue state rather than a pending owner state.
- Sessions use `ip_hash` and `last_seen_at`; raw IP addresses are not stored.
- `VenueOwnerMembership` has no `updated_at`.
- KYC verification uses `PENDING | VERIFIED | REJECTED | EXPIRED` plus audit.
- KYC documents use `PENDING | ACCEPTED | REJECTED`, rejection reason, and the
  Eraser protected-file metadata.
- Partner uses derived `kyc_status`, `PENDING | ACTIVE | SUSPENDED`,
  `rate_limit_tier`, and audit history.
- Partner keys use `key_hash`, document scopes, and
  `ACTIVE | REVOKED | EXPIRED`.
- Usage uses `rate_limited_count`; WebhookEndpoint uses
  `PENDING | ACTIVE | DISABLED` without parallel subscribed-event fields.

## Venue And Inventory

- Venue uses `PENDING | ACTIVE | SUSPENDED`; approval history is embedded
  rather than persisted through parallel approval fields.
- Venue and Court media use the Eraser embedded metadata contract.
- Court uses singular `sport_type`, `surface_type`, `capacity`,
  `AVAILABLE | UNAVAILABLE`, embedded `operating_hours`, and fixed-slot
  duration/anchor fields.
- Pricing uses singular `day_of_week`, nullable time bounds, `price_minor`,
  and boolean `active`.
- Slot gains `venue_id`, `booking_type`, `source`, and nullable `booking_id`.
- Slot removes the parallel local `generation_source`/booking-mode shape.
- Slot `hold_id` receives the specified partial unique index.
- The former `VenueContent` collection and `/content` routes are removed
  because the live Eraser ERD defines no such collection. Historical
  `US-03.09` is superseded pending an approved ERD change.

## Contracts

- Contract lifecycle is `PENDING | ACTIVE | SUSPENDED | TERMINATED`.
- Settlement is `T_PLUS_N | WEEKLY | MONTHLY` plus
  `settlement_lag_days`.
- Commercial fields are `commission_rate_bps` and `tax_rate_bps`.
- Allowed booking mode is one enum value:
  `OPEN_TIME | FIXED_SLOT | BOTH`.
- Refund rules are stored in the contract-owned document.
- Lifecycle and terms changes use bounded `audit_history`.
- `terms_version` is the contract term version; the parallel local `version`
  and `created_by` fields are removed.
- Historical effective records retain terms; only lifecycle/effective bounds
  and audit are changed through owning-module capabilities.

## Booking

- Booking uses `booking_type`.
- Customer and Partner payment references are supported.
- Status is `CONFIRMED | CANCELLED | REFUND_PENDING | REFUNDED | DISPUTED`.
- Booking stores gross, commission, tax, and Venue-net amount snapshots.
- Booking stores cancellation terms snapshot and cancellation timestamp.
- Cancellation uses requested actor, reason code/text, refund percent, and
  explicit Slot disposition.
- API idempotency follows the Eraser response-record shape and TTL index.
- Booking interval ordering is enforced by MongoDB validation.

## Ledger, Financial Close, And Communications

- Ledger uses the Eraser entry types, `effective_at`, `correlation_id`, and
  nullable metadata while remaining append-only.
- Settlement, Reconciliation, Payout, and Invoice use the exact Eraser state
  and amount fields.
- Outbox uses routing references, typed endpoint snapshots, claim/recovery
  state, and bounded embedded webhook deliveries.
- Environment equality and conditional routing requirements remain
  service-level invariants.

## Completion Rule

A module is aligned only when its types, validators, indexes, repositories,
services, routes, fixtures, unit tests, and real-MongoDB integration tests use
the Eraser model without legacy persisted names or states.
