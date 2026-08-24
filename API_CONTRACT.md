# Turf GDS API — verified contract

Everything here was read out of `turf_gds/src` route registrations, not just the docs. Where the
docs disagree with the code, the code is recorded and the doc error is noted. Base URL
`https://turf-gds.onrender.com/api/v1` — the one origin every app talks to.

Authoritative machine-readable spec: `GET /api/v1/openapi.json` (add `?partner=true` for the
partner-only surface — use it to generate the developer console's reference pages).

## Corrections found by running the API

These were discovered by driving the live backend (`scripts/seed.mjs` performs the whole flow) and by
diffing a client implementation against `src/`. They override anything below and everything in `docs/`.

**Pagination has five different shapes.** There is no single envelope — check per endpoint:

| Shape | Used by |
|---|---|
| `{items, page, limit, total}` | admin venues/partners/disputes/reports/inventory-health |
| `{items, pagination:{…totalPages}}` | financial-close, owner finance, communications, notifications |
| `{items, pagination:{…pages}}` | **owner bookings only** — spelled `pages`, not `totalPages` |
| `{items, nextCursor}` | partner bookings/settlements/invoices/usage |
| `{items, nextCursor, truncated}` | `/venues/search`, `/availability` |
| bare array | owner courts, pricing rules, inventory, payout accounts, members, contract templates, webhooks, connectors |

**Availability returns `availabilityId`, not `slotId`.** That value is what `POST /bookings/hold` expects
as its `slotId`. Only bookable intervals come back, so there is no status field to filter on. The
availability window is capped at **24 hours** — deriving the two ends from separate `Date.now()` calls
pushes it over by milliseconds and 400s with `AVAILABILITY_RANGE_TOO_LARGE`.

**HMAC signing details the docs omit:** the signed path is Fastify's `request.url`, so it includes the
**`/api/v1` prefix and the full query string** exactly as sent (encoding must match byte for byte). The
backend also has **replay protection** keyed on `timestamp:requestId:signature` → 409
`PARTNER_REQUEST_REPLAYED`, so every request needs a fresh `X-Request-Id`.

**Environment isolation is absolute.** Owner self-registration creates venues in `PRODUCTION`, so a
`SANDBOX` key sees nothing and returns 404 `VENUE_NOT_FOUND`. Sandbox demos need sandbox-environment venues.

**A contract requires an ACTIVE partner**, and a partner only becomes ACTIVE after production approval,
which itself requires verified BUSINESS KYC. Full order: apply → approve-sandbox → KYC verified →
integration-review PASSED → approve-production → contract → bookings.

**Not every aggregate has a `version`.** Pricing rules have none at all (last-write-wins; sending one is
a 400). Settlements, payouts and invoices are status-guarded rather than versioned.

**Owner and admin presenters differ for the same entity.** Owner venue/court use `id` and flat
`latitude`/`longitude`; admin uses `venueId`/`courtId`, raw GeoJSON `geo`, and snake_case
`address.postal_code`. `/admin/partners` and `/admin/disputes` return **raw Mongo documents**
(snake_case, `_id`), and `integrationReviewStatus` is not a column — derive it from `audit_history`.

**Other field-name traps:** owner payout accounts use `vaultProvider`/`vaultAccountToken` while partner
ones use `label`/`accountVaultToken`. `customerPhone` on a direct booking is stored into
`partnerPaymentReference` and never returned. Notifications have **no `id`** — identity is the
`(notificationType, aggregateType, aggregateId)` composite. Key issuance returns **five** fields
(`keyId, apiKey, signingSecret, environment, scopes`). The webhook event catalog has **20** entries, not 7.

## Error envelope

Every failure, without exception:

```json
{ "error": { "code": "SOME_CODE", "message": "…", "requestId": "…", "details": [] } }
```

`VALIDATION_ERROR` carries the raw AJV array in `details`. Branch on `code`, never on `message`.

## Optimistic concurrency — applies to all four apps

Mongo has no row locks here, so every mutable aggregate (venue, court, slot, booking, payout
account, pricing rule) carries a `version`. Mutations must send the version they read, either in
the body or as `?version=N`. A stale version fails the write. **Every edit form needs a
refetch-and-retry path**; silently re-submitting will clobber a concurrent change.

---

## Auth — four distinct schemes

### 1. Admin — HS256 JWT

- `POST /auth/admin/login` `{email, password}` → `{accessToken, expiresAt, admin:{id,email,displayName,role}}`
- `POST /auth/admin/otp/verify` `{phoneE164, accessToken}` → same shape as `/auth/admin/login`.
  MSG91 phone+OTP sign-in. `accessToken` is the MSG91 widget token, re-verified server-side against
  MSG91 before any JWT is issued. 404 `PHONE_NOT_REGISTERED` when no admin holds that number,
  401 `PHONE_TOKEN_MISMATCH` when the token was verified for a different number.
- `POST /auth/admin/me/phone` `{phoneE164, accessToken}` → 204. Authenticated self-enrolment: links a
  verified phone to the calling admin so OTP sign-in works for them. 409 `PHONE_ALREADY_REGISTERED`.
  Admin accounts are made by CLI bootstrap or by another admin, so this is the only way to set one.
  Password sign-in stays available — admins predating this have no phone on file.
- Header `Authorization: Bearer <accessToken>`
- TTL from `ADMIN_ACCESS_TOKEN_TTL_MINUTES` (set to 480 locally). **No refresh endpoint** — on 401, re-login.
- `GET /auth/admin/me` → `{id, role}`
- `POST /auth/admin/logout` → 204. May return 503 `ADMIN_LOGOUT_UNAVAILABLE`; treat as a soft success and clear locally.
- Roles: `ADMIN` | `OPS` | `SUPPORT`. Nearly every mutation is `ADMIN`-only → 403 `ADMIN_ROLE_REQUIRED`.
  - `ADMIN` or `OPS`: KYC preliminary review, communications retry.
  - Any role: reads, `/admin/operations/health`, booking audit.
- The admin row is reloaded on every request, so disabling a user takes effect before token expiry.

### 2. Venue owner — opaque session token (phone+OTP sign-in, NOT a JWT)

- `POST /auth/venue-owners/register` → `{ownerId, venueId}` (creates owner + venue + OWNER membership atomically).
  Carries **exactly one** of `password` or `accessToken` (AJV `oneOf`). `accessToken` is the MSG91
  phone-verification token and is the path every current client uses; `email` stays required as a
  contact detail, not as a credential. 409 `PHONE_ALREADY_REGISTERED` on a duplicate number.
- `POST /auth/venue-owners/otp/verify` `{phoneE164, accessToken}` → `{sessionToken, expiresAt, owner}`.
  Phone+OTP sign-in, and the way owners sign in. The client verifies the OTP with MSG91 directly,
  then hands the resulting access token here; the backend re-verifies it against MSG91's
  `verifyAccessToken` and requires the number MSG91 returns to match `phoneE164` — without that
  check a token for one phone could sign in as another. 404 `PHONE_NOT_REGISTERED`,
  401 `PHONE_TOKEN_MISMATCH`, 503 `OTP_PROVIDER_ERROR`. `phone_e164` is unique per owner.
- `POST /auth/venue-owners/login` `{email, password}` → `{sessionToken, expiresAt, owner}`.
  Legacy email+password, retained only until every client has moved to OTP.
- Header `Authorization: Bearer <sessionToken>`. Opaque — only its SHA-256 hash is stored; you cannot decode it. Persist `expiresAt` from the response.
- TTL 168h, max 5 concurrent sessions, lockout after 5 failed attempts for 15 min. **No refresh.**
- `GET /auth/venue-owners/me` → profile + memberships + roles + **permissions**. Call immediately after login; it is the only source of the venue list and the per-venue permission set.
- Permissions: `MANAGE_VENUE, MANAGE_COURTS, MANAGE_PRICING, MANAGE_MEMBERS, MANAGE_KYC, VIEW_FINANCE, VIEW_BOOKINGS, MANAGE_AVAILABILITY, MANAGE_BOOKINGS`

| Role | Permissions |
|---|---|
| `OWNER` | all 9 |
| `MANAGER` | MANAGE_VENUE, MANAGE_COURTS, MANAGE_PRICING, MANAGE_MEMBERS, VIEW_BOOKINGS, MANAGE_AVAILABILITY |
| `STAFF` | VIEW_BOOKINGS, MANAGE_AVAILABILITY |

**Gate UI on the permission array, not the role name.** Only `OWNER` has `MANAGE_BOOKINGS` and
`VIEW_FINANCE` — managers and staff cannot take payments or see money.

### 3. Partner portal — opaque session (humans in the developer console)

- `POST /partners/applications` `{legalName, displayName, email, phoneE164, password(12–128)}` → 201
- `POST /partners/auth/login` → `{sessionToken, expiresAt}`; `POST /partners/auth/logout` → 204
- `GET /partners/me` → **only `{partnerId, status}`** — no name, email, or tier. A richer profile needs a backend change.
- Portal sessions authorise **only** partner KYC and partner payout accounts. Nothing else.
- `PATCH /partners/me` is documented but **not implemented**.

### 4. Partner machine API — API key + HMAC

Headers: `X-Api-Key`, `X-Signature`, `X-Timestamp` (unix **seconds**), optional `X-Request-Id`,
plus `Idempotency-Key` on confirm/cancel.

Canonical string, newline-joined — **the 5th line exists only when `X-Request-Id` is sent**
(`docs/identity-api.md` omits it and is wrong):

```
<timestamp>
<UPPERCASE_METHOD>
<path including query string>
<lowercase hex sha256 of raw body>   ← sha256 of empty bytes when there is no body
[<X-Request-Id>]
```

`X-Signature = hex(HMAC-SHA256(signingSecret, canonicalString))`, optional `sha256=` prefix.
Clock skew window 300s.

Key format `gds_sbx_<12hex>_<32 base64url>` / `gds_prd_…` — **environment is readable from the
prefix**, and comes from the credential, never from the request. Scopes likewise.

Scopes actually enforced: `availability:read`, `bookings:write`, `reports:read`, `finance:read`,
`finance:write`, `webhooks:write`. Free-form at issuance (no server enum) → the console must offer
a curated picker.

---

## Booking lifecycle — read this before designing any booking screen

Statuses: `CONFIRMED | CANCELLED | REFUND_PENDING | REFUNDED | DISPUTED`.

**There is no `PENDING` and no `REJECTED`.** A hold is a *slot* state, not a booking — no Booking
document exists until confirm. So there is nothing to "accept", and no approve/decline inbox
should be built.

Types: `OPEN_TIME` | `FIXED_SLOT` (both partner-originated) | `DIRECT` (owner walk-in).

| From | To | Endpoint | Actor |
|---|---|---|---|
| — | CONFIRMED | `POST /bookings/hold` → `POST /bookings/confirm` | Partner (HMAC) |
| — | CONFIRMED | `POST /owner/venues/:venueId/bookings` | Owner — created already confirmed |
| CONFIRMED | CANCELLED | `POST /bookings/:id/cancel` | Partner |
| CONFIRMED | CANCELLED | `POST /owner/venues/:venueId/bookings/:id/cancel` | Owner — **DIRECT bookings only** |
| CONFIRMED | DISPUTED | `POST /admin/disputes/bookings/:id/notes` | Admin |
| DISPUTED | CONFIRMED/CANCELLED/REFUNDED | `POST /admin/disputes/bookings/:id/resolve` | Admin |

`REFUND_PENDING` is declared in the schema but **nothing ever writes it** — do not build a UI state for it.

**Owner permissions on a partner booking are read-only.** Cancelling one returns 409
`OWNER_CANCELLATION_DIRECT_ONLY`. Branch the booking detail screen on `bookingType`: show
cancel/payment/refund for `DIRECT`, a read-only view plus an escalate-to-support affordance
otherwise.

Partner cancellation refunds use the `cancellation_terms_snapshot` frozen onto the booking at
confirm time — never live policy. Owner cancellation is all-or-nothing (100% if any payment
exists, else 0) and always releases the slot.

---

## Admin portal endpoints

Auth: admin JWT on all.

**Venues & courts** (`/admin`, plugin-level auth):
`GET|POST /admin/venues` · `GET|PATCH /admin/venues/:venueId` ·
`GET|POST /admin/venues/:venueId/courts` · `GET|PATCH /admin/venues/:venueId/courts/:courtId`
Venue filters: `environment, status(PENDING|ACTIVE|SUSPENDED), ownerId, q, page, limit`.

**Onboarding & agreements:**
- `POST /admin/onboarding/venues/:venueId/approve` `{ownerId}` — one transaction: verifies BUSINESS KYC + active OWNER membership, then activates owner and venue
- `POST|GET /admin/contract-templates` `{code, title, termsText}`
- `POST /admin/onboarding/venues/:venueId/agreement` — `{ownerId, templateId|termsText, title, platformCommissionBps, settlementCycle: T_PLUS_N|WEEKLY|MONTHLY, settlementLagDays, cancellationPolicy:{cancellationAllowed, defaultRefundBps, noShowRefundBps, ownerCancellationNoticeMinutes, refundRules[≤50]{minMinutesBeforeStart, refundBps}}}` (all bps 0–10000)

**KYC review** — two-person, and the UI must enforce the order:
- `POST /kyc/admin/verifications/:id/preliminary-review` — `{status: APPROVED|REJECTED, checklist:{documentReadable, detailsMatch, gstChecked, panChecked, bankChecked, aadhaarMasked}, notes?}` (ADMIN or OPS). The six flags are **nested under `checklist`**, not flat.
- `PATCH /kyc/admin/verifications/:id/review` — `{status: VERIFIED|REJECTED, rejectionReason?, expiresAt?}` (a **different** ADMIN)
- `GET /kyc/admin/owners/:ownerId/verifications/:id/documents` and `…/partners/:partnerId/…` → 10-minute signed URLs (don't cache)
- Doc types: `GST_CERTIFICATE, PAN, PASSBOOK, AADHAAR` — all four required with complete details before submission is accepted

**Partners:**
`GET /admin/partners` · `GET /admin/partners/:partnerId` (reads live under `/admin/partners`)
`PATCH /partners/admin/:partnerId/integration-review` `{status: PENDING|PASSED|FAILED}` ·
`POST /partners/admin/:partnerId/approve-sandbox` · `POST /partners/admin/:partnerId/approve-production` ·
`PATCH /partners/admin/:partnerId/rate-limit-tier` `{tier: STARTER|STANDARD|ENTERPRISE}` ·
`POST /partners/admin/:partnerId/keys` `{environment, scopes[], expiresAt?}` → **`{keyId, apiKey, signingSecret}` returned once** ·
`DELETE /partners/admin/keys/:keyId` · `POST /partners/admin/webhooks/:webhookId/verify`
(mutations live under `/partners/admin` — note the inverted path shape vs reads)

Key issuance gates: SANDBOX needs `sandbox_approved_at` and a non-suspended partner. PRODUCTION
needs `status=ACTIVE` + `production_approved_at` + verified BUSINESS KYC, else 409
`KEY_ISSUANCE_NOT_ALLOWED` / `PARTNER_KYC_REQUIRED`.

**Contracts:** `POST|GET /admin/contracts` · `GET /admin/contracts/:contractId` (immutable versions)

Create body — field names differ from the ERD/docs, these are the real ones:
`{partnerId, venueId, commissionRateBps, taxRateBps, settlementCycle: 'T_PLUS_N'|'WEEKLY'|'MONTHLY',
settlementLagDays, allowedBookingModes: 'OPEN_TIME'|'FIXED_SLOT'|'BOTH' (a single enum, NOT an array),
effectiveFrom, cancellationTerms:{cancellationAllowed, defaultRefundBps, releaseInventory},
refundRules[≤50]{minMinutesBeforeStart, refundBps, releaseInventory}, resaleCutoffMinutes}`.
There is no `environment` or `termsVersion` field on create. Cancellation terms must mirror the policy
the venue owner already accepted.

**Reports:** `GET /admin/reports/{bookings,revenue,activity}` + `…/export` (CSV, ADMIN only, 10k row cap) ·
`GET /admin/reports/partner-api-usage`
Query: **required** `environment, from, to`; optional `venueId, partnerId, status, page, limit≤100`,
`groupBy: DAY|VENUE|PARTNER` (revenue), `dimension: VENUE|PARTNER` (activity). Range ≤366 days, half-open UTC.
*Docs list `/admin/reports/venues` and `/partners` — those do not exist; use `activity?dimension=`.*

**Disputes:** `GET /admin/disputes` · `GET /admin/disputes/bookings/:bookingId` (full evidence join) ·
`POST …/notes` `{environment, version, note}` · `POST …/resolve` `{environment, version, resolution, note}`

**Financial close** (`/admin/financial-close`, mutations ADMIN-only):
`POST|GET /settlements` · `GET /settlements/:id` · `POST /settlements/:id/submit` ·
`POST /settlements/:id/reconciliation` `{reportedAmountMinor, bankReference}` ·
`POST /settlements/:id/reconciliation/resolve` · `POST /settlements/:id/complete` ·
`POST /settlements/:id/venues/:venueId/payouts` `{payoutAccountId, idempotencyKey}` ·
`POST /payouts/:payoutId/result` · `POST /settlements/:id/adjustments` ·
`POST /settlements/:id/invoices` · `GET /invoices[/:id]` · `POST /invoices/:id/{issue,void}`
States: `DRAFT → PENDING_FUNDS → RECONCILING ↔ RECONCILED → COMPLETED` (+ `FAILED`, `REVERSED`)

**Payout account verification:** `POST /admin/venues/:venueId/payout-accounts/:accountId/verification`
`{outcome, verificationMethod: PENNY_DROP|…, failureReason?}`

**Treasury:** `POST /admin/remittances/:settlementId/review` `{bankReference, decision: APPROVED|REJECTED, notes?}` ·
`POST /admin/treasury/payouts/:payoutId/initiate`

**Communications:** `GET /admin/communications/deliveries` (filters: partnerId, endpointId, environment,
eventType, status `PENDING|RETRYING|DELIVERED|FAILED`, from, to, page, limit) ·
`GET /admin/communications/events/:eventId` · `POST /admin/communications/events/:eventId/endpoints/:endpointId/retry`
*Docs say `/outbox` and `/webhook-deliveries`; both are wrong.*

**Messaging (person to person — not the outbox):** `GET /admin/messages/threads?page=&limit=` →
`{items[]{recipientType, recipientId, recipientName, recipientEmail, recipientPhone, lastMessage, messageCount,
unreadCount}, pagination}` · `GET /admin/messages?recipientType=PARTNER|VENUE_OWNER&recipientId=&page=&limit=`
(newest first) · `POST /admin/messages` `{recipientType, recipientId, subject?, body}` → 201 message
(ADMIN or OPS; 403 `MESSAGING_OPERATOR_REQUIRED` for SUPPORT, 404 when the account does not exist) ·
`POST /admin/messages/read` `{recipientType, recipientId}` → `{updated}` (clears inbound replies only).
The recipient side reads and replies to its **own** thread — the id comes from the session, never the
request: `GET|POST /owner/messages`, `POST /owner/messages/read`, `GET|POST /partners/me/messages`,
`POST /partners/me/messages/read`. Bodies cap at 8 KB, subjects at 200 chars.

**Ops:** `GET /admin/operations/health` · `GET /admin/operations/inventory-health`
(`health: HEALTHY|STALE|EMPTY|DISABLED`)

**Connectors:** `POST|GET /admin/inventory-connectors` · `POST /admin/inventory-connectors/:id/mappings` ·
`GET /admin/inventory-connectors/:id/runs` · `PATCH /admin/inventory-connectors/:id/status` ·
`GET /admin/inventory-conflicts` · `POST /admin/inventory-conflicts/:id/resolve`

**Booking audit:** `GET /bookings/admin/:bookingId/audit`

---

## Venue-owner app endpoints

Auth: owner session token. Every venue-scoped route re-checks membership server-side.

**Identity/team:** register · login · `GET /auth/venue-owners/me` · logout ·
`GET|POST /auth/venue-owners/venues/:venueId/members` · `DELETE …/members/:memberOwnerId`
⚠️ Adding a member takes an **existing** `VenueOwner` id — there is no invite-by-email, no email
verification, and no password reset anywhere in the backend. The UI needs a "find owner by id"
affordance, and forgot-password must be an admin-assisted path for now.

**Account closure** (added 2026-08-18 — there was previously no way to close an owner account, which
blocks App Store and Play Store submission):
- `GET /auth/venue-owners/me/closure-blockers` → `{blockers[]{code, message, count}, canClose}`.
  Read-only. Codes: `UPCOMING_BOOKINGS`, `OPEN_SETTLEMENTS`, `PENDING_PAYOUTS`.
- `POST /auth/venue-owners/me/close` `{accessToken, reason?}` → `{closedAt, venuesSuspended}`.
  A **fresh** OTP verification of the account's own number is required because a live session alone
  is a weak gate for something irreversible; a token verified for a different number is 401
  `PHONE_TOKEN_MISMATCH`. Blocked closure is 409
  `ACCOUNT_CLOSURE_BLOCKED` with the blocker list in `details`, re-checked server-side rather than
  trusted from the client. Closing twice is 409 `ACCOUNT_ALREADY_CLOSED`.

**It closes, it does not delete.** The ledger is append-only, settlements and payouts are money owed
to real counterparties, and audit retention is two years — so bookings and financial records stay
exactly as they were. The owner goes `SUSPENDED` (which login and session checks already reject),
every session and push token is dropped, `legal_name`/`email`/`phone_e164` are overwritten with
placeholders (email becomes `closed+<ownerId>@turfgang.invalid`, which keeps the unique index happy
and frees the real address for re-registration), memberships are `REVOKED`, and any venue left
without an owner is `SUSPENDED` so it leaves partner search. No schema migration was needed: the
closure is recorded in `audit_history`, since the collection validator sets
`additionalProperties: false` and would reject a new top-level field.

**Venue:** `GET|PATCH /owner/venues/:venueId` (body needs `version`) ·
`POST /owner/venues/:venueId/media?version=N` (multipart, 1 file) ·
`GET|PUT /owner/venues/:venueId/content?locale=` (≤256 KiB)

**Courts:** `GET|POST /owner/venues/:venueId/courts` · `GET|PATCH …/courts/:courtId` ·
`POST …/courts/:courtId/media?version=N` ·
`PUT …/courts/:courtId/operating-hours` `{version, operatingHours[]{dayOfWeek, opensAt, closesAt}}`
Fields: `sportType: FOOTBALL|CRICKET|BADMINTON|TENNIS|PICKLEBALL|MULTI_SPORT|OTHER`, `surfaceType`,
`capacity`, `bookingMode: OPEN_TIME|FIXED_SLOT|BOTH`, `minBookingMinutes ≥60`,
`bookingIncrementMinutes ≥5`, `fixedSlotDurationMinutes`, `fixedSlotAnchorMinutes`,
`status: AVAILABLE|UNAVAILABLE`

**Pricing & inventory:** `POST|GET …/courts/:courtId/pricing-rules` · `PATCH …/pricing-rules/:id` ·
`POST …/courts/:courtId/slots/generate` `{dateFrom, dateTo}` ·
`GET …/courts/:courtId/inventory?from=&to=` (both required) ·
`POST …/courts/:courtId/inventory/block` `{reason}` + either `{slotId, slotVersion}` or `{courtVersion, startsAt, endsAt}` ·
`POST …/courts/:courtId/inventory/:slotId/release` `{version, reason}` ·
`GET /owner/venues/:venueId/inventory-connectors`

Block and release are **court-scoped** — a venue-scoped path 404s. Release returns the updated slot
(200) for `FIXED_SLOT` but an empty 204 for `OPEN_TIME`, whose provisional interval is deleted rather
than reset. Court `dayOfWeek` is **1–7, not 0–6**. Slot generation and direct bookings both require an
**ACTIVE** venue: a freshly registered venue is `PENDING`, so generation returns `{created: 0}` and
direct booking fails with `VENUE_NOT_ACTIVE` until an admin approves it.

**Bookings:** `GET /owner/venues/:venueId/bookings` (`courtId, status, from, to, page, limit≤100`) ·
`GET …/bookings/:bookingId` · `POST …/bookings` (direct) ·
`POST …/bookings/:id/cancel` `{reasonCode, reasonText?}` — DIRECT only ·
`POST …/bookings/:id/payment` `{amountMinor, method: CASH|CARD|UPI|BANK_TRANSFER|OTHER, reference?, notes?}` ·
`POST …/bookings/:id/payment/refund` `{amountMinor, version, notes?}` — `version` here is the
**payment's** version, not the booking's; sending the booking version fails the write.

**Agreement:** `GET /owner/venues/:venueId/onboarding-agreement` ·
`POST …/accept` `{version}` · `POST …/request-changes` `{version, note}`

**KYC:** `POST /kyc/owner/verifications` · `POST …/:id/documents?documentType=` (multipart) ·
`PATCH …/:id/documents/:docId/details` · `GET …/:id/documents` · `POST …/:id/submit` ·
`GET /kyc/owner/verifications/current/:verificationType`

**Payout accounts:** `POST|GET /owner/venues/:venueId/payout-accounts` · `GET|PATCH|DELETE …/:accountId` ·
`POST …/:accountId/default` · `POST …/:accountId/documents?version=&documentType=`
⚠️ Raw account numbers are **rejected at the boundary**. Only `accountVaultToken`
(`^vault_[A-Za-z0-9_-]{12,}$`), `accountLast4`, `ifscCode` are accepted, and **no endpoint in this
backend issues a vault token**. This form cannot be completed without a tokenisation vault.

**Finance:** `GET /owner/venues/:venueId/finance/settlements[/:id]` · `…/payouts[/:id]` ·
`…/settlements/:id/statement.pdf` · `…/settlements/:id/invoice.pdf`

**Dashboard/notifications/devices:** `GET /owner/venues/:venueId/dashboard?from=&to=` (ready-made
home-screen payload: counts, values, occupancy, court health, unread count, upcoming bookings,
recent payouts) · `GET /owner/notifications?venueId=&type=&unreadOnly=&page=&limit=` ·
`PATCH /owner/notifications/read` `{notificationType, aggregateType, aggregateId}` ·
`PUT|DELETE /auth/venue-owners/devices/:deviceId` `{token, platform: ANDROID|IOS|WEB}`
*Docs claim `POST /auth/venue-owners/devices` — wrong, it's `PUT …/:deviceId`.*

Notification types (17): BOOKING_CONFIRMED, BOOKING_CANCELLED, PAYOUT_COMPLETED, PAYOUT_PENDING,
PAYOUT_FAILED, SETTLEMENT_CREATED, SETTLEMENT_COMPLETED, CONTRACT_PROPOSED, CONTRACT_ACCEPTED,
KYC_SUBMITTED, KYC_VERIFIED, KYC_REJECTED, PAYMENT_RECORDED, PAYMENT_REFUNDED, VENUE_UPDATED,
COURT_UPDATED, AVAILABILITY_CHANGED

---

## Partner developer console endpoints

**Portal session:** applications · login/logout · `GET /partners/me` ·
partner KYC (`/kyc/partner/…`, same 5-step flow as owner) ·
payout accounts `POST|GET /partners/me/payout-accounts` · `POST …/:id/default` · `DELETE …/:id?version=` · `POST …/:id/documents`

**HMAC-signed (API key required):**

| Endpoint | Scope |
|---|---|
| `GET /venues/search` — `latitude, longitude, radiusMeters(100–100000), sportType` all required, + `cursor, limit` | availability:read |
| `GET /availability` — above + `startsAt, endsAt`, optional `bookingType` | availability:read |
| `GET /venues/:venueId/availability` — `startsAt, endsAt` required | availability:read |
| `POST /bookings/hold` → 201 | bookings:write |
| `POST /bookings/confirm` → 201, `Idempotency-Key` required | bookings:write |
| `POST /bookings/:id/cancel` → **201** (docs say 200) | bookings:write |
| `GET /partners/me/usage` · `/bookings[/:id]` | reports:read |
| `GET /partners/me/settlements[/:id]` · `/allocations` · `/statement.pdf` · `/invoices[/:id]` · `/invoice.pdf` | finance:read |
| `POST /partners/me/settlements/:id/remittance` · `…/remittance/manual` | finance:write |
| `POST|GET /partners/webhooks` · `POST …/:id/test` · `POST …/:id/rotate-secret` · `PUT …/:id/subscriptions` · `DELETE …/:id` | webhooks:write |

Hold body is a `oneOf`: `{bookingType:'FIXED_SLOT', slotId}` or
`{bookingType:'OPEN_TIME', venueId, courtId, startsAt, endsAt}`.
Confirm: `{holdId, externalBookingReference, customerReference?, partnerPaymentReference?}`.

Search/availability use **cursor pagination**. `truncated: true` with a non-null `nextCursor` means
the page hit a server-side scan budget — keep paging, don't treat it as the end.

### Gaps the console must design around

- **Partners cannot issue their own API keys** — issuance is admin-only. The console's "create key" must be a *request*, routed to an admin.
- **No partner-facing key list endpoint** exists. The console can only show the one-time issuance response; it cannot enumerate existing keys.
- **No plans, no billing, no subscriptions, no quotas.** Only admin-set rate-limit tiers (STARTER 100/min, STANDARD 300, ENTERPRISE 1000). A "buy a plan" page is net-new backend work.
- **Partners cannot see webhook delivery history** — deliberately admin-only.
- Browser-side HMAC signing would expose the signing secret. An in-browser playground needs a **server-side signing proxy**.

## Rate limits

Per-partner tier (Redis with Mongo fallback, 1-min fixed window) → 429 `PARTNER_RATE_LIMIT_EXCEEDED`.
Pre-auth per-IP on every route → 429 `IP_RATE_LIMIT_EXCEEDED`; auth routes are the tightest bucket
(raised locally so development isn't throttled). Responses carry `X-RateLimit-{Limit,Remaining,Reset}`.

## Media

All uploads are `multipart/form-data`, **one file per request**, max 10 MiB, allowed types
`image/jpeg, image/png, application/pdf`. Bytes route through the API — there is no signed
direct-to-Cloudinary upload endpoint, so no browser upload widget can bypass the backend.
KYC/document reads return **10-minute signed URLs**; never persist them.

## Webhooks the backend sends to partners

Headers `X-Turf-Event-Id`, `X-Turf-Event-Type`, `X-Turf-Timestamp`,
`X-Turf-Signature = HMAC-SHA256(secret, timestamp + "." + rawBody)`.
At-least-once — consumers must dedupe on event id. ≤8 attempts, 30s→3600s backoff.
Endpoint lifecycle `PENDING → (test returns 2xx) → ACTIVE → DISABLED`; rotating the secret resets
it to `PENDING` and it must be re-tested.

Events: `booking.confirmed`, `booking.cancelled`, `settlement.created`, `settlement.completed`,
`payout.pending`, `payout.completed`, `payout.failed`.

## Geography

No city entity exists. Venue discovery is **point + radius**: `latitude`, `longitude`,
`radiusMeters` (100–100 000), `sportType`, all required. Venues carry a GeoJSON `geo` point with a
2dsphere index and a free-form `address`. Currency is INR-only and hard-enforced; **all money is in
minor units (paise)**. An "Indore-first" launch is a product framing — implement it as a default
map centre and a saved city preset, not as a backend filter.
