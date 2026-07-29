# Turf GDS Development Process

## Perspective Order

Development follows complete actor perspectives rather than building all actor
APIs in parallel:

1. Venue Owner
2. Admin
3. Partner

The Venue Owner phase is the active phase. The Admin phase begins only after
the Venue Owner feature set is complete and passing its regression suite. The
Partner phase begins only after the Admin feature set is complete and passing
its regression suite.

Minimal Admin or Partner internals may be added earlier only when a Venue Owner
workflow cannot be exercised correctly without them. This does not open the
later actor-facing API phase.

## Canonical Implementation Rule

The module architecture defines ownership and dependency direction, user
stories define observable acceptance criteria, and the production ERD defines
the persisted MongoDB contract. Development must not bypass or replace any of
these artifacts.

Inside each canonical module, the Venue Owner-facing capabilities are built and
tested first. Admin and Partner capabilities for that module follow only after
the Venue Owner slice is complete, except for minimal dependencies needed to
exercise a Venue Owner workflow.

## Module Completion Gate

For each module in the active actor phase:

1. agree on the actor-visible use cases and acceptance criteria;
2. implement the persisted model and indexes required by the canonical ERD;
3. implement services, authorization, validation, routes, and error behavior;
4. add unit tests for business rules and edge cases;
5. add integration tests for the API, persistence, and actor isolation;
6. add security tests where authentication, authorization, uploads, secrets,
   or sensitive data are involved;
7. run type checking, build, module tests, and the complete regression suite;
8. fix all failures and mark the module complete before starting the next one.

Partial scaffolding does not count as completion. New work in the next module
starts only after the current module passes this gate.

## Venue Owner Phase

The Venue Owner phase is developed in this sequence:

1. **Identity** - registration, login, session lifecycle, profile,
   memberships, roles/permissions, and KYC submission.
2. **Venue** - venue profile, courts, pricing, operating hours, media,
   inventory, availability controls, and payout accounts.
3. **Contracts** - effective-dated Partner-Venue commercial, settlement,
   booking-mode, cancellation, refund, and resale terms. Because Booking
   cannot be correct without an active contract, the minimal Admin
   configuration surface is completed as a cross-actor prerequisite.
4. **Booking** - owner-scoped booking lists/details and permitted operational
   actions.
5. **Financial Close** - owner-scoped payout history and details.
6. **Communications** - owner notifications and device-token lifecycle.

All reads and mutations must be scoped through the authenticated Venue Owner's
active membership. Tests must prove that one owner cannot access or mutate
another owner's venue data.

## Phase Status

- Venue Owner / Identity: complete as of 2026-07-28. Registration transaction,
  login/session security, profile, memberships, permissions, KYC submission,
  route validation, MongoDB rollback, and cross-owner isolation are covered by
  the regression suite.
- Venue Owner / Venue: complete as of 2026-07-28. Venue and Court management,
  media, operating hours, pricing, rolling fixed inventory, manual fixed/open
  blocking and release, flexible content, and tokenized payout accounts are
  implemented with authorization, versioning, audit, persistence, route, and
  integration coverage.
- Contracts: complete as of 2026-07-29. Admin configuration creates
  transactional effective-dated versions while historical commercial and
  cancellation terms remain unchanged. Active/as-of lookup, cancellation
  snapshots, and booking-mode checks are available to downstream modules.
- Venue Owner / Booking: complete as of 2026-07-29. Owner-scoped Booking lists
  and details, date/Court/status filtering, bounded pagination, external
  Partner references, cancellation outcomes, canonical persistence/indexes,
  and cross-owner isolation are covered. Partner-only hold, confirmation,
  commercial snapshot, cancellation, idempotency, audit, Ledger, and Outbox
  transaction flows are covered. Owner inventory controls remain in Venue.
- Venue Owner / Financial Close and Communications: pending.
- Admin and Partner actor phases: frozen until Venue Owner completion, except
  for minimal dependencies required to exercise Venue Owner workflows.

## Later Phases

After Venue Owner completion:

- build and test the Admin API module-by-module, including approvals,
  operations, contracts, support, reporting, and financial workflows;
- then build and test the Partner API module-by-module, including credentials,
  availability, booking lifecycle, idempotency, reporting, and webhooks.

The canonical ERD, SRS invariants, and module ownership boundaries remain in
force throughout all three phases.
