# Venue Owner API

All routes are under `/api/v1` and require a Venue Owner Bearer session.

## Venue Profile

| Method | Route | Permission | Purpose |
|---|---|---|---|
| GET | `/owner/venues/:venueId` | Active membership | Read the scoped Venue profile |
| PATCH | `/owner/venues/:venueId` | `MANAGE_VENUE` | Update profile fields using optimistic versioning |
| POST | `/owner/venues/:venueId/media?version=:version` | `MANAGE_VENUE` | Upload public media and embed its metadata |

PATCH accepts `version` and one or more of:

- `legalName`
- `displayName`
- `timezone`
- complete `address`
- `latitude` and `longitude` together
- `currency`, which can only be `INR`

Every successful mutation increments `Venue.version` and appends a bounded
audit event containing the Venue Owner actor, correlation ID, timestamp, and
changed fields. A stale version returns `VENUE_VERSION_CONFLICT`.

Venue media accepts JPEG, PNG, WebP, and MP4 up to 10 MB. Cloudinary stores the
bytes; MongoDB embeds only public delivery metadata. The Venue aggregate is
bounded to 20 media items. If persistence fails after upload, the uploaded
object is deleted.

Identity owns membership and permission decisions. Venue owns profile, media,
version, and audit persistence. An owner cannot read or mutate another Venue
without an active membership, and mutation additionally requires
`MANAGE_VENUE`.

## Courts

| Method | Route | Permission | Purpose |
|---|---|---|---|
| POST | `/owner/venues/:venueId/courts` | `MANAGE_COURTS` | Create a Court |
| GET | `/owner/venues/:venueId/courts` | Active membership | List Venue Courts |
| GET | `/owner/venues/:venueId/courts/:courtId` | Active membership | Read a Venue-scoped Court |
| PATCH | `/owner/venues/:venueId/courts/:courtId` | `MANAGE_COURTS` | Update Court configuration or status |
| POST | `/owner/venues/:venueId/courts/:courtId/media?version=:version` | `MANAGE_COURTS` | Upload Court media metadata |
| PUT | `/owner/venues/:venueId/courts/:courtId/operating-hours` | `MANAGE_AVAILABILITY` | Replace operating hours using Court versioning |

Court names are case-insensitively unique within a Venue. Booking mode must be
`FIXED_SLOT`, `OPEN_TIME`, or `BOTH`. Minimum booking duration is at least 60
minutes and must be divisible by the booking increment. A Court inherits the
Venue timezone unless a valid IANA timezone is supplied.

Court updates and media uploads use `Court.version` for optimistic concurrency.
Setting status to `INACTIVE` disables the Court for later inventory generation
and search behavior. Court media has the same public Cloudinary metadata,
10 MB file, 20-item bound, and failed-write cleanup rules as Venue media.

Operating hours use ISO weekdays 1-7 and `HH:mm` local times. Each day may
appear once, opening must precede closing, and the complete replacement is
sorted and saved with optimistic Court versioning.

## Pricing And Inventory

| Method | Route | Permission | Purpose |
|---|---|---|---|
| POST | `/owner/venues/:venueId/courts/:courtId/pricing-rules` | `MANAGE_PRICING` | Create an effective-dated INR pricing rule |
| GET | `/owner/venues/:venueId/courts/:courtId/pricing-rules` | `MANAGE_PRICING` | List Court pricing rules |
| PATCH | `/owner/venues/:venueId/courts/:courtId/pricing-rules/:pricingRuleId` | `MANAGE_PRICING` | Edit or deactivate a pricing rule |
| POST | `/owner/venues/:venueId/courts/:courtId/slots/generate` | `MANAGE_AVAILABILITY` | Generate up to 31 days of fixed inventory |
| GET | `/owner/venues/:venueId/courts/:courtId/inventory?from=:from&to=:to` | `MANAGE_AVAILABILITY` | Read the owner inventory calendar |
| POST | `/owner/venues/:venueId/courts/:courtId/inventory/block` | `MANAGE_AVAILABILITY` | Block a fixed Slot or an open-time interval |
| POST | `/owner/venues/:venueId/courts/:courtId/inventory/:slotId/release` | `MANAGE_AVAILABILITY` | Release owner-blocked inventory |

The highest-priority active pricing rule wins. Generation is idempotent,
preserves the Venue environment, ignores inactive Courts and Venues, and does
not create availability over held, booked, blocked, or unavailable intervals.
Fixed Slot changes use Slot versions. Open-time block creation uses the Court
version as a transactional mutex and rejects conflicting durable inventory.
Slot audit history records the actor, state change, reason, correlation ID, and
timestamp.

## Payout Accounts

| Method | Route | Permission | Purpose |
|---|---|---|---|
| POST | `/owner/venues/:venueId/payout-accounts` | `VIEW_FINANCE` | Add tokenized payout metadata |
| GET | `/owner/venues/:venueId/payout-accounts` | `VIEW_FINANCE` | List masked payout accounts |

The API accepts a vault token and last four digits; it never accepts, persists,
or returns a raw account number. New accounts remain `PENDING`. Admin
verification fields remain empty until the later Admin API phase.

## Bookings

| Method | Route | Permission | Purpose |
|---|---|---|---|
| GET | `/owner/venues/:venueId/bookings` | `VIEW_BOOKINGS` | List bookings for one scoped Venue |
| GET | `/owner/venues/:venueId/bookings/:bookingId` | `VIEW_BOOKINGS` | Read one Venue-scoped booking and its cancellation outcome |

The list accepts optional `from`, `to`, `courtId`, and `status` filters.
`from` is inclusive and `to` is exclusive against the booking start time.
Supported statuses are `CONFIRMED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`,
and `DISPUTED`.
Pagination uses `page` (default 1) and `limit` (default 50, maximum 100), and
returns `items` plus page, limit, total, and page-count metadata.

Both list and detail responses expose the Partner's
`externalBookingReference` where present. Cancellation detail includes the
reason, refund basis points and amount, whether inventory was released, and
the cancellation timestamp. Confirmation/cancellation idempotency keys and
embedded audit internals are not exposed to Venue Users.

Booking reads require `VIEW_BOOKINGS` on the exact Venue before MongoDB is
queried. Booking detail lookup includes the Venue ID in its database predicate,
so an identifier from another Venue returns `BOOKING_NOT_FOUND`. There is no
Venue Owner booking-creation route in v1. Venue Users continue to perform their
permitted operational action—blocking or releasing availability—through the
Venue inventory routes.

## Venue Owner Capability Order

Within the canonical Venue module, Venue Owner capabilities proceed as:

1. Venue profile and media - complete
2. Courts, court media, and operating hours - complete
3. Pricing rules - complete
4. Inventory generation and manual blocking/release - complete
5. Payout-account management - complete

The implemented Venue Owner slice of the canonical Venue module is complete
except for the Partner-facing availability route. The
underlying availability rules are retained in the Venue service, but no
Partner availability route is registered. Admin payout verification and
Partner-Venue cancellation terms have no actor-facing routes in this phase;
their Admin-owned fields remain null or pending.

The Venue Owner read/dashboard slice and the separate Partner Booking
lifecycle are complete. Partner hold, confirmation, and cancellation remain
outside the Venue Owner API and are documented in `booking-api.md`.
