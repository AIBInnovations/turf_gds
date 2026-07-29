# Contracts API

Contracts is canonical business module 3 and owns
`PartnerVenueContract`. All routes are under `/api/v1/admin/contracts` and
require an authenticated Platform User.

| Method | Route | Role | Purpose |
|---|---|---|---|
| POST | `/admin/contracts` | `ADMIN` | Create the next effective contract version |
| GET | `/admin/contracts` | `ADMIN`, `OPS`, `SUPPORT` | List versions, optionally filtered by `partnerId` and/or `venueId` |
| GET | `/admin/contracts/:contractId` | `ADMIN`, `OPS`, `SUPPORT` | Read one immutable contract version |

Creation requires:

- eligible Partner and active Venue identifiers;
- commission and tax basis points whose combined value is at most 10,000;
- a daily, weekly, or monthly settlement cycle;
- one or both supported booking modes;
- cancellation defaults and refund tiers expressed in basis points;
- a non-negative resale cutoff;
- an ISO-8601 effective timestamp later than the latest version.

Weekly cycles require `dayOfWeek` from 1 through 7. Monthly cycles require
`dayOfMonth` from 1 through 28. Refund-rule thresholds must be unique
non-negative minute values; refund percentages must be from 0 through 10,000
basis points.

Creating a new version transactionally closes and supersedes the previous
latest version, then inserts the new active version. Historical financial,
settlement, booking-mode, cancellation, refund, and resale terms are never
edited. Effective lookup considers both the latest active version and
superseded historical versions within their original date range.

The module exposes these internal capabilities to Booking and Financial Close:

- `getActiveContract()`
- `getCancellationTerms()`
- `isBookingModeAllowed()`

Booking can therefore reject a missing effective relationship, enforce
contract booking modes, and snapshot the exact commercial and cancellation
terms used for a transaction.
