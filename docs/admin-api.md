# Admin Operations And Reporting API

Epic 08 uses Platform User JWT authentication. Send
`Authorization: Bearer <accessToken>` to every route below.

## Role policy

- `ADMIN` may read, mutate, add dispute notes, and export CSV.
- `OPS` and `SUPPORT` may use JSON reads only.
- The existing Communications retry exception for `OPS` is unchanged.

## Venue and Court operations

| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/api/v1/admin/venues` | Filter Venues or create a `PENDING` Venue for an active Owner |
| GET/PATCH | `/api/v1/admin/venues/:venueId` | Read or version-update a Venue |
| GET/POST | `/api/v1/admin/venues/:venueId/courts` | List or create Courts |
| GET/PATCH | `/api/v1/admin/venues/:venueId/courts/:courtId` | Read or version-update a Court |

Venue activation remains the KYC-aware onboarding workflow. Suspension and
reactivation require a reason; reactivation requires current verified Owner
BUSINESS KYC. Court deactivation uses `UNAVAILABLE`. Mutations append bounded
Admin audit events and never hard-delete domain data.

## Reports and exports

`/api/v1/admin/reports/bookings`, `/revenue`, and `/activity` require
`environment`, `from`, and `to`. Ranges are half-open UTC and limited to 366
days. Venue, Partner, Booking status, grouping, dimension, page, and limit
filters are supported where applicable.

Append `/export` for an ADMIN-only UTF-8 RFC 4180 CSV. Exports are synchronous,
bounded to 10,000 rows, and neutralize spreadsheet-formula prefixes. Booking
rows use persisted commercial snapshots; revenue values are derived from
Ledger components, directions, reversals, and adjustments.

## Disputes and inventory health

- `GET /api/v1/admin/disputes/bookings/:bookingId?environment=...` joins the
  Booking, cancellation, actor summaries, Slot/audits, Ledger, Financial Close,
  and redacted Communications evidence.
- `POST /api/v1/admin/disputes/bookings/:bookingId/notes` appends a bounded,
  version-protected Booking audit note.
- `GET /api/v1/admin/operations/inventory-health` reports fixed inventory
  coverage, blocks, unavailable counts, expired holds, and
  `HEALTHY | STALE | EMPTY | DISABLED`.

`ADMIN_INVENTORY_MIN_COVERAGE_DAYS` controls the stale threshold and defaults
to seven days.
