# Epic 09 - Shared Infrastructure And Cross-Cutting NFR

## US-09.01 - Environment Isolation

Story ID: `US-09.01`
As the: System
I want: sandbox and production data to remain isolated
So that: partner testing can never affect production inventory or finance.

Acceptance Criteria:

- Given a sandbox API key is used, when availability, booking, ledger, settlement, payout, invoice, or Communications data is accessed, then only sandbox records are read or written.
- Given a production API key is used, when requests are processed, then only production records are read or written.
- Given a composite relationship crosses environments, when persisted, then the database or service validation rejects it.

Primary Module: `shared/db`
Supporting Modules: `identity`, `venue`, `booking`, `ledger`, `financial-close`, `shared/communications`
Data: `PartnerApiKey`, `Slot`, `Booking`, `LedgerEntry`, `Settlement`, `Reconciliation`, `Payout`, `Invoice`, `OutboxEvent`
API/UI: All partner and finance flows
Priority: `P0`
Notes: Environment isolation is a launch-blocking safety rule.

## US-09.02 - Rate Limiting

Story ID: `US-09.02`
As the: System
I want: partner requests rate-limited by tier
So that: platform availability and p95 targets are protected.

Acceptance Criteria:

- Given a partner has a rate-limit tier, when requests are made, then limits are enforced per partner and environment.
- Given the partner exceeds limit, when additional requests arrive, then `429` is returned and usage counters are updated.
- Given admin changes rate-limit tier, when new requests arrive, then the new tier is applied.

Primary Module: `shared/redis`
Supporting Modules: `identity`, `admin`
Data: `Partner`, `ApiUsageDaily`
API/UI: Partner API middleware; Admin partner settings
Priority: `P0`
Notes: Default v1 limit is 100 requests per minute unless configured otherwise.

## US-09.03 - No Customer Payment Data

Story ID: `US-09.03`
As the: Platform
I want: to avoid storing customer card or payment gateway secrets
So that: PCI scope remains outside the GDS.

Acceptance Criteria:

- Given booking confirmation follows customer payment outside the GDS, when saved, then only the Partner's booking reference is persisted; no customer payment credentials or gateway secrets are stored.
- Given card data or raw payment secrets are submitted, when validation runs, then request is rejected or sensitive fields are ignored and logged safely.
- Given logs are inspected, when booking requests fail, then no card PAN/CVV or payment secrets appear.

Primary Module: `booking`
Supporting Modules: `identity`, `shared/db`
Data: `Booking`
API/UI: `POST /v1/bookings/confirm`
Priority: `P0`
Notes: Partner app is Merchant of Record.

## US-09.04 - Audit Retention

Story ID: `US-09.04`
As an: Admin
I want: booking and inventory transitions retained for at least 2 years
So that: disputes and compliance reviews can be supported.

Acceptance Criteria:

- Given booking state changes, when committed, then bounded `Booking.audit_history` entries are retained according to the two-year policy.
- Given fixed-slot or open-time inventory state changes, when committed, then bounded `Slot.audit_history` entries are retained according to the two-year policy.
- Given retention job runs, when records are younger than 2 years, then they are not deleted.

Primary Module: `booking`
Supporting Modules: `venue`, `admin`
Data: `Booking.audit_history`, `Slot.audit_history`
API/UI: Admin audit views
Priority: `P0`
Notes: Retention policy should be enforced operationally.

## US-09.05 - Transaction Boundaries

Story ID: `US-09.05`
As the: System
I want: multi-record business operations to commit atomically
So that: booking, ledger, inventory, and outbox state never diverge.

Acceptance Criteria:

- Given fixed-slot booking confirmation succeeds, when the transaction commits, then Booking, Slot state/audit, Ledger entries, idempotency response, and Outbox event all exist.
- Given open-time booking confirmation succeeds, when the transaction commits, then Booking, provisional Slot interval/state, embedded audit, Ledger entries, idempotency response, and Outbox event all exist.
- Given any required step fails, when the transaction rolls back, then none of the partial writes remain.
- Given cancellation succeeds, when committed, then `BookingCancellation`, Slot state/audit, Ledger reversal/refund, Booking audit, and Outbox event are consistent.

Primary Module: `shared/db`
Supporting Modules: `booking`, `venue`, `ledger`, `shared/communications`
Data: `Booking`, `BookingCancellation`, `Slot`, `LedgerEntry`, `ApiIdempotencyRecord`, `OutboxEvent`
API/UI: Internal transaction helper
Priority: `P0`
Notes: This is the core modular-monolith correctness contract.

## US-09.06 - Performance Targets

Story ID: `US-09.06`
As the: Platform
I want: availability search and booking confirmation to meet latency targets
So that: partner integrations feel reliable.

Acceptance Criteria:

- Given normal production load, when availability search is measured, then p95 latency is under 300ms.
- Given normal production load, when booking confirmation is measured excluding external payment gateway time, then p95 latency is under 1s.
- Given Redis is unavailable, when a fixed-slot hold is requested, then MongoDB can still atomically persist the Slot hold because Redis is only an accelerator.
- Given fixed-slot confirmation races, when MongoDB transactions commit, then conditional Slot status/version updates prevent double booking.
- Given open-time confirmation races, when MongoDB transactions commit, then provisional Slot intervals, optimistic versions, and transactional overlap queries prevent overlapping bookings.

Primary Module: `venue`
Supporting Modules: `booking`, `shared/redis`, `shared/db`
Data: `Court`, `Slot`, `Booking`
API/UI: Partner API
Priority: `P0`
Notes: Redis improves speed but is not the correctness source of truth.
