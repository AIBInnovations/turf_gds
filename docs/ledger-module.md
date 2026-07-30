# Ledger Module

Ledger is an internal append-only domain service. Booking and Financial Close
must use `LedgerService`; callers do not construct or mutate Ledger documents
directly.

## Capabilities

- `postBooking()` validates the Booking financial snapshot and posts a
  balanced gross, commission, tax, and Venue-net journal.
- `postCancellation()` loads the original journal, validates its Booking and
  environment scope, prevents repeated reversal, and allocates partial-refund
  rounding residuals so debit and credit totals remain equal.
- `postAdjustment()` requires actor, reason, and evidence metadata and accepts
  only a balanced adjustment journal.
- Settlement and Payout allocation methods conditionally set their reference
  once inside the caller's MongoDB transaction.
- Read methods support Booking audit, Settlement generation, cross-period
  reversal hydration, Venue payout allocation, and owner finance history.

## Immutability boundary

There is no general Ledger update or delete capability. Financial fields are
insert-only. The only mutations exposed by the repository are conditional,
one-time assignment of `settlement_id` and `payout_id`, as required by the
live ERD. Corrections are new `REVERSAL` or `ADJUSTMENT` entries.

Production database credentials must remain restricted to the application;
administrative MongoDB credentials are outside the application trust
boundary.

## Persistence

The strict validator enforces the live Eraser fields and enums. Indexes cover
Booking history, unsettled Partner/environment batches, Settlement/Venue
allocation, Payout allocation, reversal references, and correlation lookup.
