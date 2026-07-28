# Full API cURL Test Report

- Executed: 2026-07-28 17:05:26 +05:30
- Target: isolated local API and temporary MongoDB database
- Media: local test adapter; no external Cloudinary writes
- Transport: curl.exe for every HTTP request
- Total checks: 112
- Passed: 112
- Failed: 0
- Sensitive tokens and secrets: redacted

## Module Summary

| Module | Checks | Passed | Failed |
|---|---:|---:|---:|
| Platform | 5 | 5 | 0 |
| Owner Identity | 12 | 12 | 0 |
| Admin Identity | 4 | 4 | 0 |
| KYC | 11 | 11 | 0 |
| Admin Onboarding | 3 | 3 | 0 |
| Owner Access | 7 | 7 | 0 |
| Venue Profile | 6 | 6 | 0 |
| Courts | 9 | 9 | 0 |
| Venue Inventory | 18 | 18 | 0 |
| Venue Content | 6 | 6 | 0 |
| Payout Accounts | 6 | 6 | 0 |
| Partner Access | 15 | 15 | 0 |
| Partner Webhooks | 10 | 10 | 0 |

## Platform

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 1 | Health endpoint | `GET /health` | 200 | 200 | PASS | {"status":"ok","service":"turf-gds-api","timestamp":"2026-07-28T11:35:19.449Z"} |
| 2 | Dependency readiness | `GET /ready` | 200 | 200 | PASS | {"status":"ready","service":"turf-gds-api","dependencies":{"mongodb":"up","cloudinary":"up"},"timestamp":"2026-07-28T11:35:19.690Z"} |
| 3 | API version discovery | `GET /api/v1` | 200 | 200 | PASS | {"service":"turf-gds-api","apiVersion":"v1"} |
| 4 | Unknown route error envelope | `GET /api/v1/not-a-route` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-4"}} |
| 5 | Unknown route has stable error code | `ASSERT -` | true | true | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-4"}} |

