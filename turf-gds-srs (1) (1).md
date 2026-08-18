# Software Requirements Specification
## Turf Booking GDS (Global Distribution System)

Version 0.4 — Draft (supersedes v0.3; adds explicit user roles — Admin, Venue Partner, 3rd Party Booking App — and their features, and establishes the Owner Dashboard as the sole venue-side interface for v1)

---

## 1. Introduction

### 1.1 Purpose
This document specifies requirements for a Turf Booking GDS: a backend platform, modeled on the travel-industry GDS pattern (Amadeus/Sabre), that centralizes real-time inventory *from* turf venues and redistributes it *to* third-party partner applications via API. Venues do not run their own booking software; all venue-side inventory management happens through the platform's own **Owner Dashboard**, a first-party web application built and operated by the GDS. The system's partner-facing surface remains API-only — partner apps have no GDS-provided UI of their own.

### 1.2 Scope
In scope:
- Owner Dashboard: a first-party web application through which Venue Partners manage venue/court listings, pricing, availability, and view bookings and payouts
- Centralized, normalized inventory (venues, courts, slots, pricing), written exclusively through the Owner Dashboard in v1
- Real-time availability search API for 3rd Party Booking Apps
- Booking lifecycle: hold, confirm, cancel, refund
- Three distinct user-facing surfaces: Admin (internal dashboard), Venue Partner (Owner Dashboard), 3rd Party Booking App (Partner API)
- Settlement management, payout calculation, reconciliation, and B2B billing (the GDS is not the consumer payment processor)
- Partner developer portal (API keys, sandbox, webhook config, usage reporting)
- Admin tooling for venue onboarding, partner approval, and dispute resolution

