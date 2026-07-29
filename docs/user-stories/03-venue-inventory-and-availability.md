# Epic 03 - Venue Inventory And Availability

## US-03.01 - Manage Venue Profile

Story ID: `US-03.01`
As a: Venue Partner
I want: to edit my venue profile
So that: partners can discover accurate venue information.

Acceptance Criteria:

- Given an owner has `MANAGE_VENUE` permission for a venue, when profile changes are submitted, then venue fields are updated and version increments.
- Given an owner lacks permission, when the request is made, then the system denies the update.
- Given currency is submitted, when it is not `INR`, then the request is rejected.
- Given media is attached, when saved, then Shared Media uploads the bytes and Venue embeds the returned metadata in `Venue.media`.

Primary Module: `venue`
Supporting Modules: `identity`, `shared/media`, `shared/db`
Data: `Venue`, `VenueOwnerMembership`, `VenueRolePermission`
API/UI: Owner Dashboard venue settings
Priority: `P0`
Notes: Only media metadata is embedded; image/video binaries remain in object storage.

## US-03.02 - Manage Courts

Story ID: `US-03.02`
As a: Venue Partner
I want: to create and edit courts for my venue
So that: each bookable playing area is represented correctly.

Acceptance Criteria:

- Given an owner has `MANAGE_COURTS`, when a court is created, then it is linked to the correct venue.
- Given a court name already exists under the same venue, when creation is attempted, then the system rejects the duplicate.
- Given court status is set to `INACTIVE`, when availability is generated or searched, then no fixed slots or open-time intervals for the court are returned.
- Given court booking mode is `FIXED_SLOT`, `OPEN_TIME`, or `BOTH`, when saved, then only requests allowed by that mode and the active contract are accepted.
- Given court media is attached, when saved, then Shared Media uploads the bytes and Venue embeds the returned metadata in `Court.media`.

Primary Module: `venue`
Supporting Modules: `identity`, `shared/media`
Data: `Court`, `Slot`
API/UI: Owner Dashboard court management
Priority: `P0`
Notes: `BOOKED` is not a court status. Fixed and provisional open-time inventory state is represented by Slot intervals.

## US-03.03 - Configure Court Operating Hours

Story ID: `US-03.03`
As a: Venue Partner
I want: to configure operating hours per court
So that: fixed-slot generation and open-time availability match real court hours.

Acceptance Criteria:

- Given an owner has `MANAGE_AVAILABILITY`, when operating hours are saved, then the court's `operating_hours` configuration is updated.
- Given `opens_at` is not before `closes_at`, when submitted, then the request is rejected.
- Given `day_of_week` is outside 1 to 7, when submitted, then the request is rejected.
- Given operating hours change, when saved, then subsequent fixed-slot generation and open-time searches use the updated configuration.

Primary Module: `venue`
Supporting Modules: `identity`
Data: `Court`, `Slot`
API/UI: Owner Dashboard operating hours screen
Priority: `P0`
Notes: Operating hours are court-level in the production schema.

## US-03.04 - Configure Pricing Rules

Story ID: `US-03.04`
As a: Venue Partner
I want: to define day-of-week and time-based pricing rules
So that: partner availability responses include accurate prices.

Acceptance Criteria:

- Given an owner has `MANAGE_PRICING`, when pricing is saved, then `PricingRule` records are persisted for the court.
- Given price is negative or currency is not `INR`, when submitted, then validation fails.
- Given overlapping rules exist, when availability is priced, then the highest priority active rule wins.
- Given a pricing rule is deactivated, when future slots are generated, then the inactive rule is ignored.

Primary Module: `venue`
Supporting Modules: `identity`
Data: `PricingRule`, `Slot`
API/UI: Owner Dashboard pricing screen
Priority: `P0`
Notes: Dynamic/yield pricing is out of scope for v1.

## US-03.05 - Configure Partner-Venue Cancellation Terms

Story ID: `US-03.05`
As an: Admin
I want: to configure cancellation terms for a Partner–venue contract
So that: each commercial relationship applies the correct refund and inventory-release rules.

Acceptance Criteria:

- Given a valid Partner and venue relationship, when cancellation terms are saved, then a new effective-dated `PartnerVenueContract` version is created.
- Given no active Partner–venue contract exists, when booking confirmation occurs, then confirmation is rejected.
- Given tier refund percent is outside 0 to 100, when submitted, then validation fails.
- Given resale cutoff is configured, when a fixed-slot or open-time booking is cancelled, then inventory release follows the snapshotted terms.

Primary Module: `contracts`
Supporting Modules: `admin`, `booking`
Data: `PartnerVenueContract`, `Booking`
API/UI: Admin contract configuration
Priority: `P1`
Notes: Cancellation terms belong to Contracts and are snapshotted into Booking at confirmation.

## US-03.06 - Generate Rolling Slot Inventory

Story ID: `US-03.06`
As the: System
I want: to generate rolling slots from court hours and pricing
So that: partners can search bookable inventory in advance.

