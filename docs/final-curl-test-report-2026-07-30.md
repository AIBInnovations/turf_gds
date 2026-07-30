# Full API cURL Test Report

- Executed: 2026-07-30 17:13:12 +05:30
- Target: isolated local API and temporary MongoDB database
- Media: local test adapter; no external Cloudinary writes
- Transport: curl.exe for every HTTP request
- Total checks: 255
- Passed: 255
- Failed: 0
- Sensitive tokens and secrets: redacted

## Module Summary

| Module | Checks | Passed | Failed |
|---|---:|---:|---:|
| Platform | 5 | 5 | 0 |
| Owner Identity | 12 | 12 | 0 |
| Communications | 24 | 24 | 0 |
| Admin Identity | 8 | 8 | 0 |
| KYC | 13 | 13 | 0 |
| Admin Onboarding | 4 | 4 | 0 |
| Owner Access | 7 | 7 | 0 |
| Venue Profile | 6 | 6 | 0 |
| Courts | 9 | 9 | 0 |
| Venue Inventory | 18 | 18 | 0 |
| Payout Accounts | 9 | 9 | 0 |
| Partner Access | 16 | 16 | 0 |
| Booking Lifecycle | 30 | 30 | 0 |
| Contracts | 17 | 17 | 0 |
| Owner Bookings | 13 | 13 | 0 |
| Booking Audit | 3 | 3 | 0 |
| Financial Close | 27 | 27 | 0 |
| Admin Epic 08 | 24 | 24 | 0 |
| Partner Webhooks | 10 | 10 | 0 |

## Release Gates

| Gate | Result |
|---|---|
| TypeScript typecheck | PASS |
| Production build | PASS |
| Automated unit, route, and MongoDB replica-set integration suite | 159 passed, 0 failed, 0 skipped |
| HTTP cURL suite | 255 passed, 0 failed |
| Strict request validation and authorization boundaries | Exercised by positive and negative cases below |

## End-to-End User And Data Flows

1. Platform Admin and OPS authenticate with signed JWT access tokens; Venue Owners authenticate with opaque persisted sessions; Partners authenticate with API key plus timestamped HMAC signatures.
2. A Venue Owner registers the Owner, Venue, canonical OWNER membership, and session atomically; cross-owner access is rejected.
3. The Owner creates and submits BUSINESS KYC with protected evidence. Only ADMIN can verify it and approve the Venue; OPS remains read-only.
4. The approved Owner maintains Venue profile, Courts, operating hours, pricing rules, media, inventory, and a tokenized payout account. Responses expose only masked banking data.
5. A Partner progresses through sandbox approval, KYC, integration review, production approval, and scoped key issuance.
6. Signed Partner calls hold and confirm fixed-slot and open-time Bookings. Inventory, Contracts, Owner booking views, audit history, cancellation, refunds, and Ledger effects are verified.
7. ADMIN generates and reconciles a Settlement from unallocated Ledger entries, completes it, initiates an idempotent Venue payout, records the bank result, and the authorized Owner reads isolated Settlement and payout history.
8. Signed Partner webhook registration and secret rotation validate signature, timestamp, scope, environment, URL, and lifecycle controls.
9. The dedicated Communications worker drains transactionally queued events, writes permission-routed Owner notifications, delivers only subscribed Partner webhook events, and exposes redacted monitoring to Platform staff.

## Edge-Case Coverage

The suite covers malformed payloads, missing and invalid authentication, expired/stale signatures, role denials, cross-owner and cross-Venue isolation, duplicate and idempotent requests, invalid state transitions, optimistic-concurrency conflicts, overlapping inventory, KYC prerequisites, masked secrets and bank data, Contract version selection, cancellation/refund rules, Settlement reconciliation requirements, payout prerequisites/results, webhook subscription filtering, device-token ownership, Owner inbox deduplication/read state, Platform monitoring roles, filtering, pagination, and stable detail reads.

## Platform

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 1 | Health endpoint | `GET /health` | 200 | 200 | PASS | {"status":"ok","service":"turf-gds-api","timestamp":"2026-07-30T11:43:00.705Z"} |
| 2 | Dependency readiness | `GET /ready` | 200 | 200 | PASS | {"status":"ready","service":"turf-gds-api","dependencies":{"mongodb":"up","cloudinary":"up"},"timestamp":"2026-07-30T11:43:01.102Z"} |
| 3 | API version discovery | `GET /api/v1` | 200 | 200 | PASS | {"service":"turf-gds-api","apiVersion":"v1"} |
| 4 | Unknown route error envelope | `GET /api/v1/not-a-route` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-5"}} |
| 5 | Unknown route has stable error code | `ASSERT -` | true | true | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-5"}} |

