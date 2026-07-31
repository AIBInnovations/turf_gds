# Epic 08 - Admin Orchestration Reporting And Operations

Implementation status: complete for v1. Admin owns no collection; mutations
delegate to the owning module and cross-module reporting remains read-only.
CSV exports are synchronous and bounded. Structured Invoice reporting is
available through Financial Close; downloadable documents remain deferred.

## US-08.01 - Platform Admin Login

Story ID: `US-08.01`
As an: Admin
I want: to log in to the internal admin dashboard
So that: I can perform privileged platform operations.

Acceptance Criteria:

- Given an active platform user submits valid credentials, when login succeeds, then an admin session is established.
- Given the platform user is disabled, when login is attempted, then access is denied.
- Given admin performs a privileged action, when saved, then the platform user ID is recorded where the owning module supports approval/review metadata.

Primary Module: `identity`
Supporting Modules: `admin`, `shared/auth`
Data: `AdminUser`
API/UI: Admin login
Priority: `P0`
Notes: Identity supports distinct Platform User, Venue User, and Booking Partner authentication strategies within one module boundary.

## US-08.02 - Admin Venue And Court Management

Story ID: `US-08.02`
As an: Admin
I want: to create, edit, deactivate, or suspend venues and courts
So that: platform operations can support venue partners where needed.

Acceptance Criteria:

- Given Admin updates venue or court data, when saved, then the owning Venue module applies validation and persists changes.
- Given a venue is suspended, when Partner availability search runs, then neither fixed slots nor open-time intervals for that venue are returned.
- Given Admin deactivates a court, when availability is generated or searched, then fixed slots and open-time intervals for that court are unavailable.

Primary Module: `admin`
Supporting Modules: `venue`, `identity`
Data: `Venue`, `Court`, `Slot`
API/UI: Admin venue operations console
Priority: `P1`
Notes: Admin orchestrates through module services.

## US-08.03 - Configure Partner Venue Contract

Story ID: `US-08.03`
As an: Admin
I want: to configure commercial terms between a partner and a venue
So that: booking confirmation can calculate commission, tax, and settlement cycles.

Acceptance Criteria:

- Given a partner and venue are valid, when contract terms are saved, then `PartnerVenueContract` is created.
- Given commission or tax rate is outside allowed range, when submitted, then validation fails.
- Given commercial terms change, when saved, then a new effective-dated contract version is created and historical versions remain immutable.
- Given contract is active, when partner books the venue, then booking uses that contract.

Primary Module: `contracts`
Supporting Modules: `admin`, `identity`, `venue`
Data: `PartnerVenueContract`, `Partner`, `Venue`
API/UI: Admin contract configuration
Priority: `P0`
Notes: Contract is its own module because it belongs to the relationship.

## US-08.04 - Admin Booking And Revenue Reports

Story ID: `US-08.04`
As an: Admin
I want: filterable reports for bookings, revenue, commission, venue activity, and partner activity
So that: I can monitor business performance.

Acceptance Criteria:

- Given admin selects filters by date, venue, partner, status, or environment, when report runs, then matching aggregates are returned.
- Given report includes financial values, when calculated, then values come from booking and ledger records, not external recalculation.
- Given report is exported, when completed, then access is restricted to platform admins.

Primary Module: `admin`
Supporting Modules: `booking`, `ledger`, `financial-close`, `venue`, `identity`
Data: `Booking`, `LedgerEntry`, `Settlement`, `Payout`, `Invoice`, `Venue`, `Partner`
API/UI: Admin reporting dashboard
Priority: `P1`
Notes: Reports should not mutate domain data.

## US-08.05 - Admin Dispute View

Story ID: `US-08.05`
As an: Admin
I want: to inspect booking, inventory, ledger, settlement, webhook, and audit records together
So that: I can resolve partner or venue disputes.

Acceptance Criteria:

- Given a booking is selected, when dispute view opens, then booking status, embedded Booking/Slot audit history, Ledger entries, Settlement and Reconciliation details, and embedded webhook deliveries are visible.
- Given a mismatch is found, when admin records notes, then reconciliation or dispute notes are saved in the owning module.
- Given the dispute involves partner remittance, when escalated, then admin can navigate to reconciliation.

Primary Module: `admin`
Supporting Modules: `booking`, `venue`, `ledger`, `financial-close`, `shared/communications`
Data: `Booking.audit_history`, `Slot.audit_history`, `LedgerEntry`, `Settlement`, `Reconciliation`, `OutboxEvent.webhook_deliveries`
API/UI: Admin dispute console
Priority: `P1`
Notes: Admin joins across modules for read/reporting purposes.

## US-08.06 - Monitor Sync And Inventory Health

Story ID: `US-08.06`
As an: Admin
I want: to monitor venue inventory health
So that: stale or broken availability can be detected.

Acceptance Criteria:

- Given Admin opens inventory health, when data loads, then venue and court status, fixed-slot generation freshness, active open-time court blocks, and unavailable counts are visible.
- Given slot generation fails, when detected, then the failure is visible in operations monitoring.
- Given `VenueIntegration` is absent in v1, when sync health is displayed, then health is derived from Owner Dashboard writes and slot generation jobs.

Primary Module: `admin`
Supporting Modules: `venue`, `shared/communications`, `shared/observability`
Data: `Venue`, `Court`, `Slot`, `Slot.audit_history`
API/UI: Admin inventory health console
Priority: `P2`
Notes: SRS wording says sync health; v1 implementation means Owner Dashboard write health.
