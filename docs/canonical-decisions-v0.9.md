# Turf GDS v0.9 Canonical Decisions

This document records the conflict resolution across the SRS, production ERD,
module architecture, user stories, and implementation.

## Authority

1. `turf-gds-production-erd.dsl` defines persisted collections, fields,
   relationships, and states.
2. The SRS defines system-wide invariants and non-negotiable behavior.
3. The module architecture defines collection ownership and dependencies.
4. User stories define actor-visible behavior and acceptance criteria.
5. Eraser files are synchronized views of these repository artifacts.

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
- Venue owns Venue configuration, courts, pricing, slots, content, embedded
  public media metadata, and payout accounts.
- Contracts owns effective-dated `PartnerVenueContract` records.
- Booking owns Booking, separate Booking Cancellation, and API idempotency.
- Ledger exclusively owns append-only Ledger Entry writes.
- Financial Close owns separate Settlement, Reconciliation, Payout, and
  Invoice records.
- Admin owns no collections. It authenticates a Platform User through Identity
  and orchestrates public capabilities of owning modules.

## Canonical State Models

- Venue Owner: `PENDING → ACTIVE`; `SUSPENDED` is an administrative restriction.
- Venue: `DRAFT → PENDING_APPROVAL → ACTIVE`; an active Venue may be
  `SUSPENDED`.
- KYC Verification:
  `DRAFT → SUBMITTED → IN_REVIEW → VERIFIED | REJECTED`, with `EXPIRED` for
  expired verification and one current record per subject/type.
- Partner: `ONBOARDING → SANDBOX → ACTIVE`; `SUSPENDED` restricts access.
- Partner integration review:
  `NOT_STARTED → PENDING → PASSED | FAILED`.
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
