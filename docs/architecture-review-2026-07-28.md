# Architecture and User-Story Review

Date: 2026-07-28

## Reviewed Sources

- `turf-gds-srs-v0.9.md`
- `turf-gds-user-centered-module-architecture.md`
- `turf-gds-module-reference.md`
- all 53 stories in `docs/user-stories`
- local `turf-gds-production-erd.dsl`
- linked Eraser ERD workspace `CJ18BOmjmz5dXHe9I9gF`
- Eraser `Turf Booking GDS — Complete Module Reference (v2)`
- the currently implemented `src/modules` tree

## Confirmed Decisions

- The system is a modular monolith with seven business modules:
  `identity`, `venue`, `contracts`, `booking`, `ledger`,
  `financial-close`, and `admin`.
- `identity` owns `AdminUser`, Venue User and Partner identity, credentials,
  memberships, permissions, KYC, API usage, and webhook configuration.
- `admin` owns no business collection. It authenticates a Platform User through
  Identity and orchestrates owning-module capabilities.
- `venue` remains separate because it owns venue configuration and inventory.
- MongoDB is the only persistent database. Redis is temporary coordination and
  rate-limit infrastructure.
- Sessions, notifications, audit history, venue/court media metadata, and
  webhook delivery attempts remain embedded where the v0.9 ERD defines them.
- `BookingCancellation` and `Reconciliation` remain separate collections.
- Ledger entries remain append-only.
- Partner applications are Merchant of Record; the GDS stores no customer card
  data.

## User-Story Quality Check

- 53 stories were found across nine epics.
- Story IDs are unique and agree with their epic numbering.
- Every story has acceptance criteria, module ownership, data, API/UI, priority,
  and notes.
- Every referenced module belongs to the seven-module map or the declared
  shared-infrastructure list.
- All seven business modules have story coverage.
- API examples are now consistently rooted at `/api/v1`.
- `ApiUsageDaily` ownership was clarified: Identity owns the persisted daily
  aggregate; Shared Observability owns raw telemetry.

## Corrected Implementation Layout

```text
src/modules/
├── admin/
│   └── onboarding/
│       ├── onboarding.routes.ts
│       └── onboarding.service.ts
├── identity/
│   ├── platform/
│   │   ├── auth.routes.ts
│   │   ├── auth.service.ts
│   │   ├── auth.repository.ts
│   │   └── auth.types.ts
│   ├── owner/
│   ├── partner/
│   ├── kyc/
│   └── shared/
└── venue/
```

This keeps `AdminUser` authentication under its owning Identity module and
keeps the Admin module repository-free.

## Conflict Resolution

### 1. Canonical ERD selected

The repository's `turf-gds-production-erd.dsl` is canonical because it aligns
with the SRS, all 53 stories, and the implemented state machines. Venue Owner,
Venue, KYC, Partner, Court, Slot, cancellation, reconciliation, and embedded
data decisions are recorded in `canonical-decisions-v0.9.md`.

The linked Eraser diagrams must be replaced byte-for-byte from that DSL. The
Eraser connector requires separate explicit approval before sending the full
repository schema to the external workspace.

### 2. Secondary Eraser module reference superseded

That reference describes nine modules and standalone media/event collections,
embeds cancellation into Booking, and embeds reconciliation into Settlement.
Those decisions conflict with the SRS, local module reference, user stories,
and local v0.9 ERD.

It is superseded by `turf-gds-module-reference.md` and
`canonical-decisions-v0.9.md`. It must be synchronized before further use.

### 3. Venue approval workflow corrected

Admin onboarding now verifies BUSINESS KYC, validates the active OWNER
membership, activates the Venue Owner through Identity, and activates/audits
the Venue through Venue inside one MongoDB transaction.

### 4. Most business modules are intentionally not implemented yet

Identity, initial Venue persistence, and the first Admin onboarding workflow
exist. Contracts, booking, ledger, financial close, communications workers,
full venue inventory, Redis coordination, and reporting are still planned work.
This is normal for the current development stage, but it means the complete
user-story set is not yet delivered.

## Recommended Next Work

1. Explicitly approve sending the canonical DSL and module reference to the
   linked Eraser workspaces.
2. Complete Venue and inventory capabilities.
3. Continue through Contracts, Booking, Ledger, and Financial Close in the
   sequence recorded in `canonical-decisions-v0.9.md`.
