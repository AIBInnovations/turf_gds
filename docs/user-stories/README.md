# Turf Booking GDS - User Stories

Source artifacts:

- SRS: `../turf-gds-srs-v0.9.md`
- Production DB ERD: Eraser workspace `CJ18BOmjmz5dXHe9I9gF`
- Historical local ERD artifact: `../../turf-gds-production-erd.dsl`
- Module architecture: `../turf-gds-user-centered-module-architecture.md`

Conflict resolution: the Eraser workspace `CJ18BOmjmz5dXHe9I9gF` is the
canonical persistence definition for v0.9. The checked-in DSL predates the
2026-07-29 migration and must not be used as a schema source. The SRS defines system constraints,
the module architecture defines ownership, and user stories define observable
behavior. A secondary artifact must be updated when it disagrees with this
combined model; it must not introduce a parallel schema.

Business modules:

- `identity`
- `venue`
- `contracts`
- `booking`
- `ledger`
- `financial-close`
- `admin`

Shared infrastructure such as `shared/db`, `shared/redis`, `shared/auth`,
`shared/media`, `shared/communications`, and `shared/observability` supports the
business modules but is not a business module. Media returns metadata for
embedding in owning aggregates. Communications contains the transactional
outbox behavior, embedded Venue User notifications, and embedded Partner
webhook delivery state.

Module ownership guide:

| Module | Main story areas |
|---|---|
| `identity` | Platform User, Venue User, and Booking Partner identity, authentication, authorization, KYC, API keys, usage, and webhook endpoint registration |
| `venue` | Venues, courts, embedded media, pricing, fixed-slot/open-time inventory, embedded audit, and payout accounts |
| `contracts` | Partner–venue commercial and cancellation terms |
| `booking` | Fixed-slot, open-time, and BOTH-mode holds, confirmation, separate cancellation records, idempotency, orchestration, and embedded audit |
| `ledger` | Append-only balanced financial entries and reversals |
| `financial-close` | Separate Settlement and Reconciliation records, payout, and Partner invoicing |
| `admin` | Privileged orchestration, approvals, support, reporting, and operational views |
| `shared/media` | File validation, object-storage access, and metadata generation for embedding |
| `shared/communications` | Transactional outbox, embedded Venue User notifications, embedded Partner webhook delivery, and retries |

Story format:

```md
Story ID:
As a:
I want:
So that:

Acceptance Criteria:
- Given ...
- When ...
- Then ...

Primary Module:
Supporting Modules:
Data:
API/UI:
Priority:
Notes:
```

Epic files:

- [01 Identity And Venue Onboarding](01-platform-and-venue-onboarding.md)
- [02 Identity And Partner Access](02-partner-access-and-developer-portal.md)
- [03 Venue Inventory And Availability](03-venue-inventory-and-availability.md)
- [04 Booking Lifecycle](04-booking-lifecycle.md)
- [05 Ledger And Financial Close](05-ledger-settlement-reconciliation.md)
- [06 Financial Close Payouts And Billing](06-payouts-and-billing.md)
- [07 Shared Communications Infrastructure](07-events-notifications-webhooks.md)
- [08 Admin Orchestration Reporting And Operations](08-admin-reporting-ops.md)
- [09 Shared Infrastructure And Cross-Cutting NFR](09-cross-cutting-nfr.md)

Priority guide:

- `P0`: required for v1 correctness or launch
- `P1`: required for complete operating workflow
- `P2`: useful after core launch

Product notes:

- Owner Dashboard is the only venue-side write path in v1.
- Partner applications are Merchant of Record. The GDS does not process consumer card payments.
- `VenueIntegration` is intentionally not included in the production schema for v1.
- `FIXED_SLOT`, `OPEN_TIME`, and `BOTH` court booking modes are supported.
- Fixed-slot holds persist on `Slot`; Redis may mirror them as an accelerator.
- Open-time provisional intervals and durable booking correctness are enforced
  in MongoDB with transactions, optimistic versions, and overlap checks.
- `BOOKED` is an inventory-interval state, not a court-level state.
