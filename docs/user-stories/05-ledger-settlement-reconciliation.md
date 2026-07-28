# Epic 05 - Ledger And Financial Close

## US-05.01 - Post Immutable Ledger Entries

Story ID: `US-05.01`
As the: System
I want: to post immutable ledger entries for every booking and cancellation
So that: financial history is auditable and settlement-ready.

Acceptance Criteria:

- Given a booking is confirmed, when ledger posting occurs, then balanced entries are created for booking value, commission, tax, and venue net where applicable.
- Given a cancellation or refund occurs, when ledger posting occurs, then reversal or refund entries are created instead of modifying existing entries.
- Given a ledger entry exists, when an update or delete is attempted, then it is blocked.
- Given sandbox data is posted, when Ledger entries are created, then environment remains `SANDBOX` and cannot be settled with production records.

Primary Module: `ledger`
Supporting Modules: `booking`, `contracts`, `shared/db`
Data: `LedgerEntry`, `Booking`, `PartnerVenueContract`
API/UI: Internal ledger service
Priority: `P0`
Notes: Ledger is deliberately thin and append-only.

## US-05.02 - Generate Settlement Batch

Story ID: `US-05.02`
As an: Admin
I want: to generate settlement batches by partner, environment, and period
So that: partner remittances can be reconciled on agreed cycles.

Acceptance Criteria:

- Given unsettled ledger entries exist for a partner period, when batch generation runs, then a `Settlement` is created with aggregate amounts.
- Given entries are included, when settlement is generated, then each included `LedgerEntry.settlement_id` links directly to that settlement.
- Given a settlement already exists for partner, environment, and period, when generation is retried, then duplicate settlement is not created.
- Given the settlement is generated, when state is set, then it begins in `DRAFT` and advances to `PENDING_FUNDS` without skipping stages.

Primary Module: `financial-close`
Supporting Modules: `ledger`, `contracts`, `admin`
Data: `Settlement`, `LedgerEntry`, `PartnerVenueContract`
API/UI: Admin settlement console; scheduled job
Priority: `P0`
Notes: Settlement aggregates only same-environment Ledger records.

## US-05.03 - Reconcile Partner Remittance

Story ID: `US-05.03`
As an: Admin
I want: to reconcile a partner's reported remittance against GDS settlement records
So that: settlements are completed only after funds match.

Acceptance Criteria:

- Given a Settlement is awaiting reconciliation, when Admin records reported amount, bank reference, and optional evidence, then a separate `Reconciliation` record is created for that Settlement.
- Given reported amount matches the Settlement expectation, when reconciliation is recorded, then `Reconciliation.status` becomes `MATCHED` and `reconciled_by` and `reconciled_at` are saved.
- Given reported amount differs, when reconciliation is recorded, then status becomes `MISMATCH`, notes are required, and an entry is appended to `Reconciliation.attempt_history`.
- Given an authorized mismatch resolution is accepted, when evidence and notes are saved, then status becomes `RESOLVED` without deleting earlier attempts.
- Given the same non-null bank reference is submitted again for the Settlement, when persisted, then the partial unique index prevents duplicate recording.
- Given Reconciliation is `MATCHED` or `RESOLVED`, when Settlement completion is approved, then `Settlement.state` becomes `COMPLETED` without skipping required states.

Primary Module: `financial-close`
Supporting Modules: `admin`, `ledger`, `identity`
Data: `Settlement`, `Reconciliation`, `LedgerEntry`, `AdminUser`
API/UI: Admin reconciliation console
Priority: `P0`
Notes: Reconciliation is a separate collection; only its detailed attempt history is embedded.

## US-05.04 - Adjust A Completed Settlement

Story ID: `US-05.04`
As an: Admin
I want: to record an adjustment after a settlement when refunds or disputes occur
So that: corrections are handled without rewriting financial history.

Acceptance Criteria:

- Given a completed settlement needs correction, when an adjustment is approved, then new Ledger reversal or adjustment entries are posted.
- Given reversal entries are posted, when future settlement generation runs, then corrections are reflected in later cycles.
- Given a settlement correction is recorded, when Reconciliation status or attempt history changes, then original Settlement and Ledger records remain stable and immutable where required.
- Given an adjustment is performed by Admin, when saved, then actor, reason, evidence, and timestamp are appended to `Reconciliation.attempt_history`.

Primary Module: `financial-close`
Supporting Modules: `ledger`, `admin`, `booking`
Data: `Settlement`, `Reconciliation`, `Reconciliation.attempt_history`, `LedgerEntry`
API/UI: Admin settlement correction flow
Priority: `P1`
Notes: Do not update historical Ledger records.

## US-05.05 - Partner Settlement Statement

Story ID: `US-05.05`
As a: Partner
I want: to view my settlement statements and booking-level settlement details
So that: I can verify commission, tax, refunds, and net remittance.

Acceptance Criteria:

- Given a partner requests settlement history, when authenticated, then only that partner's settlements are returned.
- Given a settlement is selected, when details load, then included bookings, gross amount, commission, tax, refunds, and net amount are shown.
- Given environment is selected, when statements load, then sandbox and production remain isolated.
- Given invoice documents exist, when settlement details load, then related invoice references are returned.

Primary Module: `financial-close`
Supporting Modules: `identity`, `booking`, `ledger`
Data: `Settlement`, `LedgerEntry`, `Booking`, `Invoice`
API/UI: Developer portal settlement view; `GET /api/v1/reports/bookings`
Priority: `P1`
Notes: Customer invoices are not generated by GDS.
