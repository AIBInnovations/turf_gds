# Epic 06 - Financial Close Payouts And Billing

## US-06.01 - Initiate Venue Payout

Story ID: `US-06.01`
As an: Admin
I want: to initiate payout to a venue after settlement completion
So that: turf owners receive their net payable amount.

Acceptance Criteria:

- Given a settlement is not `COMPLETED`, when payout is attempted, then the system blocks the payout.
- Given venue KYC is not verified, when payout is attempted, then the system blocks the payout.
- Given payout account is not `VERIFIED`, when payout is attempted, then the system blocks the payout.
- Given all gates pass, when payout is initiated, then one idempotent `Payout` is created for the settlement and venue and eligible Ledger entries are linked to it.
- Given payout is created, when persisted, then the idempotency key prevents duplicate payout initiation.

Primary Module: `financial-close`
Supporting Modules: `ledger`, `venue`, `identity`, `admin`
Data: `Payout`, `Settlement`, `VenuePayoutAccount`, `KycVerification`, `LedgerEntry`
API/UI: Admin payout console
Priority: `P0`
Notes: Financial Close owns Settlement, Payout, and Invoice as one sequential pipeline.

## US-06.02 - Record Payout Result

Story ID: `US-06.02`
As an: Admin
I want: to record payout success or failure with bank reference
So that: payout history is traceable.

Acceptance Criteria:

- Given a manual payout is `PENDING`, when Admin records transfer success, then status moves directly to `PAID` and bank reference and paid timestamp are saved.
- Given a manual payout is `PENDING`, when Admin records failure, then status moves directly to `FAILED` and failure reason is required.
- Given payout status changes, when committed, then an owner notification event is enqueued where applicable.
- Given payout history is viewed, when loaded, then venue owners see only payouts for their venues.

Primary Module: `financial-close`
Supporting Modules: `shared/communications`, `identity`, `admin`
Data: `Payout`, `OutboxEvent`, `VenueOwner.notifications`
API/UI: Admin payout console; Owner Dashboard payout history
Priority: `P1`
Notes: `PROCESSING` is reserved for a future provider integration. Manual
results intentionally bypass it. Bank reference is unique per environment when
present.

## US-06.03 - Venue Partner Payout History

Story ID: `US-06.03`
As a: Venue Partner
I want: to view settlement and payout history for my venue
So that: I understand what was booked, deducted, and paid.

Acceptance Criteria:

- Given an owner has `VIEW_FINANCE`, when payout history is requested, then only the owner's venues are returned.
- Given a payout is listed, when details load, then amount, status, bank reference, settlement, and booking allocation are visible.
- Given an owner lacks finance permission, when requesting payout history, then access is denied.
- Given filters are applied by date or status, when list loads, then matching Payout records are returned.

Primary Module: `financial-close`
Supporting Modules: `identity`, `ledger`
Data: `Payout`, `Settlement`, `LedgerEntry`, `VenueOwnerMembership`
API/UI: Owner Dashboard finance screen
Priority: `P1`
Notes: Staff role should not receive finance access unless explicitly granted.

## US-06.04 - Generate B2B Invoice

Story ID: `US-06.04`
As an: Admin
I want: to generate B2B Partner invoices for completed settlements
So that: B2B billing documents are available for accounting.

Acceptance Criteria:

- Given a settlement is completed, when invoice generation runs, then an `Invoice` is created with invoice number, totals, currency, and `DRAFT` or `ISSUED` status.
- Given settlement is not completed, when invoice generation is attempted, then it is blocked.
- Given tax or subtotal values are invalid, when invoice is generated, then validation fails.
- Given an invoice is voided, when status changes, then the invoice record remains auditable.

Primary Module: `financial-close`
Supporting Modules: `admin`
Data: `Invoice`, `Settlement`
API/UI: Admin billing console
Priority: `P1`
Notes: Deferred from the Venue Owner Financial Close completion slice. GDS
does not generate customer invoices.

## US-06.05 - Partner Invoice Access

Story ID: `US-06.05`
As a: Partner
I want: to access my settlement-related B2B invoices
So that: I can reconcile accounting records.

Acceptance Criteria:

- Given a partner requests invoice history, when authenticated, then only invoices linked to that partner's settlements are returned.
- Given an invoice is selected, when requested, then its structured totals, tax, currency, invoice number, status, and issued timestamp are returned.
- Given sandbox environment is selected, when invoices are listed, then production invoices are excluded.

Primary Module: `financial-close`
Supporting Modules: `identity`
Data: `Invoice`, `Settlement`, `Partner`
API/UI: Developer portal invoice section
Priority: `P2`
Notes: Deferred from the Venue Owner Financial Close completion slice. File
rendering or downloadable invoice documents are out of scope until a protected
document-storage design is added.