## Owner Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 6 | Reject malformed registration | `POST /api/v1/auth/venue-owners/register` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-6","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must NO... |
| 7 | Register first Venue Owner aggregate | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a6b38c5b829ab734e9f36e4","venueId":"6a6b38c5b829ab734e9f36e5","membershipId":"6a6b38c5b829ab734e9f36e6","ownerStatus":"ACTIVE","venueStatus":"PENDING"} |
| 8 | Register second isolated Venue Owner | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a6b38c5b829ab734e9f36e7","venueId":"6a6b38c5b829ab734e9f36e8","membershipId":"6a6b38c5b829ab734e9f36e9","ownerStatus":"ACTIVE","venueStatus":"PENDING"} |
| 9 | Reject duplicate owner registration | `POST /api/v1/auth/venue-owners/register` | 409 | 409 | PASS | {"error":{"code":"EMAIL_ALREADY_REGISTERED","message":"An account with this email already exists","requestId":"req-9"}} |
| 10 | Reject invalid owner credentials | `POST /api/v1/auth/venue-owners/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-a"}} |
| 11 | Login first Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-06T11:43:02.036Z","owner":{"id":"6a6b38c5b829ab734e9f36e4","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785411780553@example.com","status":"ACTIVE"}} |
| 12 | Login second Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-06T11:43:02.185Z","owner":{"id":"6a6b38c5b829ab734e9f36e7","legalName":"Curl Owner Two Private Limited","email":"curl-owner-two-1785411780553@example.com","status":"ACTIVE"}} |
| 13 | Reject missing owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-d"}} |
| 14 | Read authenticated owner profile | `GET /api/v1/auth/venue-owners/me` | 200 | 200 | PASS | {"id":"6a6b38c5b829ab734e9f36e4","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785411780553@example.com","phoneE164":"+916411780565","status":"ACTIVE","emailVerifiedAt":null,"memberships":[{"id":"6a6b38c5b829ab734e9f... |
| 15 | Owner profile contains canonical membership | `ASSERT -` | true | true | PASS | {"id":"6a6b38c5b829ab734e9f36e4","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785411780553@example.com","phoneE164":"+916411780565","status":"ACTIVE","emailVerifiedAt":null,"memberships":[{"id":"6a6b38c5b829ab734e9f... |
| 254 | Logout revokes owner session | `POST /api/v1/auth/venue-owners/logout` | 204 | 204 | PASS |  |
| 255 | Reject revoked owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_SESSION","message":"The provided session is invalid or has expired","requestId":"req-5h"}} |

## Communications

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 16 | Reject malformed FCM device registration | `PUT /api/v1/auth/venue-owners/devices/phone-primary` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-f","details":[{"instancePath":"/token","schemaPath":"#/properties/token/minLength","keyword":"minLength","params":{"limit":20},"message":"must NOT have ... |
| 17 | Register Owner FCM device idempotently | `PUT /api/v1/auth/venue-owners/devices/phone-primary` | 200 | 200 | PASS | {"deviceId":"phone-primary","platform":"ANDROID"} |
| 18 | Device registration is Owner-scoped | `ASSERT -` | true | true | PASS | {"deviceId":"phone-primary","platform":"ANDROID"} |
| 19 | Prevent FCM token reuse across Owners | `PUT /api/v1/auth/venue-owners/devices/other-phone` | 409 | 409 | PASS | {"error":{"code":"FCM_TOKEN_ALREADY_REGISTERED","message":"This FCM token belongs to another account","requestId":"req-h"}} |
| 109 | Register subscribed production webhook | `POST /api/v1/partners/webhooks` | 201 | 201 | PASS | {"webhookId":"6a6b38cab829ab734e9f3702","status":"PENDING","signingSecret":"[REDACTED]","subscribedEvents":["booking.confirmed","booking.cancelled","payout.completed"]} |
| 110 | Webhook response retains normalized subscriptions | `ASSERT -` | true | true | PASS | {"webhookId":"6a6b38cab829ab734e9f3702","status":"PENDING","signingSecret":"[REDACTED]","subscribedEvents":["booking.confirmed","booking.cancelled","payout.completed"]} |
| 111 | Admin activates production webhook | `POST /api/v1/partners/admin/webhooks/6a6b38cab829ab734e9f3702/verify` | 204 | 204 | PASS |  |
| 112 | Replace owned webhook subscriptions | `PUT /api/v1/partners/webhooks/6a6b38cab829ab734e9f3702/subscriptions` | 204 | 204 | PASS |  |
| 203 | Drain transactional Outbox through isolated worker | `POST /__curl-test/communications/drain` | 200 | 200 | PASS | {"processed":8} |
| 204 | Worker processed queued Booking and Financial events | `ASSERT -` | true | true | PASS | {"processed":8} |
| 205 | Owner lists durable unread notifications | `GET /api/v1/owner/notifications?venueId=6a6b38c5b829ab734e9f36e5&unreadOnly=true&limit=20` | 200 | 200 | PASS | {"items":[{"notificationType":"PAYOUT_COMPLETED","aggregateType":"PAYOUT","aggregateId":"6a6b38cdb829ab734e9f373a","venueId":"6a6b38c5b829ab734e9f36e5","payload":{"payout_id":"6a6b38cdb829ab734e9f373a","settlement_id":"6a6b38cdb829ab734e9f3... |
| 206 | Permission-routed inbox contains Booking and payout events | `ASSERT -` | true | true | PASS | {"items":[{"notificationType":"PAYOUT_COMPLETED","aggregateType":"PAYOUT","aggregateId":"6a6b38cdb829ab734e9f373a","venueId":"6a6b38c5b829ab734e9f36e5","payload":{"payout_id":"6a6b38cdb829ab734e9f373a","settlement_id":"6a6b38cdb829ab734e9f3... |
| 207 | Prevent cross-owner inbox access | `GET /api/v1/owner/notifications?venueId=6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | {"items":[],"unreadCount":0,"pagination":{"page":1,"limit":20,"total":0,"totalPages":0}} |
| 208 | Other Owner receives no Venue notification data | `ASSERT -` | true | true | PASS | {"items":[],"unreadCount":0,"pagination":{"page":1,"limit":20,"total":0,"totalPages":0}} |
| 209 | Mark embedded notification read idempotently | `PATCH /api/v1/owner/notifications/read` | 204 | 204 | PASS |  |
| 210 | Replay mark-read idempotently | `PATCH /api/v1/owner/notifications/read` | 204 | 204 | PASS |  |
| 211 | SUPPORT reads webhook delivery health | `GET /api/v1/admin/communications/deliveries?status=DELIVERED&limit=20` | 200 | 200 | PASS | {"items":[{"eventId":"6a6b38cdb829ab734e9f373c","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","eventType":"PAYOUT_PAID","aggregateType":"PAYOUT","aggregateId":"6a6b38cdb829ab734e9f373a","correlationId":"req-4b","delivery... |
| 212 | Subscribed endpoint received five matching events | `ASSERT -` | true | true | PASS | {"items":[{"eventId":"6a6b38cdb829ab734e9f373c","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","eventType":"PAYOUT_PAID","aggregateType":"PAYOUT","aggregateId":"6a6b38cdb829ab734e9f373a","correlationId":"req-4b","delivery... |
| 213 | Admin reads redacted Outbox delivery detail | `GET /api/v1/admin/communications/events/6a6b38cdb829ab734e9f373c` | 200 | 200 | PASS | {"eventId":"6a6b38cdb829ab734e9f373c","aggregateType":"PAYOUT","aggregateId":"6a6b38cdb829ab734e9f373a","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","environment":"PRODUCTION","eventType":"PAYOUT_PAID","extern... |
| 214 | SUPPORT cannot schedule delivery retry | `POST /api/v1/admin/communications/events/6a6b38cdb829ab734e9f373c/endpoints/6a6b38cab829ab734e9f3702/retry` | 403 | 403 | PASS | {"error":{"code":"COMMUNICATIONS_OPERATOR_REQUIRED","message":"ADMIN or OPS role is required to retry deliveries","requestId":"req-4m"}} |
| 215 | Reject retry of already-delivered webhook | `POST /api/v1/admin/communications/events/6a6b38cdb829ab734e9f373c/endpoints/6a6b38cab829ab734e9f3702/retry` | 409 | 409 | PASS | {"error":{"code":"WEBHOOK_DELIVERY_NOT_FAILED","message":"Only a terminally failed delivery can be retried","requestId":"req-4n"}} |
| 216 | Inspect isolated webhook receiver captures | `GET /__curl-test/communications/webhooks` | 200 | 200 | PASS | {"items":[{"eventId":"6a6b38cbb829ab734e9f3710","eventType":"booking.confirmed","body":{"id":"6a6b38cbb829ab734e9f3710","eventType":"booking.confirmed","eventVersion":1,"occurredAt":"2026-07-30T11:43:07.838Z","environment":"PRODUCTION","agg... |
| 217 | Webhook envelopes are versioned and externally named | `ASSERT -` | true | true | PASS | {"items":[{"eventId":"6a6b38cbb829ab734e9f3710","eventType":"booking.confirmed","body":{"id":"6a6b38cbb829ab734e9f3710","eventType":"booking.confirmed","eventVersion":1,"occurredAt":"2026-07-30T11:43:07.838Z","environment":"PRODUCTION","agg... |
| 242 | Remove Owner FCM device | `DELETE /api/v1/auth/venue-owners/devices/phone-primary` | 204 | 204 | PASS |  |

## Admin Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 20 | Reject invalid Admin credentials | `POST /api/v1/auth/admin/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-i"}} |
| 21 | Login Admin | `POST /api/v1/auth/admin/login` | 200 | 200 | PASS | {"accessToken":"[REDACTED]","expiresAt":"2026-07-30T12:43:02.831Z","admin":{"id":"6a6b38b2b829ab734e9f36e1","email":"curl-admin@example.com","displayName":"Curl Test Admin","role":"ADMIN"}} |
| 22 | Reject invalid Admin token | `GET /api/v1/auth/admin/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_ADMIN_TOKEN","message":"The admin access token is invalid or expired","requestId":"req-k"}} |
| 23 | Read Admin identity | `GET /api/v1/auth/admin/me` | 200 | 200 | PASS | {"id":"6a6b38b2b829ab734e9f36e1","role":"ADMIN"} |
| 24 | Login read-only OPS user | `POST /api/v1/auth/admin/login` | 200 | 200 | PASS | {"accessToken":"[REDACTED]","expiresAt":"2026-07-30T12:43:03.056Z","admin":{"id":"6a6b38b3b829ab734e9f36e2","email":"curl-ops@example.com","displayName":"Curl Test Operations","role":"OPS"}} |
| 25 | Read OPS identity and role | `GET /api/v1/auth/admin/me` | 200 | 200 | PASS | {"id":"6a6b38b3b829ab734e9f36e2","role":"OPS"} |
| 26 | OPS token retains the read-only OPS role | `ASSERT -` | true | true | PASS | {"id":"6a6b38b3b829ab734e9f36e2","role":"OPS"} |
| 27 | Login SUPPORT user | `POST /api/v1/auth/admin/login` | 200 | 200 | PASS | {"accessToken":"[REDACTED]","expiresAt":"2026-07-30T12:43:03.237Z","admin":{"id":"6a6b38b3b829ab734e9f36e3","email":"curl-support@example.com","displayName":"Curl Test Support","role":"SUPPORT"}} |

## KYC

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 28 | Reject owner KYC without authentication | `POST /api/v1/kyc/owner/verifications` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-p"}} |
| 29 | Create BUSINESS KYC draft | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a6b38c7b829ab734e9f36ed","subjectType":"VENUE_OWNER","subjectId":"6a6b38c5b829ab734e9f36e4","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 30 | KYC draft creation is idempotent | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a6b38c7b829ab734e9f36ed","subjectType":"VENUE_OWNER","subjectId":"6a6b38c5b829ab734e9f36e4","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 31 | Reject Admin review before KYC submission | `PATCH /api/v1/kyc/admin/verifications/6a6b38c7b829ab734e9f36ed/review` | 409 | 409 | PASS | {"error":{"code":"KYC_REVIEW_NOT_READY","message":"Only a submitted current KYC with documents can be reviewed","requestId":"req-s"}} |
| 32 | Reject KYC submission without document | `POST /api/v1/kyc/owner/verifications/6a6b38c7b829ab734e9f36ed/submit` | 409 | 409 | PASS | {"error":{"code":"KYC_DOCUMENT_REQUIRED","message":"At least one active document is required","requestId":"req-t"}} |
| 33 | Upload protected KYC document | `POST /api/v1/kyc/owner/verifications/6a6b38c7b829ab734e9f36ed/documents?documentType=GST_CERTIFICATE` | 201 | 201 | PASS | {"documentId":"6a6b38c7b829ab734e9f36ee","status":"PENDING"} |
| 34 | Prevent cross-owner KYC document access | `POST /api/v1/kyc/owner/verifications/6a6b38c7b829ab734e9f36ed/documents?documentType=PAN` | 409 | 409 | PASS | {"error":{"code":"KYC_NOT_EDITABLE","message":"The KYC verification is not an editable current draft","requestId":"req-v"}} |
| 35 | Submit completed KYC | `POST /api/v1/kyc/owner/verifications/6a6b38c7b829ab734e9f36ed/submit` | 204 | 204 | PASS |  |
| 36 | Read current owner KYC | `GET /api/v1/kyc/owner/verifications/current/BUSINESS` | 200 | 200 | PASS | {"id":"6a6b38c7b829ab734e9f36ed","subjectType":"VENUE_OWNER","subjectId":"6a6b38c5b829ab734e9f36e4","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 37 | Submitted KYC is pending review | `ASSERT -` | true | true | PASS | {"id":"6a6b38c7b829ab734e9f36ed","subjectType":"VENUE_OWNER","subjectId":"6a6b38c5b829ab734e9f36e4","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 38 | Reject KYC review without Admin session | `PATCH /api/v1/kyc/admin/verifications/6a6b38c7b829ab734e9f36ed/review` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-y"}} |
| 39 | Forbid OPS from mutating KYC review | `PATCH /api/v1/kyc/admin/verifications/6a6b38c7b829ab734e9f36ed/review` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-z"}} |
| 40 | Admin verifies owner BUSINESS KYC | `PATCH /api/v1/kyc/admin/verifications/6a6b38c7b829ab734e9f36ed/review` | 204 | 204 | PASS |  |

## Admin Onboarding

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 41 | Block Venue approval without verified KYC | `POST /api/v1/admin/onboarding/venues/6a6b38c5b829ab734e9f36e8/approve` | 409 | 409 | PASS | {"error":{"code":"OWNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-11"}} |
| 42 | Forbid OPS from approving a Venue | `POST /api/v1/admin/onboarding/venues/6a6b38c5b829ab734e9f36e5/approve` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-12"}} |
| 43 | Approve verified Venue and Owner atomically | `POST /api/v1/admin/onboarding/venues/6a6b38c5b829ab734e9f36e5/approve` | 204 | 204 | PASS |  |
| 44 | Reject repeated Venue approval transition | `POST /api/v1/admin/onboarding/venues/6a6b38c5b829ab734e9f36e5/approve` | 409 | 409 | PASS | {"error":{"code":"VENUE_APPROVAL_NOT_ALLOWED","message":"The Venue cannot be approved","requestId":"req-14"}} |

## Owner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 45 | Prevent cross-Venue profile read | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-15"}} |
| 46 | Add Venue manager membership | `POST /api/v1/auth/venue-owners/venues/6a6b38c5b829ab734e9f36e5/members` | 201 | 201 | PASS | {"membershipId":"6a6b38c8b829ab734e9f36ef","status":"ACTIVE"} |
| 47 | List Venue members | `GET /api/v1/auth/venue-owners/venues/6a6b38c5b829ab734e9f36e5/members` | 200 | 200 | PASS | [{"ownerId":"6a6b38c5b829ab734e9f36e4","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785411780553@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a6b38c5b829ab734e9f36e7","legalName":"Curl Owner Two Priva... |
| 48 | Membership list includes owner and manager | `ASSERT -` | true | true | PASS | [{"ownerId":"6a6b38c5b829ab734e9f36e4","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785411780553@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a6b38c5b829ab734e9f36e7","legalName":"Curl Owner Two Priva... |
| 49 | Canonical OWNER membership cannot be overwritten | `POST /api/v1/auth/venue-owners/venues/6a6b38c5b829ab734e9f36e5/members` | 409 | 409 | PASS | {"error":{"code":"MEMBERSHIP_SELF_CHANGE_NOT_ALLOWED","message":"You cannot change your own venue membership","requestId":"req-18"}} |
| 50 | Revoke manager membership | `DELETE /api/v1/auth/venue-owners/venues/6a6b38c5b829ab734e9f36e5/members/6a6b38c5b829ab734e9f36e7` | 204 | 204 | PASS |  |
| 51 | Revoked manager loses Venue access | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-1a"}} |

## Venue Profile

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 52 | Read owner-scoped Venue profile | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | {"id":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka","posta... |
| 53 | Reject unsupported Venue currency | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1c","details":[{"instancePath":"/currency","schemaPath":"#/properties/currency/enum","keyword":"enum","params":{"allowedValues":["INR"]},"message":"must... |
| 54 | Update Venue with optimistic version | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | {"id":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 55 | Reject stale Venue version | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5` | 409 | 409 | PASS | {"error":{"code":"VENUE_VERSION_CONFLICT","message":"The Venue was changed by another request","requestId":"req-1e","details":{"currentVersion":3}}} |
| 56 | Upload Venue media metadata | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/media?version=3` | 201 | 201 | PASS | {"id":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 57 | Venue media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |

## Courts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 58 | Create Court | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts` | 201 | 201 | PASS | {"id":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 59 | Reject duplicate Court name | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts` | 409 | 409 | PASS | {"error":{"code":"COURT_NAME_ALREADY_EXISTS","message":"A Court with this name already exists for the Venue","requestId":"req-1h"}} |
| 60 | Reject invalid Court duration | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts` | 400 | 400 | PASS | {"error":{"code":"INVALID_COURT_DURATION","message":"Minimum booking must be at least 60 minutes and divisible by its increment","requestId":"req-1i"}} |
| 61 | Prevent cross-owner Court detail access | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-1j"}} |
| 62 | Reject invalid booking mode at route boundary | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1k","details":[{"instancePath":"/bookingMode","schemaPath":"#/properties/bookingMode/enum","keyword":"enum","params":{"allowedValues":["OPEN_TIME","FIXE... |
| 63 | Configure Court operating hours | `PUT /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/operating-hours` | 200 | 200 | PASS | {"id":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 64 | Reject reversed operating hours | `PUT /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/operating-hours` | 400 | 400 | PASS | {"error":{"code":"INVALID_OPERATING_HOURS","message":"Opening time must be before closing time","requestId":"req-1m"}} |
| 65 | Upload Court media metadata | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/media?version=2` | 201 | 201 | PASS | {"id":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 66 | Court media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |

## Venue Inventory

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 67 | Reject negative pricing | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/pricing-rules` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1o","details":[{"instancePath":"/priceMinor","schemaPath":"#/properties/priceMinor/minimum","keyword":"minimum","params":{"comparison":">=","limit":0},"... |
| 68 | Create pricing rule | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/pricing-rules` | 201 | 201 | PASS | {"id":"6a6b38c9b829ab734e9f36f3","courtId":"6a6b38c8b829ab734e9f36f0","name":"Booking day","dayOfWeek":6,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":nul... |
| 69 | List Court pricing rules | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/pricing-rules` | 200 | 200 | PASS | [{"id":"6a6b38c9b829ab734e9f36f3","courtId":"6a6b38c8b829ab734e9f36f0","name":"Booking day","dayOfWeek":6,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":nu... |
| 70 | Pricing list preserves INR amount | `ASSERT -` | true | true | PASS | {"id":"6a6b38c9b829ab734e9f36f3","courtId":"6a6b38c8b829ab734e9f36f0","name":"Booking day","dayOfWeek":6,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":nul... |
| 71 | Deactivate pricing rule | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/pricing-rules/6a6b38c9b829ab734e9f36f3` | 200 | 200 | PASS | {"id":"6a6b38c9b829ab734e9f36f3","courtId":"6a6b38c8b829ab734e9f36f0","name":"Booking day","dayOfWeek":6,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":nul... |
| 72 | Inactive pricing generates no slots | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 73 | Reactivate pricing rule | `PATCH /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/pricing-rules/6a6b38c9b829ab734e9f36f3` | 200 | 200 | PASS | {"id":"6a6b38c9b829ab734e9f36f3","courtId":"6a6b38c8b829ab734e9f36f0","name":"Booking day","dayOfWeek":6,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":nul... |
| 74 | Generate rolling fixed slots | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/slots/generate` | 200 | 200 | PASS | {"created":2} |
| 75 | Two one-hour slots generated | `ASSERT -` | true | true | PASS | {"created":2} |
| 76 | Slot generation is idempotent | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 77 | Repeated generation creates zero duplicates | `ASSERT -` | true | true | PASS | {"created":0} |
| 78 | Read owner inventory calendar | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z` | 200 | 200 | PASS | [{"id":"6a6b38c9b829ab734e9f36f4","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":125000,"currency":"INR","sta... |
| 79 | Block fixed Slot | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/block` | 201 | 201 | PASS | {"id":"6a6b38c9b829ab734e9f36f4","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 80 | Reject stale fixed Slot block | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/block` | 409 | 409 | PASS | {"error":{"code":"SLOT_BLOCK_CONFLICT","message":"Slot is held, booked, blocked, or stale","requestId":"req-1y"}} |
| 81 | Release fixed Slot | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/6a6b38c9b829ab734e9f36f4/release` | 200 | 200 | PASS | {"id":"6a6b38c9b829ab734e9f36f4","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 82 | Create transactional open-time block | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/block` | 201 | 201 | PASS | {"id":"6a6b38c9b829ab734e9f36f8","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"OPEN_TIME","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":null,"currency":"INR","status"... |
| 83 | Reject overlapping open-time block | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/block` | 409 | 409 | PASS | {"error":{"code":"INVENTORY_OVERLAP","message":"The interval overlaps unavailable inventory","requestId":"req-21"}} |
| 84 | Release open-time block | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory/6a6b38c9b829ab734e9f36f8/release` | 204 | 204 | PASS |  |

## Payout Accounts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 85 | Reject malformed tokenized payout metadata | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/payout-accounts` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-23","details":[{"instancePath":"/vaultAccountToken","schemaPath":"#/properties/vaultAccountToken/minLength","keyword":"minLength","params":{"limit":12},... |
| 86 | Create pending tokenized payout account | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/payout-accounts` | 201 | 201 | PASS | {"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 87 | Payout response is masked and pending | `ASSERT -` | true | true | PASS | {"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 88 | Reject duplicate payout vault token | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/payout-accounts` | 409 | 409 | PASS | {"error":{"code":"PAYOUT_ACCOUNT_ALREADY_EXISTS","message":"This tokenized payout account already exists","requestId":"req-25"}} |
| 89 | List masked payout accounts | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/payout-accounts` | 200 | 200 | PASS | [{"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifi... |
| 90 | Admin verification fields remain empty | `ASSERT -` | true | true | PASS | {"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 91 | Forbid OPS from verifying payout account | `POST /api/v1/admin/venues/6a6b38c5b829ab734e9f36e5/payout-accounts/6a6b38c9b829ab734e9f36fa/verification` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-27"}} |
| 92 | Admin verifies payout account | `POST /api/v1/admin/venues/6a6b38c5b829ab734e9f36e5/payout-accounts/6a6b38c9b829ab734e9f36fa/verification` | 200 | 200 | PASS | {"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"VERIFIED","verifi... |
| 93 | Verified payout account records the Admin outcome | `ASSERT -` | true | true | PASS | {"id":"6a6b38c9b829ab734e9f36fa","venueId":"6a6b38c5b829ab734e9f36e5","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"VERIFIED","verifi... |

## Partner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 94 | Reject malformed Partner application | `POST /api/v1/partners/applications` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-29","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must N... |
| 95 | Create Partner application | `POST /api/v1/partners/applications` | 201 | 201 | PASS | {"partnerId":"6a6b38cab829ab734e9f36fc","status":"PENDING"} |
| 96 | Forbid OPS from approving Partner sandbox | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/approve-sandbox` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-2b"}} |
| 97 | Reject duplicate Partner application | `POST /api/v1/partners/applications` | 409 | 409 | PASS | {"error":{"code":"PARTNER_ALREADY_EXISTS","message":"A matching Partner application already exists","requestId":"req-2c"}} |
| 98 | Reject key before sandbox approval | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/keys` | 409 | 409 | PASS | {"error":{"code":"KEY_ISSUANCE_NOT_ALLOWED","message":"The Partner is not approved for this environment","requestId":"req-2d"}} |
| 99 | Approve Partner sandbox | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/approve-sandbox` | 204 | 204 | PASS |  |
| 100 | Issue sandbox Partner key | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/keys` | 201 | 201 | PASS | {"keyId":"6a6b38cab829ab734e9f36fe","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"SANDBOX","scopes":["webhooks:write"]} |
| 101 | Reject production approval without KYC/review | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/approve-production` | 409 | 409 | PASS | {"error":{"code":"PARTNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-2g"}} |
| 102 | Admin creates Partner BUSINESS KYC | `POST /api/v1/kyc/admin/partners/6a6b38cab829ab734e9f36fc/verifications` | 201 | 201 | PASS | {"id":"6a6b38cab829ab734e9f36ff","subjectType":"PARTNER","subjectId":"6a6b38cab829ab734e9f36fc","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 103 | Admin uploads Partner KYC document | `POST /api/v1/kyc/admin/partners/6a6b38cab829ab734e9f36fc/verifications/6a6b38cab829ab734e9f36ff/documents?documentType=BUSINESS_REGISTRATION` | 201 | 201 | PASS | {"documentId":"6a6b38cab829ab734e9f3700","status":"PENDING"} |
| 104 | Admin submits Partner KYC | `POST /api/v1/kyc/admin/partners/6a6b38cab829ab734e9f36fc/verifications/6a6b38cab829ab734e9f36ff/submit` | 204 | 204 | PASS |  |
| 105 | Admin verifies Partner KYC | `PATCH /api/v1/kyc/admin/verifications/6a6b38cab829ab734e9f36ff/review` | 204 | 204 | PASS |  |
| 106 | Record passed integration review | `PATCH /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/integration-review` | 204 | 204 | PASS |  |
| 107 | Approve Partner production | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/approve-production` | 204 | 204 | PASS |  |
| 108 | Issue production Partner key | `POST /api/v1/partners/admin/6a6b38cab829ab734e9f36fc/keys` | 201 | 201 | PASS | {"keyId":"6a6b38cab829ab734e9f3701","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"PRODUCTION","scopes":["availability:read","bookings:write","webhooks:write"]} |
| 252 | Admin revokes Partner key | `DELETE /api/v1/partners/admin/keys/6a6b38cab829ab734e9f36fe` | 204 | 204 | PASS |  |

## Booking Lifecycle

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 113 | Reject booking before effective Contract exists | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"ACTIVE_CONTRACT_NOT_FOUND","message":"No effective Partner-Venue contract was found","requestId":"req-2r"}} |
| 127 | Reject unsigned fixed-slot hold | `POST /api/v1/bookings/hold` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-32"}} |
| 128 | Reject Partner key without bookings write scope | `POST /api/v1/bookings/hold` | 403 | 403 | PASS | {"error":{"code":"PARTNER_SCOPE_REQUIRED","message":"The bookings:write scope is required","requestId":"req-33"}} |
| 129 | Reject incomplete fixed-slot hold shape | `POST /api/v1/bookings/hold` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-34","details":[{"instancePath":"","schemaPath":"#/oneOf/0/required","keyword":"required","params":{"missingProperty":"slotId"},"message":"must have requ... |
| 130 | Hold available fixed Slot | `POST /api/v1/bookings/hold` | 201 | 201 | PASS | {"holdId":"2b755d3b-c8ca-409a-baf5-06296a0e28ba","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-0... |
| 131 | Fixed hold returns durable identifiers, price, and expiry | `ASSERT -` | true | true | PASS | {"holdId":"2b755d3b-c8ca-409a-baf5-06296a0e28ba","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-0... |
| 132 | Reject a competing fixed-slot hold | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"SLOT_NOT_AVAILABLE","message":"Slot is already held, booked, blocked, or unavailable","requestId":"req-36"}} |
| 133 | Require Idempotency-Key for confirmation | `POST /api/v1/bookings/confirm` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-37","details":[{"instancePath":"","schemaPath":"#/required","keyword":"required","params":{"missingProperty":"idempotency-key"},"message":"must have req... |
| 134 | Confirm fixed-slot Booking | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:3... |
| 135 | Confirmation snapshots correct commercial amounts | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:3... |
| 136 | Replay fixed confirmation idempotently | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:3... |
| 137 | Confirmation replay returns original Booking | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","slotId":"6a6b38c9b829ab734e9f36f4","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:3... |
| 138 | Reject confirmation key reuse with changed content | `POST /api/v1/bookings/confirm` | 409 | 409 | PASS | {"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"Idempotency key was already used with a different request","requestId":"req-3a"}} |
| 139 | Reject hold on an already booked Slot | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"SLOT_NOT_AVAILABLE","message":"Slot is already held, booked, blocked, or unavailable","requestId":"req-3b"}} |
| 153 | Require Idempotency-Key for cancellation | `POST /api/v1/bookings/6a6b38cbb829ab734e9f370b/cancel` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-3k","details":[{"instancePath":"","schemaPath":"#/required","keyword":"required","params":{"missingProperty":"idempotency-key"},"message":"must have req... |
| 154 | Cancel confirmed fixed-slot Booking | `POST /api/v1/bookings/6a6b38cbb829ab734e9f370b/cancel` | 201 | 201 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:08.486Z"} |
| 155 | Cancellation applies snapshotted refund and releases inventory | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:08.486Z"} |
| 156 | Replay cancellation idempotently | `POST /api/v1/bookings/6a6b38cbb829ab734e9f370b/cancel` | 201 | 201 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:08.486Z"} |
| 157 | Cancellation replay returns original result | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:08.486Z"} |
| 158 | Reject cancellation key reuse with changed content | `POST /api/v1/bookings/6a6b38cbb829ab734e9f370b/cancel` | 409 | 409 | PASS | {"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"Idempotency key was already used with a different request","requestId":"req-3n"}} |
| 164 | Read inventory after fixed cancellation | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/inventory?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z` | 200 | 200 | PASS | [{"id":"6a6b38c9b829ab734e9f36f4","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":125000,"currency":"INR","sta... |
| 165 | Cancelled fixed Slot is available for resale | `ASSERT -` | true | true | PASS | {"id":"6a6b38c9b829ab734e9f36f4","courtId":"6a6b38c8b829ab734e9f36f0","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-08-01T00:30:00.000Z","endsAt":"2026-08-01T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 166 | Reject open-time duration below minimum | `POST /api/v1/bookings/hold` | 400 | 400 | PASS | {"error":{"code":"INVALID_BOOKING_DURATION","message":"Duration must be at least 60 minutes and follow 30-minute increments","requestId":"req-3s"}} |
| 167 | Hold valid open-time interval | `POST /api/v1/bookings/hold` | 201 | 201 | PASS | {"holdId":"107d65b3-1dd2-4b83-ac14-2a60ebe20322","slotId":"6a6b38ccb829ab734e9f3723","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"OPEN_TIME","startsAt":"2026-08-01T01:30:00.000Z","endsAt":"2026-08... |
| 168 | Open-time hold calculates the hourly price | `ASSERT -` | true | true | PASS | {"holdId":"107d65b3-1dd2-4b83-ac14-2a60ebe20322","slotId":"6a6b38ccb829ab734e9f3723","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"OPEN_TIME","startsAt":"2026-08-01T01:30:00.000Z","endsAt":"2026-08... |
| 169 | Reject overlapping open-time hold | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"INVENTORY_OVERLAP","message":"The requested interval overlaps unavailable inventory","requestId":"req-3u"}} |
| 170 | Confirm open-time Booking | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a6b38cdb829ab734e9f3726","slotId":"6a6b38ccb829ab734e9f3723","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"OPEN_TIME","startsAt":"2026-08-01T01:30:00.000Z","endsAt":"2026-08-01T02:30... |
| 171 | Open-time confirmation uses currently effective version 1 | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cdb829ab734e9f3726","slotId":"6a6b38ccb829ab734e9f3723","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","bookingType":"OPEN_TIME","startsAt":"2026-08-01T01:30:00.000Z","endsAt":"2026-08-01T02:30... |
| 172 | Cancel open-time Booking | `POST /api/v1/bookings/6a6b38cdb829ab734e9f3726/cancel` | 201 | 201 | PASS | {"bookingId":"6a6b38cdb829ab734e9f3726","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:09.084Z"} |
| 173 | Open-time cancellation releases provisional inventory | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cdb829ab734e9f3726","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-30T11:43:09.084Z"} |

## Contracts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 114 | Require Admin authentication for Contract list | `GET /api/v1/admin/contracts` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-2s"}} |
| 115 | Reject Contract for an unknown Partner | `POST /api/v1/admin/contracts` | 409 | 409 | PASS | {"error":{"code":"CONTRACT_PARTNER_NOT_ELIGIBLE","message":"Partner must be ACTIVE","requestId":"req-2t"}} |
| 116 | Reject commission and tax above 100 percent | `POST /api/v1/admin/contracts` | 400 | 400 | PASS | {"error":{"code":"INVALID_CONTRACT_TERMS","message":"Commission and tax must total at most 100 percent","requestId":"req-2u"}} |
| 117 | Reject duplicate refund thresholds | `POST /api/v1/admin/contracts` | 400 | 400 | PASS | {"error":{"code":"INVALID_CONTRACT_TERMS","message":"Refund-rule thresholds must be unique non-negative integers","requestId":"req-2v"}} |
| 118 | Create effective Contract version 1 | `POST /api/v1/admin/contracts` | 201 | 201 | PASS | {"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 119 | Version 1 preserves commercial and cancellation terms | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 120 | Read Contract detail | `GET /api/v1/admin/contracts/6a6b38cbb829ab734e9f3706` | 200 | 200 | PASS | {"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 121 | Contract detail matches created relationship | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 122 | Filter Contract versions by Partner and Venue | `GET /api/v1/admin/contracts?partnerId=6a6b38cab829ab734e9f36fc&venueId=6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | [{"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes"... |
| 123 | Filtered Contract list contains version 1 | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f3706","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 124 | Reject a non-increasing effective date | `POST /api/v1/admin/contracts` | 409 | 409 | PASS | {"error":{"code":"CONTRACT_EFFECTIVE_DATE_CONFLICT","message":"A new contract version must start after the latest version","requestId":"req-2z"}} |
| 125 | Return not found for unknown Contract detail | `GET /api/v1/admin/contracts/000000000000000000000002` | 404 | 404 | PASS | {"error":{"code":"CONTRACT_NOT_FOUND","message":"Partner-Venue contract was not found","requestId":"req-30"}} |
| 126 | Expose no Venue Owner Contract mutation route | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/contracts` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-31"}} |
| 147 | Create future Contract version 2 | `POST /api/v1/admin/contracts` | 201 | 201 | PASS | {"id":"6a6b38ccb829ab734e9f3716","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes"... |
| 148 | Future Contract increments immutable terms version | `ASSERT -` | true | true | PASS | {"id":"6a6b38ccb829ab734e9f3716","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes"... |
| 149 | List complete Contract version history | `GET /api/v1/admin/contracts?partnerId=6a6b38cab829ab734e9f36fc&venueId=6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | [{"id":"6a6b38ccb829ab734e9f3716","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes... |
| 150 | Version 1 is closed at version 2 effective time | `ASSERT -` | true | true | PASS | [{"id":"6a6b38ccb829ab734e9f3716","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes... |

## Owner Bookings

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 140 | List confirmed Venue bookings with filters | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings?courtId=6a6b38c8b829ab734e9f36f0&status=CONFIRMED&page=1&limit=10` | 200 | 200 | PASS | {"items":[{"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environ... |
| 141 | Owner list exposes Partner reference and scoped Booking | `ASSERT -` | true | true | PASS | {"items":[{"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environ... |
| 142 | Prevent cross-Venue Owner booking access | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-3d"}} |
| 143 | Reject an inverted booking date filter | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings?from=2026-08-02T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z` | 400 | 400 | PASS | {"error":{"code":"INVALID_BOOKING_DATE_RANGE","message":"The booking filter start must be before its end","requestId":"req-3e"}} |
| 144 | Expose no Venue Owner booking creation route | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-3f"}} |
| 145 | Read confirmed Booking detail | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings/6a6b38cbb829ab734e9f370b` | 200 | 200 | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 146 | Booking detail references Contract version 1 | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 151 | Read Booking after future Contract change | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings/6a6b38cbb829ab734e9f370b` | 200 | 200 | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 152 | Existing Booking commercial snapshot remains unchanged | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 159 | Read cancellation outcome in Owner detail | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings/6a6b38cbb829ab734e9f370b` | 200 | 200 | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 160 | Owner detail contains cancellation reason and refund | `ASSERT -` | true | true | PASS | {"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environment":"PRO... |
| 174 | Filter cancelled Venue bookings | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/bookings?status=CANCELLED&limit=10` | 200 | 200 | PASS | {"items":[{"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environ... |
| 175 | Owner sees both cancelled booking modes | `ASSERT -` | true | true | PASS | {"items":[{"id":"6a6b38cbb829ab734e9f370b","partnerId":"6a6b38cab829ab734e9f36fc","venueId":"6a6b38c5b829ab734e9f36e5","courtId":"6a6b38c8b829ab734e9f36f0","slotId":"6a6b38c9b829ab734e9f36f4","contractId":"6a6b38cbb829ab734e9f3706","environ... |

## Booking Audit

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 161 | Require Admin authentication for Booking audit | `GET /api/v1/bookings/admin/6a6b38cbb829ab734e9f370b/audit` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-3p"}} |
| 162 | Read chronological Booking audit trail | `GET /api/v1/bookings/admin/6a6b38cbb829ab734e9f370b/audit` | 200 | 200 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","auditHistory":[{"eventType":"BOOKING_CONFIRMED","actorType":"PARTNER","actorId":"6a6b38cab829ab734e9f36fc","correlationId":"req-38","changes":{"previous_status":null,"new_status"... |
| 163 | Audit contains confirmation then cancellation | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","status":"CANCELLED","auditHistory":[{"eventType":"BOOKING_CONFIRMED","actorType":"PARTNER","actorId":"6a6b38cab829ab734e9f36fc","correlationId":"req-38","changes":{"previous_status":null,"new_status"... |

## Financial Close

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 176 | Forbid OPS from generating Settlement | `POST /api/v1/admin/financial-close/settlements` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for Financial Close mutations","requestId":"req-3y"}} |
| 177 | Generate production Settlement | `POST /api/v1/admin/financial-close/settlements` | 201 | 201 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 178 | Generated Settlement is a positive draft | `ASSERT -` | true | true | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 179 | Admin lists filtered Settlements | `GET /api/v1/admin/financial-close/settlements?partnerId=6a6b38cab829ab734e9f36fc&status=DRAFT&limit=10` | 200 | 200 | PASS | {"items":[{"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:0... |
| 180 | OPS may read filtered Settlement history | `ASSERT -` | true | true | PASS | {"items":[{"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:0... |
| 181 | Admin reads Settlement detail | `GET /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736` | 200 | 200 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 182 | Submit Settlement for reconciliation | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/submit` | 200 | 200 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 183 | Require bank reference for reconciliation | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/reconciliation` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-43","details":[{"instancePath":"","schemaPath":"#/required","keyword":"required","params":{"missingProperty":"bankReference"},"message":"must have requi... |
| 184 | Record matching remittance | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/reconciliation` | 201 | 201 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 185 | Matching remittance reconciles Settlement | `ASSERT -` | true | true | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 186 | Complete reconciled Settlement | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/complete` | 200 | 200 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 187 | Owner lists completed Venue Settlements | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/finance/settlements?status=COMPLETED&limit=10` | 200 | 200 | PASS | {"items":[{"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:0... |
| 188 | Owner Settlement totals are Venue-specific | `ASSERT -` | true | true | PASS | {"items":[{"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:0... |
| 189 | Owner reads booking-level Settlement detail | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/finance/settlements/6a6b38cdb829ab734e9f3736` | 200 | 200 | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 190 | Settlement detail includes allocated booking Ledger entries | `ASSERT -` | true | true | PASS | {"settlementId":"6a6b38cdb829ab734e9f3736","partnerId":"6a6b38cab829ab734e9f36fc","environment":"PRODUCTION","periodStart":"2026-07-29T00:00:00.000Z","periodEnd":"2026-07-31T00:00:00.000Z","cycle":"WEEKLY","dueAt":"2026-08-02T00:00:00.000Z"... |
| 191 | Initiate Venue payout | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/venues/6a6b38c5b829ab734e9f36e5/payouts` | 201 | 201 | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PEN... |
| 192 | Venue payout starts pending with a positive amount | `ASSERT -` | true | true | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PEN... |
| 193 | Replay payout initiation idempotently | `POST /api/v1/admin/financial-close/settlements/6a6b38cdb829ab734e9f3736/venues/6a6b38c5b829ab734e9f36e5/payouts` | 201 | 201 | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PEN... |
| 194 | Idempotent payout replay returns the same record | `ASSERT -` | true | true | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PEN... |
| 195 | Require bank reference for paid result | `POST /api/v1/admin/financial-close/payouts/6a6b38cdb829ab734e9f373a/result` | 400 | 400 | PASS | {"error":{"code":"INVALID_INPUT","message":"bankReference is required","requestId":"req-4a"}} |
| 196 | Record manual payout success | `POST /api/v1/admin/financial-close/payouts/6a6b38cdb829ab734e9f373a/result` | 200 | 200 | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PAI... |
| 197 | Manual result moves payout directly to paid | `ASSERT -` | true | true | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PAI... |
| 198 | Owner lists paid Venue payouts | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/finance/payouts?status=PAID&limit=10` | 200 | 200 | PASS | {"items":[{"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","st... |
| 199 | Owner finance history returns masked paid payout | `ASSERT -` | true | true | PASS | {"items":[{"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","st... |
| 200 | Owner reads masked payout detail | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/finance/payouts/6a6b38cdb829ab734e9f373a` | 200 | 200 | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PAI... |
| 201 | Payout detail never exposes the vault token | `ASSERT -` | true | true | PASS | {"payoutId":"6a6b38cdb829ab734e9f373a","settlementId":"6a6b38cdb829ab734e9f3736","venueId":"6a6b38c5b829ab734e9f36e5","payoutAccountId":"6a6b38c9b829ab734e9f36fa","environment":"PRODUCTION","amountMinor":44100,"currency":"INR","status":"PAI... |
| 202 | Block cross-owner finance access | `GET /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/finance/payouts` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-4e"}} |

## Admin Epic 08

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 218 | SUPPORT reads filtered Venue operations list | `GET /api/v1/admin/venues?environment=PRODUCTION&status=ACTIVE&ownerId=6a6b38c5b829ab734e9f36e4&limit=10` | 200 | 200 | PASS | {"items":[{"venueId":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","st... |
| 219 | Admin Venue list remains Owner and environment scoped | `ASSERT -` | true | true | PASS | {"items":[{"venueId":"6a6b38c5b829ab734e9f36e5","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","st... |
| 220 | OPS cannot create an Admin-managed Venue | `POST /api/v1/admin/venues` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-4q"}} |
| 221 | ADMIN creates a pending Venue and OWNER membership atomically | `POST /api/v1/admin/venues` | 201 | 201 | PASS | {"venueId":"6a6b38ceb829ab734e9f373d","legalName":"Admin Curl Venue Private Limited","displayName":"Admin Curl Venue","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"8 Admin Road","city":"Bengaluru","state":"Karnata... |
| 222 | Admin-created Venue begins pending with canonical membership | `ASSERT -` | true | true | PASS | {"venueId":"6a6b38ceb829ab734e9f373d","legalName":"Admin Curl Venue Private Limited","displayName":"Admin Curl Venue","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"8 Admin Road","city":"Bengaluru","state":"Karnata... |
| 223 | SUPPORT reads stored Booking commercial report | `GET /api/v1/admin/reports/bookings?environment=PRODUCTION&from=2026-07-28T00%3A00%3A00.000Z&to=2026-08-11T00%3A00%3A00.000Z&venueId=6a6b38c5b829ab734e9f36e5` | 200 | 200 | PASS | {"items":[{"_id":"6a6b38cdb829ab734e9f3726","environment":"PRODUCTION","status":"CANCELLED","currency":"INR","bookingId":"6a6b38cdb829ab734e9f3726","venueId":"6a6b38c5b829ab734e9f36e5","partnerId":"6a6b38cab829ab734e9f36fc","courtId":"6a6b3... |
| 224 | Booking report uses persisted scoped totals | `ASSERT -` | true | true | PASS | {"items":[{"_id":"6a6b38cdb829ab734e9f3726","environment":"PRODUCTION","status":"CANCELLED","currency":"INR","bookingId":"6a6b38cdb829ab734e9f3726","venueId":"6a6b38c5b829ab734e9f36e5","partnerId":"6a6b38cab829ab734e9f36fc","courtId":"6a6b3... |
| 225 | OPS reads Ledger-backed revenue report | `GET /api/v1/admin/reports/revenue?environment=PRODUCTION&from=2026-07-28T00%3A00%3A00.000Z&to=2026-08-11T00%3A00%3A00.000Z&venueId=6a6b38c5b829ab734e9f36e5&groupBy=VENUE` | 200 | 200 | PASS | {"totals":{"grossAmountMinor":50000,"commissionAmountMinor":5000,"taxAmountMinor":900,"venueNetAmountMinor":44100,"refundAmountMinor":400000,"adjustmentAmountMinor":0,"entryCount":16},"buckets":[{"grossAmountMinor":50000,"commissionAmountMi... |
| 226 | Revenue report includes Ledger and Financial Close summaries | `ASSERT -` | true | true | PASS | {"totals":{"grossAmountMinor":50000,"commissionAmountMinor":5000,"taxAmountMinor":900,"venueNetAmountMinor":44100,"refundAmountMinor":400000,"adjustmentAmountMinor":0,"entryCount":16},"buckets":[{"grossAmountMinor":50000,"commissionAmountMi... |
| 227 | SUPPORT cannot export financial CSV | `GET /api/v1/admin/reports/revenue/export?environment=PRODUCTION&from=2026-07-28T00%3A00%3A00.000Z&to=2026-08-11T00%3A00%3A00.000Z&venueId=6a6b38c5b829ab734e9f36e5&groupBy=VENUE` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-4u"}} |
| 228 | ADMIN exports bounded UTF-8 revenue CSV | `GET /api/v1/admin/reports/revenue/export?environment=PRODUCTION&from=2026-07-28T00%3A00%3A00.000Z&to=2026-08-11T00%3A00%3A00.000Z&venueId=6a6b38c5b829ab734e9f36e5&groupBy=VENUE` | 200 | 200 | PASS | "grossAmountMinor","commissionAmountMinor","taxAmountMinor","venueNetAmountMinor","refundAmountMinor","adjustmentAmountMinor","entryCount","key" "50000","5000","900","44100","400000","0","16","6a6b38c5b829ab734e9f36e5"  |
| 229 | CSV export contains financial headers | `ASSERT -` | true | true | PASS | "grossAmountMinor","commissionAmountMinor","taxAmountMinor","venueNetAmountMinor","refundAmountMinor","adjustmentAmountMinor","entryCount","key" "50000","5000","900","44100","400000","0","16","6a6b38c5b829ab734e9f36e5"  |
| 230 | SUPPORT reads cross-module Booking dispute view | `GET /api/v1/admin/disputes/bookings/6a6b38cbb829ab734e9f370b?environment=PRODUCTION` | 200 | 200 | PASS | {"booking":{"_id":"6a6b38cbb829ab734e9f370b","slot_id":"6a6b38c9b829ab734e9f36f4","contract_id":"6a6b38cbb829ab734e9f3706","partner_id":"6a6b38cab829ab734e9f36fc","venue_id":"6a6b38c5b829ab734e9f36e5","court_id":"6a6b38c8b829ab734e9f36f0","... |
| 231 | Dispute view joins Ledger and redacted Outbox evidence | `ASSERT -` | true | true | PASS | {"booking":{"_id":"6a6b38cbb829ab734e9f370b","slot_id":"6a6b38c9b829ab734e9f36f4","contract_id":"6a6b38cbb829ab734e9f3706","partner_id":"6a6b38cab829ab734e9f36fc","venue_id":"6a6b38c5b829ab734e9f36e5","court_id":"6a6b38c8b829ab734e9f36f0","... |
| 232 | OPS cannot append a dispute note | `POST /api/v1/admin/disputes/bookings/6a6b38cbb829ab734e9f370b/notes` | 403 | 403 | PASS | {"error":{"code":"ADMIN_ROLE_REQUIRED","message":"The ADMIN role is required for this operation","requestId":"req-4x"}} |
| 233 | ADMIN appends versioned dispute audit note | `POST /api/v1/admin/disputes/bookings/6a6b38cbb829ab734e9f370b/notes` | 200 | 200 | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","version":3} |
| 234 | Dispute note advances Booking version | `ASSERT -` | true | true | PASS | {"bookingId":"6a6b38cbb829ab734e9f370b","version":3} |
| 235 | Admin reads Court support detail | `GET /api/v1/admin/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0` | 200 | 200 | PASS | {"courtId":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"status":"AVAILABLE","bookingMode":"BOTH","minBookingMinutes":60,"bookingInc... |
| 236 | ADMIN deactivates Court with reason | `PATCH /api/v1/admin/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0` | 200 | 200 | PASS | {"courtId":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"status":"UNAVAILABLE","bookingMode":"BOTH","minBookingMinutes":60,"bookingI... |
| 237 | Unavailable Court produces no new availability | `POST /api/v1/owner/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 238 | Court deactivation blocks generation | `ASSERT -` | true | true | PASS | {"created":0} |
| 239 | SUPPORT reads derived disabled inventory health | `GET /api/v1/admin/operations/inventory-health?environment=PRODUCTION&venueId=6a6b38c5b829ab734e9f36e5&health=DISABLED` | 200 | 200 | PASS | {"items":[{"venueId":"6a6b38c5b829ab734e9f36e5","venueName":"Curl Arena One Updated","venueStatus":"ACTIVE","environment":"PRODUCTION","courtId":"6a6b38c8b829ab734e9f36f0","courtName":"Curl Court","courtStatus":"UNAVAILABLE","bookingMode":"... |
| 240 | Inventory health exposes disabled Court | `ASSERT -` | true | true | PASS | {"items":[{"venueId":"6a6b38c5b829ab734e9f36e5","venueName":"Curl Arena One Updated","venueStatus":"ACTIVE","environment":"PRODUCTION","courtId":"6a6b38c8b829ab734e9f36f0","courtName":"Curl Court","courtStatus":"UNAVAILABLE","bookingMode":"... |
| 241 | ADMIN restores Court availability | `PATCH /api/v1/admin/venues/6a6b38c5b829ab734e9f36e5/courts/6a6b38c8b829ab734e9f36f0` | 200 | 200 | PASS | {"courtId":"6a6b38c8b829ab734e9f36f0","venueId":"6a6b38c5b829ab734e9f36e5","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"status":"AVAILABLE","bookingMode":"BOTH","minBookingMinutes":60,"bookingInc... |

## Partner Webhooks

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 243 | Reject unsigned Partner request | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-55"}} |
| 244 | Reject invalid HMAC signature | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-56"}} |
| 245 | Reject stale signed timestamp | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-57"}} |
| 246 | Require HTTPS webhook URL | `POST /api/v1/partners/webhooks` | 400 | 400 | PASS | {"error":{"code":"HTTPS_WEBHOOK_REQUIRED","message":"Webhook URLs must use HTTPS","requestId":"req-58"}} |
| 247 | Register signed Partner webhook | `POST /api/v1/partners/webhooks` | 201 | 201 | PASS | {"webhookId":"6a6b38cfb829ab734e9f3740","status":"PENDING","signingSecret":"[REDACTED]","subscribedEvents":["booking.confirmed"]} |
| 248 | Reject duplicate Partner webhook | `POST /api/v1/partners/webhooks` | 409 | 409 | PASS | {"error":{"code":"WEBHOOK_ALREADY_EXISTS","message":"This webhook URL is already configured","requestId":"req-5a"}} |
| 249 | Admin verifies Partner webhook | `POST /api/v1/partners/admin/webhooks/6a6b38cfb829ab734e9f3740/verify` | 204 | 204 | PASS |  |
| 250 | Partner disables own webhook | `DELETE /api/v1/partners/webhooks/6a6b38cfb829ab734e9f3740` | 204 | 204 | PASS |  |
| 251 | Reject repeated webhook disable | `DELETE /api/v1/partners/webhooks/6a6b38cfb829ab734e9f3740` | 409 | 409 | PASS | {"error":{"code":"TRANSITION_NOT_ALLOWED","message":"The requested state transition is not allowed","requestId":"req-5d"}} |
| 253 | Reject revoked Partner key | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-5f"}} |

## Non-HTTP And Deferred Scope

Ledger remains an internal transaction boundary without arbitrary public mutation routes. Outbox insertion remains internal, while bounded read/retry monitoring is exposed through the authorized Communications Admin API. Live Firebase and outbound HTTPS are replaced by injected in-memory adapters in the cURL environment; exact signing, SSRF controls, response classification, retry scheduling, and invalid-token cleanup are covered by the automated test suite. Partner-facing availability/search, Settlement adjustments, Partner statements, Invoice workflows, and remaining Epic 09 work remain deferred SRS scope.

## Conclusion

All implemented HTTP modules and tested edge flows passed.