## Owner Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 6 | Reject malformed registration | `POST /api/v1/auth/venue-owners/register` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-5","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must NO... |
| 7 | Register first Venue Owner aggregate | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a6893f862f15ad240214095","venueId":"6a6893f862f15ad240214096","membershipId":"6a6893f862f15ad240214097","ownerStatus":"PENDING","venueStatus":"PENDING_APPROVAL"} |
| 8 | Register second isolated Venue Owner | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a6893f862f15ad240214098","venueId":"6a6893f862f15ad240214099","membershipId":"6a6893f862f15ad24021409a","ownerStatus":"PENDING","venueStatus":"PENDING_APPROVAL"} |
| 9 | Reject duplicate owner registration | `POST /api/v1/auth/venue-owners/register` | 409 | 409 | PASS | {"error":{"code":"EMAIL_ALREADY_REGISTERED","message":"An account with this email already exists","requestId":"req-8"}} |
| 10 | Reject invalid owner credentials | `POST /api/v1/auth/venue-owners/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-9"}} |
| 11 | Login first Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-04T11:35:20.538Z","owner":{"id":"6a6893f862f15ad240214095","legalName":"Curl Owner One Private Limited","email":"curl-owner-one@example.com","status":"PENDING"}} |
| 12 | Login second Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-04T11:35:20.706Z","owner":{"id":"6a6893f862f15ad240214098","legalName":"Curl Owner Two Private Limited","email":"curl-owner-two@example.com","status":"PENDING"}} |
| 13 | Reject missing owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-c"}} |
| 14 | Read authenticated owner profile | `GET /api/v1/auth/venue-owners/me` | 200 | 200 | PASS | {"id":"6a6893f862f15ad240214095","legalName":"Curl Owner One Private Limited","email":"curl-owner-one@example.com","phoneE164":"+919876540001","status":"PENDING","emailVerifiedAt":null,"memberships":[{"id":"6a6893f862f15ad240214097","venueI... |
| 15 | Owner profile contains canonical membership | `ASSERT -` | true | true | PASS | {"id":"6a6893f862f15ad240214095","legalName":"Curl Owner One Private Limited","email":"curl-owner-one@example.com","phoneE164":"+919876540001","status":"PENDING","emailVerifiedAt":null,"memberships":[{"id":"6a6893f862f15ad240214097","venueI... |
| 111 | Logout revokes owner session | `POST /api/v1/auth/venue-owners/logout` | 204 | 204 | PASS |  |
| 112 | Reject revoked owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_SESSION","message":"The provided session is invalid or has expired","requestId":"req-2s"}} |

## Admin Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 16 | Reject invalid Admin credentials | `POST /api/v1/auth/admin/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-e"}} |
| 17 | Login Admin | `POST /api/v1/auth/admin/login` | 200 | 200 | PASS | {"accessToken":"[REDACTED]","expiresAt":"2026-07-28T12:35:21.236Z","admin":{"id":"6a6893e362f15ad240214094","email":"curl-admin@example.com","displayName":"Curl Test Admin","role":"ADMIN"}} |
| 18 | Reject invalid Admin token | `GET /api/v1/auth/admin/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_ADMIN_TOKEN","message":"The admin access token is invalid or expired","requestId":"req-g"}} |
| 19 | Read Admin identity | `GET /api/v1/auth/admin/me` | 200 | 200 | PASS | {"id":"6a6893e362f15ad240214094","role":"ADMIN"} |

## KYC

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 20 | Reject owner KYC without authentication | `POST /api/v1/kyc/owner/verifications` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-i"}} |
| 21 | Create BUSINESS KYC draft | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a6893f962f15ad24021409e","subjectType":"VENUE_OWNER","subjectId":"6a6893f862f15ad240214095","verificationType":"BUSINESS","status":"DRAFT","isCurrent":true,"submittedAt":null,"reviewedAt":null,"rejectionReason":null,"expiresAt":null... |
| 22 | KYC draft creation is idempotent | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a6893f962f15ad24021409e","subjectType":"VENUE_OWNER","subjectId":"6a6893f862f15ad240214095","verificationType":"BUSINESS","status":"DRAFT","isCurrent":true,"submittedAt":null,"reviewedAt":null,"rejectionReason":null,"expiresAt":null... |
| 23 | Reject KYC submission without document | `POST /api/v1/kyc/owner/verifications/6a6893f962f15ad24021409e/submit` | 409 | 409 | PASS | {"error":{"code":"KYC_DOCUMENT_REQUIRED","message":"At least one active document is required","requestId":"req-l"}} |
| 24 | Upload protected KYC document | `POST /api/v1/kyc/owner/verifications/6a6893f962f15ad24021409e/documents?documentType=GST_CERTIFICATE` | 201 | 201 | PASS | {"documentId":"6a6893f962f15ad24021409f","status":"ACTIVE"} |
| 25 | Prevent cross-owner KYC document access | `POST /api/v1/kyc/owner/verifications/6a6893f962f15ad24021409e/documents?documentType=PAN` | 409 | 409 | PASS | {"error":{"code":"KYC_NOT_EDITABLE","message":"The KYC verification is not an editable current draft","requestId":"req-n"}} |
| 26 | Submit completed KYC | `POST /api/v1/kyc/owner/verifications/6a6893f962f15ad24021409e/submit` | 204 | 204 | PASS |  |
| 27 | Read current owner KYC | `GET /api/v1/kyc/owner/verifications/current/BUSINESS` | 200 | 200 | PASS | {"id":"6a6893f962f15ad24021409e","subjectType":"VENUE_OWNER","subjectId":"6a6893f862f15ad240214095","verificationType":"BUSINESS","status":"SUBMITTED","isCurrent":true,"submittedAt":"2026-07-28T11:35:21.787Z","reviewedAt":null,"rejectionRea... |
| 28 | Submitted KYC is current | `ASSERT -` | true | true | PASS | {"id":"6a6893f962f15ad24021409e","subjectType":"VENUE_OWNER","subjectId":"6a6893f862f15ad240214095","verificationType":"BUSINESS","status":"SUBMITTED","isCurrent":true,"submittedAt":"2026-07-28T11:35:21.787Z","reviewedAt":null,"rejectionRea... |
| 29 | Reject KYC review without Admin session | `PATCH /api/v1/kyc/admin/verifications/6a6893f962f15ad24021409e/review` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-q"}} |
| 30 | Admin verifies owner BUSINESS KYC | `PATCH /api/v1/kyc/admin/verifications/6a6893f962f15ad24021409e/review` | 204 | 204 | PASS |  |

## Admin Onboarding

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 31 | Block Venue approval without verified KYC | `POST /api/v1/admin/onboarding/venues/6a6893f862f15ad240214099/approve` | 409 | 409 | PASS | {"error":{"code":"OWNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-s"}} |
| 32 | Approve verified Venue and Owner atomically | `POST /api/v1/admin/onboarding/venues/6a6893f862f15ad240214096/approve` | 204 | 204 | PASS |  |
| 33 | Reject repeated Venue approval transition | `POST /api/v1/admin/onboarding/venues/6a6893f862f15ad240214096/approve` | 409 | 409 | PASS | {"error":{"code":"OWNER_APPROVAL_NOT_ALLOWED","message":"The Venue Owner cannot be approved","requestId":"req-u"}} |

## Owner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 34 | Prevent cross-Venue profile read | `GET /api/v1/owner/venues/6a6893f862f15ad240214096` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-v"}} |
| 35 | Add Venue manager membership | `POST /api/v1/auth/venue-owners/venues/6a6893f862f15ad240214096/members` | 201 | 201 | PASS | {"membershipId":"6a6893fa62f15ad2402140a0","status":"ACTIVE"} |
| 36 | List Venue members | `GET /api/v1/auth/venue-owners/venues/6a6893f862f15ad240214096/members` | 200 | 200 | PASS | [{"ownerId":"6a6893f862f15ad240214095","legalName":"Curl Owner One Private Limited","email":"curl-owner-one@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a6893f862f15ad240214098","legalName":"Curl Owner Two Private Limited","e... |
| 37 | Membership list includes owner and manager | `ASSERT -` | true | true | PASS | [{"ownerId":"6a6893f862f15ad240214095","legalName":"Curl Owner One Private Limited","email":"curl-owner-one@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a6893f862f15ad240214098","legalName":"Curl Owner Two Private Limited","e... |
| 38 | Canonical OWNER membership cannot be overwritten | `POST /api/v1/auth/venue-owners/venues/6a6893f862f15ad240214096/members` | 409 | 409 | PASS | {"error":{"code":"MEMBERSHIP_SELF_CHANGE_NOT_ALLOWED","message":"You cannot change your own venue membership","requestId":"req-y"}} |
| 39 | Revoke manager membership | `DELETE /api/v1/auth/venue-owners/venues/6a6893f862f15ad240214096/members/6a6893f862f15ad240214098` | 204 | 204 | PASS |  |
| 40 | Revoked manager loses Venue access | `GET /api/v1/owner/venues/6a6893f862f15ad240214096` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-10"}} |

## Venue Profile

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 41 | Read owner-scoped Venue profile | `GET /api/v1/owner/venues/6a6893f862f15ad240214096` | 200 | 200 | PASS | {"id":"6a6893f862f15ad240214096","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka","posta... |
| 42 | Reject unsupported Venue currency | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-12","details":[{"instancePath":"/currency","schemaPath":"#/properties/currency/enum","keyword":"enum","params":{"allowedValues":["INR"]},"message":"must... |
| 43 | Update Venue with optimistic version | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096` | 200 | 200 | PASS | {"id":"6a6893f862f15ad240214096","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 44 | Reject stale Venue version | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096` | 409 | 409 | PASS | {"error":{"code":"VENUE_VERSION_CONFLICT","message":"The Venue was changed by another request","requestId":"req-14","details":{"currentVersion":3}}} |
| 45 | Upload Venue media metadata | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/media?version=3` | 201 | 201 | PASS | {"id":"6a6893f862f15ad240214096","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 46 | Venue media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a6893f862f15ad240214096","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |

## Courts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 47 | Create Court | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts` | 201 | 201 | PASS | {"id":"6a6893fa62f15ad2402140a1","venueId":"6a6893f862f15ad240214096","name":"Curl Court","sportTypes":["FOOTBALL","BOX_CRICKET"],"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operatingHours":[],"timezone":"Asia/... |
| 48 | Reject duplicate Court name | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts` | 409 | 409 | PASS | {"error":{"code":"COURT_NAME_ALREADY_EXISTS","message":"A Court with this name already exists for the Venue","requestId":"req-17"}} |
| 49 | Reject invalid Court duration | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts` | 400 | 400 | PASS | {"error":{"code":"INVALID_COURT_DURATION","message":"Minimum booking must be at least 60 minutes and divisible by its increment","requestId":"req-18"}} |
| 50 | Prevent cross-owner Court detail access | `GET /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-19"}} |
| 51 | Reject invalid booking mode at route boundary | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1a","details":[{"instancePath":"/bookingMode","schemaPath":"#/properties/bookingMode/enum","keyword":"enum","params":{"allowedValues":["OPEN_TIME","FIXE... |
| 52 | Configure Court operating hours | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/operating-hours` | 200 | 200 | PASS | {"id":"6a6893fa62f15ad2402140a1","venueId":"6a6893f862f15ad240214096","name":"Curl Court","sportTypes":["FOOTBALL","BOX_CRICKET"],"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operatingHours":[{"dayOfWeek":3,"ope... |
| 53 | Reject reversed operating hours | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/operating-hours` | 400 | 400 | PASS | {"error":{"code":"INVALID_OPERATING_HOURS","message":"Opening time must be before closing time","requestId":"req-1c"}} |
| 54 | Upload Court media metadata | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/media?version=2` | 201 | 201 | PASS | {"id":"6a6893fa62f15ad2402140a1","venueId":"6a6893f862f15ad240214096","name":"Curl Court","sportTypes":["FOOTBALL","BOX_CRICKET"],"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operatingHours":[{"dayOfWeek":3,"ope... |
| 55 | Court media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a6893fa62f15ad2402140a1","venueId":"6a6893f862f15ad240214096","name":"Curl Court","sportTypes":["FOOTBALL","BOX_CRICKET"],"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operatingHours":[{"dayOfWeek":3,"ope... |

## Venue Inventory

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 56 | Reject negative pricing | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/pricing-rules` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1e","details":[{"instancePath":"/amountMinor","schemaPath":"#/properties/amountMinor/minimum","keyword":"minimum","params":{"comparison":">=","limit":0}... |
| 57 | Create pricing rule | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/pricing-rules` | 201 | 201 | PASS | {"id":"6a6893fb62f15ad2402140a4","courtId":"6a6893fa62f15ad2402140a1","name":"Weekday","daysOfWeek":[3],"startsTime":"06:00","endsTime":"08:00","amountMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":n... |
| 58 | List Court pricing rules | `GET /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/pricing-rules` | 200 | 200 | PASS | [{"id":"6a6893fb62f15ad2402140a4","courtId":"6a6893fa62f15ad2402140a1","name":"Weekday","daysOfWeek":[3],"startsTime":"06:00","endsTime":"08:00","amountMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":... |
| 59 | Pricing list preserves INR amount | `ASSERT -` | true | true | PASS | {"id":"6a6893fb62f15ad2402140a4","courtId":"6a6893fa62f15ad2402140a1","name":"Weekday","daysOfWeek":[3],"startsTime":"06:00","endsTime":"08:00","amountMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":n... |
| 60 | Deactivate pricing rule | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/pricing-rules/6a6893fb62f15ad2402140a4` | 200 | 200 | PASS | {"id":"6a6893fb62f15ad2402140a4","courtId":"6a6893fa62f15ad2402140a1","name":"Weekday","daysOfWeek":[3],"startsTime":"06:00","endsTime":"08:00","amountMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":n... |
| 61 | Inactive pricing generates no slots | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 62 | Reactivate pricing rule | `PATCH /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/pricing-rules/6a6893fb62f15ad2402140a4` | 200 | 200 | PASS | {"id":"6a6893fb62f15ad2402140a4","courtId":"6a6893fa62f15ad2402140a1","name":"Weekday","daysOfWeek":[3],"startsTime":"06:00","endsTime":"08:00","amountMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":n... |
| 63 | Generate rolling fixed slots | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/slots/generate` | 200 | 200 | PASS | {"created":2} |
| 64 | Two one-hour slots generated | `ASSERT -` | true | true | PASS | {"created":2} |
| 65 | Slot generation is idempotent | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 66 | Repeated generation creates zero duplicates | `ASSERT -` | true | true | PASS | {"created":0} |
| 67 | Read owner inventory calendar | `GET /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory?from=2026-07-29T00%3A00%3A00.000Z&to=2026-07-30T00%3A00%3A00.000Z` | 200 | 200 | PASS | [{"id":"6a6893fb62f15ad2402140a5","courtId":"6a6893fa62f15ad2402140a1","environment":"PRODUCTION","bookingMode":"FIXED_SLOT","startsAt":"2026-07-29T00:30:00.000Z","endsAt":"2026-07-29T01:30:00.000Z","priceAmountMinor":125000,"currency":"INR... |
| 68 | Block fixed Slot | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/block` | 201 | 201 | PASS | {"id":"6a6893fb62f15ad2402140a5","courtId":"6a6893fa62f15ad2402140a1","environment":"PRODUCTION","bookingMode":"FIXED_SLOT","startsAt":"2026-07-29T00:30:00.000Z","endsAt":"2026-07-29T01:30:00.000Z","priceAmountMinor":125000,"currency":"INR"... |
| 69 | Reject stale fixed Slot block | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/block` | 409 | 409 | PASS | {"error":{"code":"SLOT_BLOCK_CONFLICT","message":"Slot is held, booked, blocked, or stale","requestId":"req-1o"}} |
| 70 | Release fixed Slot | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/6a6893fb62f15ad2402140a5/release` | 200 | 200 | PASS | {"id":"6a6893fb62f15ad2402140a5","courtId":"6a6893fa62f15ad2402140a1","environment":"PRODUCTION","bookingMode":"FIXED_SLOT","startsAt":"2026-07-29T00:30:00.000Z","endsAt":"2026-07-29T01:30:00.000Z","priceAmountMinor":125000,"currency":"INR"... |
| 71 | Create transactional open-time block | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/block` | 201 | 201 | PASS | {"id":"6a6893fc62f15ad2402140a9","courtId":"6a6893fa62f15ad2402140a1","environment":"PRODUCTION","bookingMode":"OPEN_TIME","startsAt":"2026-07-29T00:30:00.000Z","endsAt":"2026-07-29T01:30:00.000Z","priceAmountMinor":0,"currency":"INR","stat... |
| 72 | Reject overlapping open-time block | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/block` | 409 | 409 | PASS | {"error":{"code":"INVENTORY_OVERLAP","message":"The interval overlaps unavailable inventory","requestId":"req-1r"}} |
| 73 | Release open-time block | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/courts/6a6893fa62f15ad2402140a1/inventory/6a6893fc62f15ad2402140a9/release` | 204 | 204 | PASS |  |

## Venue Content

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 74 | Read empty flexible content | `GET /api/v1/owner/venues/6a6893f862f15ad240214096/content` | 200 | 200 | PASS | {"venueId":"6a6893f862f15ad240214096","content":{},"version":0} |
| 75 | Missing content is represented as version zero | `ASSERT -` | true | true | PASS | {"venueId":"6a6893f862f15ad240214096","content":{},"version":0} |
| 76 | Create flexible Venue content | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/content` | 200 | 200 | PASS | {"id":"6a6893fc62f15ad2402140ab","venueId":"6a6893f862f15ad240214096","content":{"amenities":["Parking","Lights"],"policies":{"footwear":"Studs"}},"version":1,"updatedAt":"2026-07-28T11:35:24.375Z"} |
| 77 | Reject unsafe MongoDB content key | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/content` | 400 | 400 | PASS | {"error":{"code":"INVALID_VENUE_CONTENT","message":"Venue content contains an unsafe key","requestId":"req-1v"}} |
| 78 | Reject stale content version | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/content` | 409 | 409 | PASS | {"error":{"code":"CONTENT_VERSION_CONFLICT","message":"Venue content changed concurrently","requestId":"req-1w"}} |
| 79 | Update flexible content by version | `PUT /api/v1/owner/venues/6a6893f862f15ad240214096/content` | 200 | 200 | PASS | {"id":"6a6893fc62f15ad2402140ab","venueId":"6a6893f862f15ad240214096","content":{"amenities":["Parking","Lights","Washroom"]},"version":2,"updatedAt":"2026-07-28T11:35:24.495Z"} |

## Payout Accounts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 80 | Reject malformed tokenized payout metadata | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/payout-accounts` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-1y","details":[{"instancePath":"/vaultAccountToken","schemaPath":"#/properties/vaultAccountToken/minLength","keyword":"minLength","params":{"limit":12},... |
| 81 | Create pending tokenized payout account | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/payout-accounts` | 201 | 201 | PASS | {"id":"6a6893fc62f15ad2402140ac","venueId":"6a6893f862f15ad240214096","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 82 | Payout response is masked and pending | `ASSERT -` | true | true | PASS | {"id":"6a6893fc62f15ad2402140ac","venueId":"6a6893f862f15ad240214096","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 83 | Reject duplicate payout vault token | `POST /api/v1/owner/venues/6a6893f862f15ad240214096/payout-accounts` | 409 | 409 | PASS | {"error":{"code":"PAYOUT_ACCOUNT_ALREADY_EXISTS","message":"This tokenized payout account already exists","requestId":"req-20"}} |
| 84 | List masked payout accounts | `GET /api/v1/owner/venues/6a6893f862f15ad240214096/payout-accounts` | 200 | 200 | PASS | [{"id":"6a6893fc62f15ad2402140ac","venueId":"6a6893f862f15ad240214096","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifi... |
| 85 | Admin verification fields remain empty | `ASSERT -` | true | true | PASS | {"id":"6a6893fc62f15ad2402140ac","venueId":"6a6893f862f15ad240214096","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |

## Partner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 86 | Reject malformed Partner application | `POST /api/v1/partners/applications` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-22","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must N... |
| 87 | Create Partner application | `POST /api/v1/partners/applications` | 201 | 201 | PASS | {"partnerId":"6a6893fc62f15ad2402140ae","status":"ONBOARDING"} |
| 88 | Reject duplicate Partner application | `POST /api/v1/partners/applications` | 409 | 409 | PASS | {"error":{"code":"PARTNER_ALREADY_EXISTS","message":"A matching Partner application already exists","requestId":"req-24"}} |
| 89 | Reject key before sandbox approval | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/keys` | 409 | 409 | PASS | {"error":{"code":"KEY_ISSUANCE_NOT_ALLOWED","message":"The Partner is not approved for this environment","requestId":"req-25"}} |
| 90 | Approve Partner sandbox | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/approve-sandbox` | 204 | 204 | PASS |  |
| 91 | Issue sandbox Partner key | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/keys` | 201 | 201 | PASS | {"keyId":"6a6893fc62f15ad2402140b0","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"SANDBOX","scopes":["webhooks:write"]} |
| 92 | Reject production approval without KYC/review | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/approve-production` | 409 | 409 | PASS | {"error":{"code":"PARTNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-28"}} |
| 93 | Admin creates Partner BUSINESS KYC | `POST /api/v1/kyc/admin/partners/6a6893fc62f15ad2402140ae/verifications` | 201 | 201 | PASS | {"id":"6a6893fd62f15ad2402140b1","subjectType":"PARTNER","subjectId":"6a6893fc62f15ad2402140ae","verificationType":"BUSINESS","status":"DRAFT","isCurrent":true,"submittedAt":null,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 94 | Admin uploads Partner KYC document | `POST /api/v1/kyc/admin/partners/6a6893fc62f15ad2402140ae/verifications/6a6893fd62f15ad2402140b1/documents?documentType=INCORPORATION` | 201 | 201 | PASS | {"documentId":"6a6893fd62f15ad2402140b2","status":"ACTIVE"} |
| 95 | Admin submits Partner KYC | `POST /api/v1/kyc/admin/partners/6a6893fc62f15ad2402140ae/verifications/6a6893fd62f15ad2402140b1/submit` | 204 | 204 | PASS |  |
| 96 | Admin verifies Partner KYC | `PATCH /api/v1/kyc/admin/verifications/6a6893fd62f15ad2402140b1/review` | 204 | 204 | PASS |  |
| 97 | Record passed integration review | `PATCH /api/v1/partners/admin/6a6893fc62f15ad2402140ae/integration-review` | 204 | 204 | PASS |  |
| 98 | Approve Partner production | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/approve-production` | 204 | 204 | PASS |  |
| 99 | Issue production Partner key | `POST /api/v1/partners/admin/6a6893fc62f15ad2402140ae/keys` | 201 | 201 | PASS | {"keyId":"6a6893fd62f15ad2402140b3","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"PRODUCTION","scopes":["availability:read"]} |
| 109 | Admin revokes Partner key | `DELETE /api/v1/partners/admin/keys/6a6893fc62f15ad2402140b0` | 204 | 204 | PASS |  |

## Partner Webhooks

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 100 | Reject unsigned Partner request | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-2g"}} |
| 101 | Reject invalid HMAC signature | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-2h"}} |
| 102 | Reject stale signed timestamp | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-2i"}} |
| 103 | Require HTTPS webhook URL | `POST /api/v1/partners/webhooks` | 400 | 400 | PASS | {"error":{"code":"HTTPS_WEBHOOK_REQUIRED","message":"Webhook URLs must use HTTPS","requestId":"req-2j"}} |
| 104 | Register signed Partner webhook | `POST /api/v1/partners/webhooks` | 201 | 201 | PASS | {"webhookId":"6a6893fd62f15ad2402140b5","status":"PENDING_VERIFICATION","signingSecret":"[REDACTED]"} |
| 105 | Reject duplicate Partner webhook | `POST /api/v1/partners/webhooks` | 409 | 409 | PASS | {"error":{"code":"WEBHOOK_ALREADY_EXISTS","message":"This webhook URL is already configured","requestId":"req-2l"}} |
| 106 | Admin verifies Partner webhook | `POST /api/v1/partners/admin/webhooks/6a6893fd62f15ad2402140b5/verify` | 204 | 204 | PASS |  |
| 107 | Partner disables own webhook | `DELETE /api/v1/partners/webhooks/6a6893fd62f15ad2402140b5` | 204 | 204 | PASS |  |
| 108 | Reject repeated webhook disable | `DELETE /api/v1/partners/webhooks/6a6893fd62f15ad2402140b5` | 409 | 409 | PASS | {"error":{"code":"TRANSITION_NOT_ALLOWED","message":"The requested state transition is not allowed","requestId":"req-2o"}} |
| 110 | Reject revoked Partner key | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-2q"}} |

## Deferred Actor APIs

Partner availability/search and Admin payout-verification endpoints are intentionally not registered in the current Venue Owner-first phase. Their absence is architectural scope, not a cURL failure. Partner identity/onboarding/webhook APIs already present in the application were tested.

## Conclusion

All implemented HTTP modules and tested edge flows passed.
