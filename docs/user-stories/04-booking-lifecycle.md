# Epic 04 - Booking Lifecycle

## US-04.01 - Hold Availability

Story ID: `US-04.01`
As a: Partner
I want: to place a short-lived hold on fixed-slot or open-time availability
So that: my customer has time to complete payment before confirmation.

Acceptance Criteria:

- Given a valid Partner request for an available `FIXED_SLOT` or fixed slot on a `BOTH` court, when a hold is requested, then an atomic MongoDB update sets Slot to `HELD` and stores `hold_id`, `hold_partner_id`, `hold_expires_at`, and `hold_created_at`.
- Given a valid Partner request for an `OPEN_TIME` interval or open-time request on a `BOTH` court, when a hold is requested, then Booking creates a provisional `HELD` Slot interval after checking operating hours, duration, increments, environment, and overlaps.
- Given a fixed slot or open-time interval already has a conflicting unexpired hold, when another hold is requested, then only one request succeeds.
- Given the requested inventory is held, booked, blocked, unavailable, outside operating hours, shorter than 60 minutes, or disallowed by Court or Contract mode, when hold is requested, then the system rejects the hold.
- Given the hold succeeds, when response is returned, then it includes `hold_id` and expiry.
- Given a fixed-slot hold expires, when the indexed recovery worker runs, then the reusable Slot returns to `AVAILABLE` and its hold fields are cleared without deleting the Slot.
- Given a provisional open-time hold expires, when recovery runs, then the provisional Slot interval is removed or released safely.

Primary Module: `booking`
Supporting Modules: `venue`, `identity`, `shared/redis`, `shared/db`
Data: `Slot`, `Booking`, `PartnerVenueContract`
API/UI: `POST /v1/bookings/hold`
Priority: `P0`
Notes: Slot hold fields are durable operational state. Redis may mirror them, but MongoDB is the source of truth. TTL deletion must not be used for reusable fixed Slots.

## US-04.02 - Confirm Booking Idempotently

Story ID: `US-04.02`
As a: Partner
I want: to confirm a booking after successful customer payment
So that: the slot becomes durably booked in the GDS.

Acceptance Criteria:

- Given a valid `Idempotency-Key`, hold reference, and `external_booking_reference` after customer payment succeeds outside the GDS, when confirmation succeeds, then `Booking` is created with `CONFIRMED` status and the correct booking mode.
- Given the same idempotency key and same request body are retried, when processed, then the original response is returned.
- Given the same idempotency key is reused with a different request body, when processed, then the system rejects the request.
- Given two confirmations race for the same fixed slot, when transactions commit, then only one succeeds because the conditional status/version update allows only one transaction to claim the Slot.
- Given two confirmations race for overlapping open-time intervals, when transactions commit, then only one succeeds because Booking checks overlapping `HELD`, `BOOKED`, `BLOCKED`, and `UNAVAILABLE` intervals with optimistic Slot versions inside the transaction.
- Given fixed-slot confirmation succeeds, when the transaction completes, then the slot becomes `BOOKED`.
- Given open-time confirmation succeeds, when the transaction completes, then the provisional Slot interval becomes `BOOKED` and the Booking stores the confirmed interval.
- Given either booking mode is confirmed, when the transaction commits, then Booking, embedded Slot and Booking audit history, balanced Ledger entries, idempotency response, and Outbox event are written atomically.

Primary Module: `booking`
Supporting Modules: `identity`, `venue`, `contracts`, `ledger`, `shared/communications`, `shared/redis`, `shared/db`
Data: `Booking`, `ApiIdempotencyRecord`, `Slot`, `LedgerEntry`, `OutboxEvent`
API/UI: `POST /v1/bookings/confirm`
Priority: `P0`
Notes: Partner is Merchant of Record; GDS does not process card payment.

## US-04.03 - Capture Booking Commercial Amounts

Story ID: `US-04.03`
As the: System
I want: to snapshot booking value and post commission, tax, and venue-net entries at confirmation time
So that: downstream ledger, settlement, and payout flows do not recalculate historical commercial terms.

