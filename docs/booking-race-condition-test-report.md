# Booking Race-Condition Test Report

Date: 2026-08-03  
Scope: Partner fixed-slot/open-time booking and Venue Owner direct booking  
Result: **PASS after remediation**

## Objective

Verify that concurrent requests cannot create multiple active bookings for the
same Court interval and that booking, Slot, Ledger, idempotency, cancellation,
payment, audit, and Outbox state remain transactionally consistent.

## Initial findings

### RC-01: cross-mode race on `BOTH` Courts

Severity: High

Open-time holds acquired the Court optimistic lock and checked interval overlap,
but fixed-slot holds only conditionally updated the selected Slot. A fixed-slot
request could therefore race with, or follow, an overlapping open-time hold and
claim the still-`AVAILABLE` fixed Slot.

Affected flow:

1. Open-time request reads no active conflict.
2. Open-time request inserts a provisional `HELD` interval.
3. Fixed-slot request atomically claims its selected Slot without checking the
   provisional open-time interval.
4. Both holds could be confirmed for one Court interval.

### RC-02: direct booking check-then-insert race

Severity: High

Owner direct booking queried for overlap and then inserted a distinct Slot.
Two transactions could read the same empty snapshot and insert partially
overlapping `BOOKED` intervals because they did not contend on a shared
document. The unique exact-interval index did not protect partially overlapping
intervals.

### MongoDB test-environment issue

The configured local service accepted TCP connections but was a standalone
MongoDB process, while the application URI required `replicaSet=rs0`.
Transactions therefore could not be exercised against that service. An older
startup log also showed a legacy pricing index name whose key specification no
longer matched the requested index.

## Remediation

### Unified per-Court serialization boundary

Every booking-creation path now uses `Court.version` as the interval mutex
inside the MongoDB transaction:

```text
load Venue, Court, Contract, and requested inventory
conditional update Court where _id and version match
if no row changed: reject INVENTORY_VERSION_CONFLICT
query active overlapping inventory in the transaction snapshot
if overlap exists: reject INVENTORY_OVERLAP
claim or insert Slot
write Booking and required side effects
commit
```

MongoDB's driver retries transactions labeled as transient conflicts. No sleep,
process-local mutex, or Redis-only lock is used. This keeps MongoDB as the
durable correctness boundary across processes and application replicas.

### Fixed-slot protection

Fixed-slot hold now:

1. conditionally increments `Court.version`;
2. checks the selected interval against all other active Slots;
3. excludes the selected fixed Slot from its own overlap query;
4. atomically claims that Slot using status, hold expiry, booking ID, and
   environment predicates.

### Open-time protection

Open-time hold now locks the Court before the overlap query and provisional Slot
insert. A concurrent contender retries against a new snapshot and observes the
winner's committed interval.

### Direct-booking protection

Owner direct creation now calls `lockCourtForBooking()` before checking overlap
and inserting its Slot and Booking. Partially overlapping intervals therefore
contend even though their Slot IDs and exact interval keys differ.

## Transaction configuration

| Setting | Value |
|---|---|
| Read preference | Primary |
| Read concern | Snapshot |
| Write concern | Majority |
| Maximum commit time | 5 seconds |
| Retry mechanism | MongoDB driver's `withTransaction()` transient retry |

## Database constraints supporting the transaction logic

| Collection | Constraint |
|---|---|
| `bookings` | Unique Partner/environment/confirmation idempotency key |
| `booking_cancellations` | One cancellation per Booking |
| `api_idempotency_records` | Unique Partner/environment/key/operation |
| `booking_payments` | One direct payment record per Booking |
| `slots` | Unique Court/environment/mode/exact interval |

The Slot index prevents exact duplicates, while the Court-version transaction
mutex prevents arbitrary interval overlap.

## Test scenarios

### T-01: two confirmations for one hold

- Arrange one active fixed-slot hold.
- Submit two confirmations concurrently with different idempotency keys and
  external references.
- Expected: one fulfilled request, one rejected request, one Booking.
- Result: Pass.

### T-02: open-time versus open-time

- Submit two concurrent requests for the same open interval.
- Expected: one fulfilled request, one rejected request, one active held Slot.
- Result: Pass.

### T-03: open-time versus fixed-slot on a `BOTH` Court

- Submit concurrent open-time and fixed-slot requests for the same interval.
- Expected: one fulfilled request, one rejected request, one active held Slot.
- Result: Pass.

### T-04: direct versus direct partial overlap

- Submit `04:30-05:30` and `05:00-06:00` direct bookings concurrently.
- Exact intervals differ, deliberately bypassing the exact-interval unique
  index as the sole protection.
- Expected: one fulfilled request, one rejected request, one `BOOKED` Slot and
  one `DIRECT` Booking.
- Result: Pass.

### T-05: idempotent confirmation replay

- Repeat the same confirmation key and normalized request.
- Expected: original stored response, without a second Booking or Ledger journal.
- Result: Pass.

### T-06: concurrent cancellation/version protection

- Booking update predicates require `status=CONFIRMED` and the expected
  `version`; Slot disposal requires the Booking ID and `BOOKED` state.
- Expected: only one cancellation transition can commit.
- Result: Pass through integration lifecycle coverage.

### T-07: legacy MongoDB index migration

- Create the old `ix_pricing_court_status_priority` index with the legacy
  `status` key and insert a marker record.
- Run inventory persistence initialization.
- Expected: index replaced with the `active` key and marker data retained.
- Result: Pass.

## Verification environment

The transaction suite ran against an isolated MongoDB 8 one-node replica set on
`127.0.0.1:27018`. This avoided modifying the installed standalone Windows
service. The temporary process and workspace database were removed after the
test run.

## Commands and results

```powershell
npm.cmd run typecheck
npm.cmd exec -- tsx --test test/booking-lifecycle.persistence.integration.test.ts test/owner-booking.persistence.integration.test.ts
npm.cmd exec -- tsx --test test/booking-lifecycle.routes.test.ts test/owner-booking.service.test.ts
npm.cmd exec -- tsx --test test/inventory-index-migration.integration.test.ts
npm.cmd run build
```

| Verification | Result |
|---|---|
| TypeScript typecheck | Pass |
| Production build | Pass |
| Focused booking unit/route tests | 13 passed, 0 failed |
| Booking MongoDB transaction integration tests | 4 passed, 0 failed, 0 skipped |
| Legacy index migration test | 1 passed, 0 failed |
| `git diff --check` | Pass |

## Changed implementation areas

- `src/modules/booking/booking-lifecycle.service.ts`
- `src/modules/booking/booking-lifecycle.repository.ts`
- `src/modules/booking/owner-booking.service.ts`
- `src/modules/booking/owner-booking.repository.ts`
- `test/booking-lifecycle.persistence.integration.test.ts`
- `test/owner-booking.persistence.integration.test.ts`
- `test/owner-booking.service.test.ts`

## Residual requirements

- Production and integration environments must use a MongoDB replica set or
  MongoDB Atlas; a standalone server cannot provide these transaction guarantees.
- Every future code path that creates or blocks Court inventory must use the
  same Court-version serialization convention.
- Inventory connector writers should be reviewed whenever new external mutation
  paths are added, so they cannot bypass the shared interval mutex.
- Load and chaos testing should continue to include different processes and
  application replicas, not only concurrent promises in one process.

## Conclusion

The identified cross-mode and direct-booking races are closed by a common
MongoDB transaction protocol. All focused race cases produced exactly one
winner, and the associated persistence, migration, type, and build checks pass.