Out of scope (v1):
- Externally-hosted venue booking software integration (webhook/API push from a venue's own system) — deferred until a venue with its own system needs to be supported; all v1 venues use the Owner Dashboard exclusively
- Consumer-facing booking UI (only 3rd Party Booking Apps face end customers)
- Dynamic/yield-based pricing
- Multi-currency support

### 1.3 Definitions
| Term | Meaning |
|---|---|
| GDS | This platform — the central inventory aggregation + booking API layer |
| Venue | A physical location with one or more courts, managed on the platform by a Venue Partner |
| Venue Partner | The venue owner/operator user — manages their venue(s) exclusively through the Owner Dashboard |
| 3rd Party Booking App (Partner) | An external application/company consuming the GDS API to sell bookings to its own end customers |
| Admin | Internal platform staff — onboards venues and partners, resolves disputes, monitors system health |
| Owner Dashboard | The first-party web application Venue Partners use; the only venue-side interface in v1 |
| Slot | A bookable time unit for a specific court on a specific date |
| Hold | A short-lived reservation of a slot pending payment confirmation |
| Sync | The process by which a Venue Partner's changes in the Owner Dashboard are written into GDS inventory |

### 1.4 References
- Architecture diagrams: partner-facing service architecture, inbound venue-sync flow, partner journey, venue owner journey (produced during design discussion)

---

## 2. Overall Description

### 2.1 Product perspective
The GDS sits between two independent populations that never interact with it the same way:
- **Venue Partners** manage inventory *in*, through the Owner Dashboard (supply side)
- **3rd Party Booking Apps** pull availability *out* and write bookings back *in*, through the API (demand side)

Both sides converge on one normalized inventory store, so a slot booked by a 3rd Party Booking App and a slot blocked by a Venue Partner directly (e.g., a walk-in marked unavailable in the Owner Dashboard) are indistinguishable in effect — both simply change `Slot.status`.

### 2.2 User classes and characteristics

| Class | Touches system via | Primary need |
|---|---|---|
| Venue Partner | Owner Dashboard (first-party web app; the only venue-side interface — no venue runs its own booking software) | List venues/courts accurately, keep availability current, get paid correctly and on time |
| 3rd Party Booking App (Partner) | REST API + developer portal | Search, book, cancel on behalf of its own end customers |
| End customer | Never directly — only via a 3rd Party Booking App's own UI | Not a direct actor in this system |
| Admin | Internal admin dashboard | Onboard Venue Partners and Partners, resolve disputes, monitor sync/settlement health |

### 2.3 Features by user role

**Admin**
- Onboard and approve Venue Partners (KYC, payout account verification) and 3rd Party Booking Apps (application review, sandbox → production go-live)
- Create/edit venues, courts, pricing rules, and cancellation policies on a Venue Partner's behalf where needed
- Configure `PartnerVenueContract` terms: commission rate, tax rate, settlement cycle per partner-venue relationship
- Monitor venue sync health, partner API usage, and webhook delivery health
- Reconciliation and dispute-resolution console: compare a partner's claimed booking/settlement state against GDS records
- Run and review settlement batches, approve payouts, issue B2B invoices
- Full reporting: bookings, revenue, commission, venue and partner activity, filterable by date/venue/partner

**Venue Partner** (via the Owner Dashboard — their only interface)
- Onboarding: register venue(s), submit KYC and payout account details
- List and edit courts, operating hours, and pricing rules (day-of-week/time-based)
- Set a venue-specific cancellation policy, or use the platform default
- View real-time availability calendar and manually block/release slots (maintenance, walk-ins, private events) — this *is* the venue-sync mechanism in v1, replacing any external push/pull integration
- View incoming bookings (read-only — bookings are created only by 3rd Party Booking Apps) with partner and customer reference details
- View settlement and payout history: what was booked, what commission/tax was deducted, what was paid out and when
- Receive notifications on new bookings, cancellations, and completed payouts

**3rd Party Booking App (Partner)**
- Apply for access; receive sandbox API keys immediately, production keys after a go-live review
- Developer portal: manage API keys (sandbox and production, held simultaneously), configure webhook endpoint(s), read API docs
- Search venue/court availability by location, sport, date, and time (`GET /v1/venues/search`, `GET /v1/venues/{id}/availability`)
- Hold a slot, confirm a booking (idempotent), and cancel a booking (`POST /v1/bookings/hold|confirm|{id}/cancel`)
- Receive webhook events: `booking.confirmed`, `booking.cancelled`, `booking.refunded`
- View own booking volume, commission owed, and settlement/invoice history (`GET /v1/reports/bookings`)
- Operate independently in sandbox (simulated payments, seeded data) without affecting production inventory

### 2.4 Assumptions and constraints
- Single currency (INR) for v1
- **No Venue Partner currently operates their own booking software.** All venue-side inventory management happens exclusively through the platform's Owner Dashboard in v1; external webhook/API-push integration for venues with their own systems is deferred to a future version, not built now
- 3rd Party Booking Apps are trusted contractually but not infallible — API must defend against retries, timeouts, and malformed input (idempotency, validation)
- PCI scope is out of the GDS entirely: the Partner application is Merchant of Record and collects customer payment through its own gateway; the GDS never touches card data

---

## 3. System Architecture

### 3.1 Layered overview
1. **Venue Partner layer — Owner Dashboard** — a first-party web application through which Venue Partners manage venues, courts, pricing, and availability directly. This *is* the inventory-write path in v1 — there is no external venue system to ingest from. The dashboard writes through the same internal service as any future external sync would, so adding webhook/API-push support for a venue with its own software later is additive, not a redesign.
2. **Core services** — Inventory (venues/courts/slots/pricing), Booking engine (hold/confirm/cancel, concurrency control), Admin/ops.
3. **Auth (two separate domains)**:
   - *Venue Partner auth* — dashboard login (session-based), scoped to the venues that Venue Partner is a member of via `VenueOwnerMembership`.
   - *Partner auth* — API key + HMAC-signed requests, scoped to read (search) and write (booking) across the venues a 3rd Party Booking App is contracted for.
4. **Settlement & billing** (not a consumer payment processor) — the GDS does not collect customer payment; the Partner application is Merchant of Record and collects payment through its own gateway. The GDS instead orchestrates booking confirmation, records an immutable ledger of booking value/commission/tax, runs periodic (T+N) settlement and reconciliation against partner-reported payment references, calculates net payouts to venue owners, and generates B2B billing documents. This is split into independent bounded domains: **Ledger Service**, **Settlement Service**, **Billing Service**, **Payout Service**, and **Reconciliation Service**, alongside the **Booking Service** that orchestrates confirmation itself.
5. **Partner API gateway** — authentication, rate limiting (per-partner tier), request validation, versioning (`/v1/`).
6. **Developer portal** — partner self-service: key management, sandbox/production mode toggle, webhook URL configuration, usage/settlement reporting.

### 3.2 Data stores
- **PostgreSQL** — source of truth: venues, courts, slots, bookings, transactions, partners, venue integrations. ACID guarantees back the booking concurrency model.
- **Redis** — short-lived slot holds (`SET key val NX EX <ttl>`), search-result caching, rate-limit counters.
- **MongoDB** — audit/event logs, flexible venue metadata (photos, amenities, free-text descriptions).

### 3.3 Concurrency model
Two-phase hold/confirm:
- **Hold** (`POST /v1/bookings/hold`) acquires an atomic Redis lock (`NX`, TTL ~8 min) on `court_id:date:time_slot`. Fails fast (409) with no DB hit if already held.
- **Confirm** (`POST /v1/bookings/confirm`) writes the durable `Booking` row in Postgres inside a transaction, protected by a **unique constraint** on `(court_id, date, time_slot)` — this is the real correctness guarantee; Redis is the fast pre-check, not the source of truth.
- Expired holds self-clean via Redis TTL; no orphaned "pending" rows.
- All confirm/cancel writes require an `Idempotency-Key` header to tolerate partner retries.

---

## 4. Functional Requirements

### 4.1 Venue Partner — Owner Dashboard
- FR-1: Venue Partner can register a venue and submit KYC and payout account details for Admin approval
- FR-2: Venue Partner can create/edit courts, operating hours, and pricing rules for their own venue(s) only (enforced via `VenueOwnerMembership`)
- FR-3: Venue Partner can view a real-time availability calendar and manually mark slots blocked/available; this write path is the sole source of venue-driven inventory change in v1
- FR-4: On conflicting state (Venue Partner blocks a slot that has an active Partner hold/booking), the Venue Partner's action takes precedence; the affected 3rd Party Booking App is notified via webhook
- FR-5: The system tracks each venue's integration record (`integration_type = OWNER_DASHBOARD` for all v1 venues) so a future venue with its own booking software can be onboarded via webhook/API-push without a schema change

### 4.2 Inventory management
- FR-5: Admin can create/edit/deactivate venues, courts, and pricing rules
- FR-6: System auto-generates rolling slot inventory from recurring operating-hour and pricing rules
- FR-7: Admin/venue owner can manually block slots (maintenance, private events)

### 4.3 Availability search (partner-facing)
- FR-8: `GET /v1/venues/search` — filter by location, sport type, date, time range
- FR-9: `GET /v1/venues/{id}/availability?date=` — open slots with pricing, reflecting real-time state (no stale held/booked slots shown as open)

### 4.4 Booking lifecycle (partner-facing)
- FR-10: `POST /v1/bookings/hold` — atomic short-lived lock, returns `hold_id` and expiry
- FR-11: `POST /v1/bookings/confirm` — idempotent confirmation after payment; enforces DB-level uniqueness per slot
- FR-12: `POST /v1/bookings/{id}/cancel` — cancels per the venue's cancellation policy, triggers refund calculation
- FR-13: Expired unconfirmed holds automatically release back to inventory

### 4.5 Partner management
- FR-14: Admin can approve a partner application and issue sandbox API keys
- FR-15: Partner can self-serve in sandbox: test bookings (simulated payment), configure webhook URL, read API docs
- FR-16: Admin performs a go-live review (idempotency handling, webhook reachability check) before issuing production keys
- FR-17: Each partner has a configurable rate-limit tier
- FR-18: System delivers webhook events (`booking.confirmed`, `booking.cancelled`, `booking.refunded`) with retry-with-backoff on delivery failure
- FR-19: Partner can view booking volume, commission owed, and settlement statements via the developer portal

### 4.6 Payments, Settlement & Billing

**Commercial model.** The GDS operates as a B2B inventory distributor. Customer payments are normally collected by the Partner application (Merchant of Record). The GDS is responsible for booking orchestration, settlement management, payout calculation, reconciliation, and B2B billing, but is **not** the consumer payment processor.

- FR-20: Customer payments are collected by the Partner application through its own payment gateway, unless otherwise agreed commercially.
- FR-21: After successful payment, the Partner invokes the Booking Confirm API. Booking confirmation is independent of settlement.
- FR-22: The GDS records booking value, partner, venue, commission, taxes, and settlement status in an immutable ledger.
- FR-23: The GDS calculates partner settlements on the agreed T+N cycle (T+1, T+2, weekly, monthly, etc.).
- FR-24: Settlement processing includes reconciliation using settlement amount, bank reference/UTR, and booking records before marking a settlement as completed.
- FR-25: After successful reconciliation, the GDS calculates the net payable amount to each Turf Owner after deducting agreed commissions and applicable taxes.
- FR-26: The GDS initiates payouts to Turf Owners and records payout status and bank reference.
- FR-27: Refunds and settlement reversals follow the venue cancellation policy and are reflected in future settlement cycles when required.

**Settlement documents:**
- **Settlement Report** — generated by the GDS for every settlement cycle, listing bookings, gross amount, commission, taxes, adjustments, refunds, and net payable.
- **Tax Invoice** — generated only where required by the commercial agreement and applicable tax regulations (e.g. platform commission/service fee invoices).
- **Customer Invoice** — generated by the Partner application, since it collects payment from the customer.

**Payment lifecycle:**
`Customer → Partner Payment Gateway → Booking Confirm API → Booking Confirmed → Settlement Pending → T+N Reconciliation → Settlement Completed → Turf Owner Payout Completed`

**Core services** (independent bounded domains): Booking Service, Ledger Service, Settlement Service, Billing Service, Payout Service, and Reconciliation Service.

### 4.7 Admin, monitoring, and disputes
- FR-28: Admin dashboard shows bookings, revenue, partner and venue activity, filterable by date/venue/partner
- FR-29: Admin has a reconciliation view to compare a partner's claimed booking state against GDS records for dispute resolution
- FR-30: Admin can view venue sync health (last successful sync, failures) per venue

---

## 5. External Interface Requirements

### 5.1 Partner API (v1) — summary
| Endpoint | Purpose |
|---|---|
| `GET /v1/venues/search` | Discover venues/courts by location, sport, date |
| `GET /v1/venues/{id}/availability` | Slot-level availability and pricing |
| `POST /v1/bookings/hold` | Lock a slot |
| `POST /v1/bookings/confirm` | Confirm after payment (idempotent) |
| `POST /v1/bookings/{id}/cancel` | Cancel, trigger refund |
| `GET /v1/reports/bookings` | Partner's own booking/settlement history |

### 5.2 Owner Dashboard (Venue Partner-facing)
Not a public API — a first-party web application. Internally, dashboard actions (create/edit court, update pricing, block/release a slot) call the same internal inventory service that a future external venue-sync integration would call, so the write path doesn't need to change shape later, only gain an additional authenticated entry point.

### 5.3 Auth schemes
- **3rd Party Booking App (Partner)**: API key (header) + HMAC request signature; separate sandbox and production key pairs held simultaneously.
- **Venue Partner**: Owner Dashboard session login, scoped to the venue(s) they're a member of (`VenueOwnerMembership`).
- **(Future) External venue system**: scoped, write-only API key, for a venue that brings its own booking software — not built in v1.

### 5.4 Webhooks (delivered to partners)
`booking.confirmed`, `booking.cancelled`, `booking.refunded`, `slot.unavailable` (venue-initiated conflict).

---

## 6. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | No double-booking under concurrent requests — enforced at the DB level regardless of Redis availability |
| NFR-2 | Availability search responds in < 300ms p95 |
| NFR-3 | Booking confirmation responds in < 1s p95 (excluding gateway round-trip) |
| NFR-4 | Per-partner rate limiting, default 100 req/min, configurable per tier |
| NFR-5 | All 3rd Party Booking App requests authenticated via API key + HMAC; all Owner Dashboard requests authenticated via session login scoped to venue membership |
| NFR-6 | Audit log of every booking and inventory state transition, retained 2 years |
| NFR-7 | 99.5% uptime target for partner-facing API |
| NFR-8 | No customer card/payment data ever reaches or is persisted on GDS servers — the Partner application, as Merchant of Record, owns the customer payment gateway entirely |
| NFR-10 | The ledger is append-only/immutable — settlement and reconciliation are corrections via new entries, never edits to past ledger rows |
| NFR-9 | Graceful degradation if Redis is unavailable: hold pre-checks stop, but the Postgres unique constraint still prevents double-booking |

---

## 7. Data Model (core entities)

- **Venue** — id, name, address, geo, status
- **VenueOwnerMembership** — owner_id, venue_id, role (owner/manager/staff) — links a Venue Partner to the venue(s) they manage
- **VenuePayoutAccount** — id, venue_id, account_holder_name, bank_account_token, status
- **Court** — id, venue_id, sport_type, name
- **PricingRule** — id, court_id, day_of_week, start_time, end_time, price
- **CancellationPolicy** — id, venue_id (or global default), refund tiers by time-to-slot
- **Slot** — id, court_id, date, start_time, end_time, status (open/held/booked/blocked)
- **VenueIntegration** — id, venue_id, integration_type (`owner_dashboard` for all v1 venues; `webhook`/`api_pull` reserved for future venues with their own systems), last_synced_at
- **Booking** — id, slot_id, partner_id, customer_ref, status, amount, created_at
- **Partner** — id, name, api_key_hash, mode (sandbox/production), webhook_url, rate_limit_tier, status
- **LedgerEntry** — id, booking_id, partner_id, venue_id, gross_amount, commission_amount, tax_amount, status (append-only, immutable)
- **Settlement** — id, partner_id, period_start, period_end, cycle (T+N), gross_amount, net_amount, bank_reference, status (pending/reconciled/completed)
- **Payout** — id, venue_id, settlement_id, amount, status, bank_reference, paid_at
- **Invoice** — id, settlement_id, type (tax_invoice), amount, issued_at
- **WebhookDeliveryLog** — id, partner_id, event_type, payload, status, retry_count

(DDL with keys, indexes, and constraints to follow as a separate artifact once the schema is confirmed.)

---

## 8. User Flows (summary)

### 8.1 3rd Party Booking App journey
Apply & get approved → Sandbox integration (test keys, simulated payments) → Go-live review → Production access → Runtime loop (search → hold → confirm/cancel) → Settlement & reporting.

### 8.2 Venue Partner journey
Register & submit KYC/payout details → List courts & pricing on the Owner Dashboard → Ongoing availability management (block/release slots directly in the dashboard — the sole sync mechanism in v1) → View incoming bookings, settlements, and payouts.

### 8.3 Admin journey
Approve Venue Partner and 3rd Party Booking App applications → Configure `PartnerVenueContract` terms per relationship → Monitor sync/settlement health → Run settlement and payout cycles → Resolve disputes via the reconciliation console.

---

## 9. Open Questions
- Cancellation policy: platform-wide default vs. per-venue configurable
- Payout schedule: daily, weekly, or on-demand
- Multi-sport support in v1, or single sport type to start
- Whether the Owner Dashboard needs a mobile-friendly view for v1, given Venue Partners will use it as their only tool