Acceptance Criteria:

- Given an active partner-venue contract exists, when booking is confirmed, then commission and tax are calculated from that contract.
- Given no active contract exists, when confirmation is attempted, then booking is rejected.
- Given the booking is confirmed, when persisted, then Booking stores gross amount, currency, contract reference, and commercial-term snapshots, while Ledger stores the balanced commission, tax, and venue-net entries.
- Given contract terms later change, when existing bookings are settled, then stored booking amounts remain unchanged.

Primary Module: `booking`
Supporting Modules: `contracts`, `ledger`
Data: `Booking`, `PartnerVenueContract`, `LedgerEntry`
API/UI: Internal booking confirmation transaction
Priority: `P0`
Notes: Booking owns orchestration and snapshots; Contracts owns the terms; Ledger owns the resulting immutable financial entries.

## US-04.04 - Cancel Booking

Story ID: `US-04.04`
As a: Partner
I want: to cancel a confirmed booking using the configured cancellation policy
So that: refunds and slot disposition are handled consistently.

Acceptance Criteria:

- Given a confirmed booking and valid idempotency key, when cancellation succeeds, then `Booking.status` changes to `CANCELLED` and one `BookingCancellation` record is created.
- Given the snapshotted cancellation terms apply, when cancellation is processed, then `BookingCancellation` stores refund percent, refund amount, reason, actor, and inventory-release decision.
- Given a fixed-slot booking may be resold, when cancelled, then its slot transitions from `BOOKED` to `AVAILABLE`.
- Given an open-time booking may be resold, when cancelled, then its provisional Slot interval is released or removed according to inventory-retention rules.
- Given cancellation terms prohibit release, when either booking mode is cancelled, then the affected inventory remains unavailable for that interval.
- Given cancellation succeeds, when committed, then BookingCancellation, embedded Booking and Slot audit history, Ledger reversal entries, idempotency response, and Outbox event are written atomically.

Primary Module: `booking`
Supporting Modules: `identity`, `venue`, `contracts`, `ledger`, `shared/communications`
Data: `Booking`, `BookingCancellation`, `PartnerVenueContract`, `Slot`, `LedgerEntry`, `OutboxEvent`
API/UI: `POST /v1/bookings/{id}/cancel`
Priority: `P0`
Notes: Cancellation must be idempotent.

## US-04.05 - Owner Dashboard Booking View

Story ID: `US-04.05`
As a: Venue Partner
I want: to view incoming bookings for my venues
So that: I can prepare for customers arriving through partner apps.

Acceptance Criteria:

- Given an owner has `VIEW_BOOKINGS`, when booking list is requested, then only bookings for the owner's venues are shown.
- Given a booking is shown, when details load, then its `external_booking_reference` is visible where present.
- Given owner dashboard requests booking creation, when attempted, then the system does not allow owner-created bookings in v1.
- Given filters are applied by date, court, or status, when list loads, then results match filters.

Primary Module: `booking`
Supporting Modules: `identity`, `venue`
Data: `Booking`, `Slot`, `Court`, `Venue`, `PartnerVenueContract`
API/UI: Owner Dashboard booking list
Priority: `P1`
Notes: Venue Users can block fixed slots or open-time intervals, but bookings are created only by Booking Partners in v1.

## US-04.06 - Booking Audit Trail

Story ID: `US-04.06`
As an: Admin
I want: every booking status transition to be audited
So that: disputes can be investigated from immutable operational history.

Acceptance Criteria:

- Given booking status changes, when committed, then bounded append-only `Booking.audit_history` captures actor, previous status, new status, reason, details, and correlation ID.
- Given logs are requested by admin, when a booking is selected, then transitions are shown in chronological order.
- Given audit records exist, when retention checks run, then records are retained for at least 2 years.

Primary Module: `booking`
Supporting Modules: `admin`, `shared/db`
Data: `Booking.audit_history`
API/UI: Admin booking detail audit panel
Priority: `P0`
Notes: Booking audit entries are bounded embedded documents retained according to policy and MongoDB document-size limits.
