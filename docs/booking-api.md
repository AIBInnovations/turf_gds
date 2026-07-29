# Partner Booking Lifecycle API

Date: 2026-07-29

All Partner routes require HMAC authentication and the `bookings:write` scope.
The authenticated API key supplies `partnerId` and `environment`; clients
cannot override either value.

## Routes

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/bookings/hold` | Hold fixed-slot or open-time inventory |
| POST | `/api/v1/bookings/confirm` | Confirm an active hold idempotently |
| POST | `/api/v1/bookings/:bookingId/cancel` | Cancel a confirmed booking idempotently |
| GET | `/api/v1/bookings/admin/:bookingId/audit` | Read chronological Booking audit history with Admin authentication |

Confirmation and cancellation require the `Idempotency-Key` header. Repeating
the same key and normalized request returns the stored response. Reusing the
key with different content returns `IDEMPOTENCY_KEY_REUSED`.

## Hold Shapes

Fixed slot:

```json
{
  "bookingType": "FIXED_SLOT",
  "slotId": "687f00000000000000000903"
}
```

Open time:

```json
{
  "bookingType": "OPEN_TIME",
  "venueId": "687f00000000000000000904",
  "courtId": "687f00000000000000000905",
  "startsAt": "2026-08-03T04:30:00.000Z",
  "endsAt": "2026-08-03T05:30:00.000Z"
}
```

Open-time holds validate Venue environment/status, Court status and booking
mode, effective Contract mode, local operating hours, minimum duration,
increment alignment, active Pricing Rules, and interval overlap. A Court
version write acts as the transactional interval mutex.

## Confirmation Transaction

Confirmation atomically:

1. verifies the active Partner-owned hold;
2. resolves the effective Partner–Venue Contract;
3. calculates and snapshots gross, commission, tax, Venue net, and
   cancellation terms;
4. changes Slot from `HELD` to `BOOKED`;
5. creates the confirmed Booking and bounded audit entry;
6. asks Ledger to post balanced gross, commission, tax, and Venue-net entries;
7. asks Shared Communications to enqueue `BOOKING_CONFIRMED`;
8. stores the idempotency response.

No customer card or bank data is accepted or persisted.

## Cancellation Transaction

Cancellation uses only the terms snapshotted on the Booking. It calculates the
refund tier and resale cutoff, creates one BookingCancellation, changes the
Booking to `CANCELLED`, releases or retains the Slot, asks Ledger to post
balanced proportional reversals, enqueues `BOOKING_CANCELLED`, and stores the
idempotency response in one transaction.

## Hold Recovery

The application runs hold recovery every minute. Expired reusable fixed Slots
return to `AVAILABLE` with cleared hold fields and an audit entry. Expired
provisional open-time hold intervals are deleted safely. MongoDB remains the
source of truth; no Slot TTL deletion is used.