Acceptance Criteria:

- Given active operating hours and pricing rules exist, when the slot generation job runs, then future `Slot` records are materialized.
- Given a slot already exists for the same court and time range, when generation runs again, then duplicate slots are not created.
- Given court or venue is unavailable, when generation runs, then open slots are not generated for unavailable periods.
- Given generated slots are created, when persisted, then the job's authenticated environment context is preserved and cannot affect another environment.

Primary Module: `venue`
Supporting Modules: `shared/db`
Data: `Slot`, `PricingRule`, `Court`, `Venue`
API/UI: Scheduled job
Priority: `P0`
Notes: This job applies to `FIXED_SLOT` and fixed-slot inventory on `BOTH` courts. Hold fields persist on Slot; Redis may mirror them.

## US-03.07 - Search Availability

Story ID: `US-03.07`
As a: Partner
I want: to search availability by location, sport, date, and time
So that: I can show bookable slots to my customers.

Acceptance Criteria:

- Given a valid Partner request for a `FIXED_SLOT` or `BOTH` court, when fixed-slot availability is searched, then only active Slots that are not `HELD`, `BOOKED`, `BLOCKED`, or `UNAVAILABLE` are returned.
- Given a valid Partner request for an `OPEN_TIME` or `BOTH` court, when open-time availability is searched, then operating hours minus active `HELD`, `BOOKED`, `BLOCKED`, and `UNAVAILABLE` Slot intervals are returned.
- Given an open-time interval is shorter than 60 minutes, violates booking increments, or overlaps an unavailable interval, when results are generated, then it is not returned.
- Given pricing applies to a fixed slot or open-time interval, when availability is returned, then price, currency, booking mode, start, and end are included.
- Given a valid Partner request, when searching venues, then only active data for the authenticated request environment is returned.
- Given response time is measured, when normal load is present, then p95 target is under 300ms.

Primary Module: `venue`
Supporting Modules: `identity`, `contracts`, `shared/redis`
Data: `Venue`, `Court`, `Slot`, `Booking`, `PricingRule`
API/UI: `GET /api/v1/venues/search`, `GET /api/v1/venues/{id}/availability`
Priority: `P0`
Notes: Partner contracts may restrict which venues a partner can book.

## US-03.08 - Manually Block Or Release Availability

Story ID: `US-03.08`
As a: Venue Partner
I want: to block or release fixed-slot or open-time availability from the Owner Dashboard
So that: walk-ins, maintenance, and private events are reflected immediately.

Acceptance Criteria:

- Given an owner has `MANAGE_AVAILABILITY` for a fixed-slot court, when a slot is blocked, then `Slot.status` changes to `BLOCKED`.
- Given an owner has `MANAGE_AVAILABILITY` for an open-time or `BOTH` court, when an interval is blocked, then a Slot interval with `BLOCKED` status is created.
- Given availability changes, when committed, then the bounded `Slot.audit_history` captures actor, previous state, new state, reason, and correlation ID.
- Given a block conflicts with a durable hold or confirmed booking, when submitted, then the change is rejected unless an authorized exception workflow cancels the booking first.
- Given an owner releases a block, when no confirmed booking occupies the inventory, then the reusable fixed slot becomes `AVAILABLE` or the provisional blocked interval is removed according to retention rules.

Primary Module: `venue`
Supporting Modules: `identity`, `booking`, `shared/communications`
Data: `Slot`, `Booking`, `OutboxEvent`
API/UI: Owner Dashboard availability calendar
Priority: `P0`
Notes: This is the v1 venue-sync mechanism.

## US-03.09 - Manage Flexible Venue Content

Status: `SUPERSEDED_BY_AUTHORITATIVE_ERD`

The live Eraser workspace does not define a `VenueContent` collection.
Accordingly, this historical story cannot be implemented as written without
violating the source-of-truth rule. The former routes and persistence model
were removed on 2026-07-29. Venue and Court media remain embedded in their
owning aggregates. Any replacement for flexible descriptive content requires
an approved ERD change before implementation.

Story ID: `US-03.09`
As a: Venue Partner
I want: to manage flexible descriptive content for my venue
So that: Booking Partners receive current venue information without changing the core Venue schema for every content field.

Acceptance Criteria:

- Given an owner has `MANAGE_VENUE`, when content is saved, then the owning venue's single `VenueContent` record is created or versioned.
- Given content includes supported media, when bytes are uploaded, then Shared Media returns metadata that is embedded in the owning content or Venue aggregate.
- Given content changes, when persisted, then `updated_by_type`, `updated_by_id`, and version are recorded.
- Given a second content record is created for the same venue, when persisted, then the unique venue index prevents duplication.

Primary Module: `venue`
Supporting Modules: `identity`, `shared/media`, `shared/db`
Data: `VenueContent`, `Venue`
API/UI: Owner Dashboard venue content editor
Priority: `P1`
Notes: VenueContent is the flexible one-to-one venue content aggregate defined by ERD v0.9.
