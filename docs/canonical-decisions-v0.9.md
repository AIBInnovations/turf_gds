# Turf GDS v0.9 Canonical Decisions

> Source-of-truth update (2026-07-29): the Eraser workspace
> `CJ18BOmjmz5dXHe9I9gF` is authoritative wherever it conflicts with the
> checked-in DSL or older prose. See
> `eraser-authoritative-migration-2026-07-29.md`.

This document records the conflict resolution across the SRS, production ERD,
module architecture, user stories, and implementation.

## Authority

1. Eraser workspace `CJ18BOmjmz5dXHe9I9gF` defines persisted collections,
   fields, relationships, and states. The checked-in
   `turf-gds-production-erd.dsl` is a historical pre-migration artifact and
   must not be used as an implementation source.
2. The SRS defines system-wide invariants and non-negotiable behavior.
3. The module architecture defines collection ownership and dependencies.
4. User stories define actor-visible behavior and acceptance criteria.
5. The live Eraser workspace takes precedence over every repository artifact.

No document may independently add a collection or use a different state
machine.

## Business Modules

There are exactly seven business modules:

1. `identity`
2. `venue`
3. `contracts`
4. `booking`
5. `ledger`
6. `financial-close`
7. `admin`

Media, communications, authentication primitives, MongoDB helpers, Redis, and
observability are shared infrastructure. They are not additional business-data
owners.

## Ownership

- Identity owns `AdminUser`, Venue Owner identity and memberships, roles and
  permissions, KYC, Partners, Partner keys, daily API usage, and webhook
  endpoint configuration.
- Venue owns Venue configuration, courts, pricing, slots, embedded public
  media metadata, and payout accounts.
- Contracts owns effective-dated `PartnerVenueContract` records.
- Booking owns Booking, separate Booking Cancellation, and API idempotency.
- Ledger exclusively owns append-only Ledger Entry writes.
- Financial Close owns separate Settlement, Reconciliation, Payout, and
  Invoice records.
- Admin owns no collections. It authenticates a Platform User through Identity
  and orchestrates public capabilities of owning modules.

## Canonical State Models

- Venue Owner: `ACTIVE | SUSPENDED`; onboarding readiness is represented by
  KYC and Venue state.
- Venue: `PENDING | ACTIVE | SUSPENDED`.
- KYC Verification: `PENDING | VERIFIED | REJECTED | EXPIRED`; submission is
  represented by a bounded audit event rather than another persisted state.
- Partner: `PENDING | ACTIVE | SUSPENDED`.
- Court booking mode: `OPEN_TIME`, `FIXED_SLOT`, or `BOTH`.
- Slot state: `AVAILABLE`, `HELD`, `BOOKED`, `BLOCKED`, or `UNAVAILABLE`.

## Persistence Decisions

- MongoDB is the only persistent database.
- Redis may accelerate or coordinate but is never durable truth.
- Venue Owner sessions, notifications, FCM tokens, Venue/Court media metadata,
  audit histories, and webhook delivery attempts remain embedded as defined by
  the ERD.
- KYC uses a draft/upload/submit lifecycle with protected Cloudinary storage and
  separate `KycDocument` records.
- `BookingCancellation` remains separate from Booking.
- `Reconciliation` remains separate from Settlement.
- Ledger entries are append-only; corrections are reversal entries.
- Sandbox and production records never mix.
- The Partner is Merchant of Record; no customer card data is stored.

## Approval Transaction

`POST /api/v1/admin/onboarding/venues/{venueId}/approve` accepts `ownerId`.
Inside one MongoDB transaction it:

1. confirms current BUSINESS KYC is verified;
2. confirms the owner has an active `OWNER` membership for the Venue;
3. activates the Venue Owner through Identity;
4. activates the Venue through Venue;
5. stores approval and audit metadata.

Payout account verification is not required for Venue activation, but it is
required later for payout.

## Development Process And Implementation Sequence

Development is actor-focused and proceeds in this order:

1. Venue Owner APIs and workflows;
2. Admin APIs and workflows;
3. Partner APIs and workflows.

The current phase is **Venue Owner**. Admin and Partner capabilities may be
implemented only when they are a minimal dependency of a Venue Owner workflow;
their complete actor-facing API phases start after the Venue Owner phase is
finished.

Within an actor phase, work is completed one module at a time. A module is not
complete until its scoped data model, service behavior, authorization, routes,
validation, error handling, and relevant unit/integration/security tests are
implemented. Type checking, build, the module test suite, and the full
regression suite must pass before development moves to the next module.

For the Venue Owner phase, the working sequence is:

1. Identity: registration, authentication, sessions, memberships, permissions,
   and owner KYC submission;
2. Venue: venue profile, courts, pricing, media, operating hours, inventory,
   availability controls, and payout-account management;
3. Booking: owner-scoped booking visibility and operational actions;
4. Financial Close: owner-scoped payout history;
5. Communications: owner notifications and device-token management.

No module should be left as an untested skeleton while development advances to
the next module. The Admin phase follows the same completion gate, followed by
the Partner phase.

## 2026-07-31 Implementation Amendment

The completed backlog requires two additive persistence changes:

- `ApiUsageDaily.rate_limit_window_started_at` and
  `rate_limit_window_count` support the atomic MongoDB fallback for temporary
  Redis rate-limit counters.
- `AuditEvent` is an append-only two-year Booking/Slot audit archive. Recent
  histories remain capped and embedded; state changes dual-write archive
  events transactionally, and `retain_until` has a TTL index.

The local validators and migrations implement this amendment. The matching
authoritative Eraser update remains an explicit release gate until external
workspace write permission is approved.
