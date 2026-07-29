# Full API cURL Test Report

- Executed: 2026-07-29 14:36:30 +05:30
- Target: isolated local API and temporary MongoDB database
- Media: local test adapter; no external Cloudinary writes
- Transport: curl.exe for every HTTP request
- Total checks: 169
- Passed: 169
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
| Payout Accounts | 6 | 6 | 0 |
| Partner Access | 15 | 15 | 0 |
| Booking Lifecycle | 30 | 30 | 0 |
| Contracts | 17 | 17 | 0 |
| Owner Bookings | 13 | 13 | 0 |
| Booking Audit | 3 | 3 | 0 |
| Partner Webhooks | 10 | 10 | 0 |

## Platform

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 1 | Health endpoint | `GET /health` | 200 | 200 | PASS | {"status":"ok","service":"turf-gds-api","timestamp":"2026-07-29T09:06:21.043Z"} |
| 2 | Dependency readiness | `GET /ready` | 200 | 200 | PASS | {"status":"ready","service":"turf-gds-api","dependencies":{"mongodb":"up","cloudinary":"up"},"timestamp":"2026-07-29T09:06:21.262Z"} |
| 3 | API version discovery | `GET /api/v1` | 200 | 200 | PASS | {"service":"turf-gds-api","apiVersion":"v1"} |
| 4 | Unknown route error envelope | `GET /api/v1/not-a-route` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-61"}} |
| 5 | Unknown route has stable error code | `ASSERT -` | true | true | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-61"}} |

## Owner Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 6 | Reject malformed registration | `POST /api/v1/auth/venue-owners/register` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-62","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must N... |
| 7 | Register first Venue Owner aggregate | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a69c28da810e845d732f07d","venueId":"6a69c28da810e845d732f07e","membershipId":"6a69c28da810e845d732f07f","ownerStatus":"ACTIVE","venueStatus":"PENDING"} |
| 8 | Register second isolated Venue Owner | `POST /api/v1/auth/venue-owners/register` | 201 | 201 | PASS | {"ownerId":"6a69c28da810e845d732f080","venueId":"6a69c28da810e845d732f081","membershipId":"6a69c28da810e845d732f082","ownerStatus":"ACTIVE","venueStatus":"PENDING"} |
| 9 | Reject duplicate owner registration | `POST /api/v1/auth/venue-owners/register` | 409 | 409 | PASS | {"error":{"code":"EMAIL_ALREADY_REGISTERED","message":"An account with this email already exists","requestId":"req-65"}} |
| 10 | Reject invalid owner credentials | `POST /api/v1/auth/venue-owners/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-66"}} |
| 11 | Login first Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-05T09:06:22.262Z","owner":{"id":"6a69c28da810e845d732f07d","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785315980956@example.com","status":"ACTIVE"}} |
| 12 | Login second Venue Owner | `POST /api/v1/auth/venue-owners/login` | 200 | 200 | PASS | {"sessionToken":"[REDACTED]","expiresAt":"2026-08-05T09:06:22.418Z","owner":{"id":"6a69c28da810e845d732f080","legalName":"Curl Owner Two Private Limited","email":"curl-owner-two-1785315980956@example.com","status":"ACTIVE"}} |
| 13 | Reject missing owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-69"}} |
| 14 | Read authenticated owner profile | `GET /api/v1/auth/venue-owners/me` | 200 | 200 | PASS | {"id":"6a69c28da810e845d732f07d","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785315980956@example.com","phoneE164":"+916315980966","status":"ACTIVE","emailVerifiedAt":null,"memberships":[{"id":"6a69c28da810e845d732... |
| 15 | Owner profile contains canonical membership | `ASSERT -` | true | true | PASS | {"id":"6a69c28da810e845d732f07d","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785315980956@example.com","phoneE164":"+916315980966","status":"ACTIVE","emailVerifiedAt":null,"memberships":[{"id":"6a69c28da810e845d732... |
| 168 | Logout revokes owner session | `POST /api/v1/auth/venue-owners/logout` | 204 | 204 | PASS |  |
| 169 | Reject revoked owner session | `GET /api/v1/auth/venue-owners/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_SESSION","message":"The provided session is invalid or has expired","requestId":"req-9r"}} |

## Admin Identity

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 16 | Reject invalid Admin credentials | `POST /api/v1/auth/admin/login` | 401 | 401 | PASS | {"error":{"code":"INVALID_CREDENTIALS","message":"Email or password is incorrect","requestId":"req-6b"}} |
| 17 | Login Admin | `POST /api/v1/auth/admin/login` | 200 | 200 | PASS | {"accessToken":"[REDACTED]","expiresAt":"2026-07-29T10:06:22.916Z","admin":{"id":"6a69c1ffa810e845d732f02b","email":"curl-admin@example.com","displayName":"Curl Test Admin","role":"ADMIN"}} |
| 18 | Reject invalid Admin token | `GET /api/v1/auth/admin/me` | 401 | 401 | PASS | {"error":{"code":"INVALID_ADMIN_TOKEN","message":"The admin access token is invalid or expired","requestId":"req-6d"}} |
| 19 | Read Admin identity | `GET /api/v1/auth/admin/me` | 200 | 200 | PASS | {"id":"6a69c1ffa810e845d732f02b","role":"ADMIN"} |

## KYC

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 20 | Reject owner KYC without authentication | `POST /api/v1/kyc/owner/verifications` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-6f"}} |
| 21 | Create BUSINESS KYC draft | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a69c28fa810e845d732f086","subjectType":"VENUE_OWNER","subjectId":"6a69c28da810e845d732f07d","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 22 | KYC draft creation is idempotent | `POST /api/v1/kyc/owner/verifications` | 201 | 201 | PASS | {"id":"6a69c28fa810e845d732f086","subjectType":"VENUE_OWNER","subjectId":"6a69c28da810e845d732f07d","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 23 | Reject KYC submission without document | `POST /api/v1/kyc/owner/verifications/6a69c28fa810e845d732f086/submit` | 409 | 409 | PASS | {"error":{"code":"KYC_DOCUMENT_REQUIRED","message":"At least one active document is required","requestId":"req-6i"}} |
| 24 | Upload protected KYC document | `POST /api/v1/kyc/owner/verifications/6a69c28fa810e845d732f086/documents?documentType=GST_CERTIFICATE` | 201 | 201 | PASS | {"documentId":"6a69c28fa810e845d732f087","status":"PENDING"} |
| 25 | Prevent cross-owner KYC document access | `POST /api/v1/kyc/owner/verifications/6a69c28fa810e845d732f086/documents?documentType=PAN` | 409 | 409 | PASS | {"error":{"code":"KYC_NOT_EDITABLE","message":"The KYC verification is not an editable current draft","requestId":"req-6k"}} |
| 26 | Submit completed KYC | `POST /api/v1/kyc/owner/verifications/6a69c28fa810e845d732f086/submit` | 204 | 204 | PASS |  |
| 27 | Read current owner KYC | `GET /api/v1/kyc/owner/verifications/current/BUSINESS` | 200 | 200 | PASS | {"id":"6a69c28fa810e845d732f086","subjectType":"VENUE_OWNER","subjectId":"6a69c28da810e845d732f07d","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 28 | Submitted KYC is pending review | `ASSERT -` | true | true | PASS | {"id":"6a69c28fa810e845d732f086","subjectType":"VENUE_OWNER","subjectId":"6a69c28da810e845d732f07d","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 29 | Reject KYC review without Admin session | `PATCH /api/v1/kyc/admin/verifications/6a69c28fa810e845d732f086/review` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-6n"}} |
| 30 | Admin verifies owner BUSINESS KYC | `PATCH /api/v1/kyc/admin/verifications/6a69c28fa810e845d732f086/review` | 204 | 204 | PASS |  |

## Admin Onboarding

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 31 | Block Venue approval without verified KYC | `POST /api/v1/admin/onboarding/venues/6a69c28da810e845d732f081/approve` | 409 | 409 | PASS | {"error":{"code":"OWNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-6p"}} |
| 32 | Approve verified Venue and Owner atomically | `POST /api/v1/admin/onboarding/venues/6a69c28da810e845d732f07e/approve` | 204 | 204 | PASS |  |
| 33 | Reject repeated Venue approval transition | `POST /api/v1/admin/onboarding/venues/6a69c28da810e845d732f07e/approve` | 409 | 409 | PASS | {"error":{"code":"VENUE_APPROVAL_NOT_ALLOWED","message":"The Venue cannot be approved","requestId":"req-6r"}} |

## Owner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 34 | Prevent cross-Venue profile read | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-6s"}} |
| 35 | Add Venue manager membership | `POST /api/v1/auth/venue-owners/venues/6a69c28da810e845d732f07e/members` | 201 | 201 | PASS | {"membershipId":"6a69c28fa810e845d732f089","status":"ACTIVE"} |
| 36 | List Venue members | `GET /api/v1/auth/venue-owners/venues/6a69c28da810e845d732f07e/members` | 200 | 200 | PASS | [{"ownerId":"6a69c28da810e845d732f07d","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785315980956@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a69c28da810e845d732f080","legalName":"Curl Owner Two Priva... |
| 37 | Membership list includes owner and manager | `ASSERT -` | true | true | PASS | [{"ownerId":"6a69c28da810e845d732f07d","legalName":"Curl Owner One Private Limited","email":"curl-owner-one-1785315980956@example.com","role":"OWNER","status":"ACTIVE"},{"ownerId":"6a69c28da810e845d732f080","legalName":"Curl Owner Two Priva... |
| 38 | Canonical OWNER membership cannot be overwritten | `POST /api/v1/auth/venue-owners/venues/6a69c28da810e845d732f07e/members` | 409 | 409 | PASS | {"error":{"code":"MEMBERSHIP_SELF_CHANGE_NOT_ALLOWED","message":"You cannot change your own venue membership","requestId":"req-6v"}} |
| 39 | Revoke manager membership | `DELETE /api/v1/auth/venue-owners/venues/6a69c28da810e845d732f07e/members/6a69c28da810e845d732f080` | 204 | 204 | PASS |  |
| 40 | Revoked manager loses Venue access | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-6x"}} |

## Venue Profile

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 41 | Read owner-scoped Venue profile | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e` | 200 | 200 | PASS | {"id":"6a69c28da810e845d732f07e","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka","posta... |
| 42 | Reject unsupported Venue currency | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-6z","details":[{"instancePath":"/currency","schemaPath":"#/properties/currency/enum","keyword":"enum","params":{"allowedValues":["INR"]},"message":"must... |
| 43 | Update Venue with optimistic version | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e` | 200 | 200 | PASS | {"id":"6a69c28da810e845d732f07e","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 44 | Reject stale Venue version | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e` | 409 | 409 | PASS | {"error":{"code":"VENUE_VERSION_CONFLICT","message":"The Venue was changed by another request","requestId":"req-71","details":{"currentVersion":3}}} |
| 45 | Upload Venue media metadata | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/media?version=3` | 201 | 201 | PASS | {"id":"6a69c28da810e845d732f07e","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |
| 46 | Venue media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a69c28da810e845d732f07e","legalName":"Curl Arena One Private Limited","displayName":"Curl Arena One Updated","environment":"PRODUCTION","timezone":"Asia/Kolkata","address":{"line1":"1 Test Road","city":"Bengaluru","state":"Karnataka... |

## Courts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 47 | Create Court | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts` | 201 | 201 | PASS | {"id":"6a69c290a810e845d732f08a","venueId":"6a69c28da810e845d732f07e","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 48 | Reject duplicate Court name | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts` | 409 | 409 | PASS | {"error":{"code":"COURT_NAME_ALREADY_EXISTS","message":"A Court with this name already exists for the Venue","requestId":"req-74"}} |
| 49 | Reject invalid Court duration | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts` | 400 | 400 | PASS | {"error":{"code":"INVALID_COURT_DURATION","message":"Minimum booking must be at least 60 minutes and divisible by its increment","requestId":"req-75"}} |
| 50 | Prevent cross-owner Court detail access | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-76"}} |
| 51 | Reject invalid booking mode at route boundary | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-77","details":[{"instancePath":"/bookingMode","schemaPath":"#/properties/bookingMode/enum","keyword":"enum","params":{"allowedValues":["OPEN_TIME","FIXE... |
| 52 | Configure Court operating hours | `PUT /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/operating-hours` | 200 | 200 | PASS | {"id":"6a69c290a810e845d732f08a","venueId":"6a69c28da810e845d732f07e","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 53 | Reject reversed operating hours | `PUT /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/operating-hours` | 400 | 400 | PASS | {"error":{"code":"INVALID_OPERATING_HOURS","message":"Opening time must be before closing time","requestId":"req-79"}} |
| 54 | Upload Court media metadata | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/media?version=2` | 201 | 201 | PASS | {"id":"6a69c290a810e845d732f08a","venueId":"6a69c28da810e845d732f07e","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |
| 55 | Court media increments aggregate version | `ASSERT -` | true | true | PASS | {"id":"6a69c290a810e845d732f08a","venueId":"6a69c28da810e845d732f07e","name":"Curl Court","sportType":"FOOTBALL","surfaceType":"ARTIFICIAL_TURF","capacity":14,"bookingMode":"BOTH","minBookingMinutes":60,"bookingIncrementMinutes":30,"operati... |

## Venue Inventory

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 56 | Reject negative pricing | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/pricing-rules` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-7b","details":[{"instancePath":"/priceMinor","schemaPath":"#/properties/priceMinor/minimum","keyword":"minimum","params":{"comparison":">=","limit":0},"... |
| 57 | Create pricing rule | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/pricing-rules` | 201 | 201 | PASS | {"id":"6a69c290a810e845d732f08d","courtId":"6a69c290a810e845d732f08a","name":"Weekday","dayOfWeek":4,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":null,"p... |
| 58 | List Court pricing rules | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/pricing-rules` | 200 | 200 | PASS | [{"id":"6a69c290a810e845d732f08d","courtId":"6a69c290a810e845d732f08a","name":"Weekday","dayOfWeek":4,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":null,"... |
| 59 | Pricing list preserves INR amount | `ASSERT -` | true | true | PASS | {"id":"6a69c290a810e845d732f08d","courtId":"6a69c290a810e845d732f08a","name":"Weekday","dayOfWeek":4,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":null,"p... |
| 60 | Deactivate pricing rule | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/pricing-rules/6a69c290a810e845d732f08d` | 200 | 200 | PASS | {"id":"6a69c290a810e845d732f08d","courtId":"6a69c290a810e845d732f08a","name":"Weekday","dayOfWeek":4,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":null,"p... |
| 61 | Inactive pricing generates no slots | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 62 | Reactivate pricing rule | `PATCH /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/pricing-rules/6a69c290a810e845d732f08d` | 200 | 200 | PASS | {"id":"6a69c290a810e845d732f08d","courtId":"6a69c290a810e845d732f08a","name":"Weekday","dayOfWeek":4,"startTime":"06:00","endTime":"08:00","priceMinor":125000,"currency":"INR","effectiveFrom":"2026-01-01T00:00:00.000Z","effectiveTo":null,"p... |
| 63 | Generate rolling fixed slots | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/slots/generate` | 200 | 200 | PASS | {"created":2} |
| 64 | Two one-hour slots generated | `ASSERT -` | true | true | PASS | {"created":2} |
| 65 | Slot generation is idempotent | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/slots/generate` | 200 | 200 | PASS | {"created":0} |
| 66 | Repeated generation creates zero duplicates | `ASSERT -` | true | true | PASS | {"created":0} |
| 67 | Read owner inventory calendar | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory?from=2026-07-30T00%3A00%3A00.000Z&to=2026-07-31T00%3A00%3A00.000Z` | 200 | 200 | PASS | [{"id":"6a69c290a810e845d732f08e","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":125000,"currency":"INR","sta... |
| 68 | Block fixed Slot | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/block` | 201 | 201 | PASS | {"id":"6a69c290a810e845d732f08e","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 69 | Reject stale fixed Slot block | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/block` | 409 | 409 | PASS | {"error":{"code":"SLOT_BLOCK_CONFLICT","message":"Slot is held, booked, blocked, or stale","requestId":"req-7l"}} |
| 70 | Release fixed Slot | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/6a69c290a810e845d732f08e/release` | 200 | 200 | PASS | {"id":"6a69c290a810e845d732f08e","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 71 | Create transactional open-time block | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/block` | 201 | 201 | PASS | {"id":"6a69c291a810e845d732f092","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"OPEN_TIME","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":null,"currency":"INR","status"... |
| 72 | Reject overlapping open-time block | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/block` | 409 | 409 | PASS | {"error":{"code":"INVENTORY_OVERLAP","message":"The interval overlaps unavailable inventory","requestId":"req-7o"}} |
| 73 | Release open-time block | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory/6a69c291a810e845d732f092/release` | 204 | 204 | PASS |  |

## Payout Accounts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 74 | Reject malformed tokenized payout metadata | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/payout-accounts` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-7q","details":[{"instancePath":"/vaultAccountToken","schemaPath":"#/properties/vaultAccountToken/minLength","keyword":"minLength","params":{"limit":12},... |
| 75 | Create pending tokenized payout account | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/payout-accounts` | 201 | 201 | PASS | {"id":"6a69c291a810e845d732f094","venueId":"6a69c28da810e845d732f07e","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 76 | Payout response is masked and pending | `ASSERT -` | true | true | PASS | {"id":"6a69c291a810e845d732f094","venueId":"6a69c28da810e845d732f07e","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |
| 77 | Reject duplicate payout vault token | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/payout-accounts` | 409 | 409 | PASS | {"error":{"code":"PAYOUT_ACCOUNT_ALREADY_EXISTS","message":"This tokenized payout account already exists","requestId":"req-7s"}} |
| 78 | List masked payout accounts | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/payout-accounts` | 200 | 200 | PASS | [{"id":"6a69c291a810e845d732f094","venueId":"6a69c28da810e845d732f07e","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifi... |
| 79 | Admin verification fields remain empty | `ASSERT -` | true | true | PASS | {"id":"6a69c291a810e845d732f094","venueId":"6a69c28da810e845d732f07e","accountHolderName":"Curl Arena Pvt Ltd","vaultProvider":"bank-vault","accountLast4":"6789","bankName":"Example Bank","ifscCode":"ABCD0123456","status":"PENDING","verifie... |

## Partner Access

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 80 | Reject malformed Partner application | `POST /api/v1/partners/applications` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-7u","details":[{"instancePath":"/legalName","schemaPath":"#/properties/legalName/minLength","keyword":"minLength","params":{"limit":2},"message":"must N... |
| 81 | Create Partner application | `POST /api/v1/partners/applications` | 201 | 201 | PASS | {"partnerId":"6a69c291a810e845d732f096","status":"PENDING"} |
| 82 | Reject duplicate Partner application | `POST /api/v1/partners/applications` | 409 | 409 | PASS | {"error":{"code":"PARTNER_ALREADY_EXISTS","message":"A matching Partner application already exists","requestId":"req-7w"}} |
| 83 | Reject key before sandbox approval | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/keys` | 409 | 409 | PASS | {"error":{"code":"KEY_ISSUANCE_NOT_ALLOWED","message":"The Partner is not approved for this environment","requestId":"req-7x"}} |
| 84 | Approve Partner sandbox | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/approve-sandbox` | 204 | 204 | PASS |  |
| 85 | Issue sandbox Partner key | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/keys` | 201 | 201 | PASS | {"keyId":"6a69c291a810e845d732f099","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"SANDBOX","scopes":["webhooks:write"]} |
| 86 | Reject production approval without KYC/review | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/approve-production` | 409 | 409 | PASS | {"error":{"code":"PARTNER_KYC_REQUIRED","message":"Verified BUSINESS KYC is required","requestId":"req-80"}} |
| 87 | Admin creates Partner BUSINESS KYC | `POST /api/v1/kyc/admin/partners/6a69c291a810e845d732f096/verifications` | 201 | 201 | PASS | {"id":"6a69c291a810e845d732f09a","subjectType":"PARTNER","subjectId":"6a69c291a810e845d732f096","verificationType":"BUSINESS","status":"PENDING","isCurrent":true,"reviewedAt":null,"rejectionReason":null,"expiresAt":null} |
| 88 | Admin uploads Partner KYC document | `POST /api/v1/kyc/admin/partners/6a69c291a810e845d732f096/verifications/6a69c291a810e845d732f09a/documents?documentType=BUSINESS_REGISTRATION` | 201 | 201 | PASS | {"documentId":"6a69c291a810e845d732f09b","status":"PENDING"} |
| 89 | Admin submits Partner KYC | `POST /api/v1/kyc/admin/partners/6a69c291a810e845d732f096/verifications/6a69c291a810e845d732f09a/submit` | 204 | 204 | PASS |  |
| 90 | Admin verifies Partner KYC | `PATCH /api/v1/kyc/admin/verifications/6a69c291a810e845d732f09a/review` | 204 | 204 | PASS |  |
| 91 | Record passed integration review | `PATCH /api/v1/partners/admin/6a69c291a810e845d732f096/integration-review` | 204 | 204 | PASS |  |
| 92 | Approve Partner production | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/approve-production` | 204 | 204 | PASS |  |
| 93 | Issue production Partner key | `POST /api/v1/partners/admin/6a69c291a810e845d732f096/keys` | 201 | 201 | PASS | {"keyId":"6a69c292a810e845d732f09f","apiKey":"[REDACTED]","signingSecret":"[REDACTED]","environment":"PRODUCTION","scopes":["availability:read","bookings:write"]} |
| 166 | Admin revokes Partner key | `DELETE /api/v1/partners/admin/keys/6a69c291a810e845d732f099` | 204 | 204 | PASS |  |

## Booking Lifecycle

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 94 | Reject booking before effective Contract exists | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"ACTIVE_CONTRACT_NOT_FOUND","message":"No effective Partner-Venue contract was found","requestId":"req-88"}} |
| 108 | Reject unsigned fixed-slot hold | `POST /api/v1/bookings/hold` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-8j"}} |
| 109 | Reject Partner key without bookings write scope | `POST /api/v1/bookings/hold` | 403 | 403 | PASS | {"error":{"code":"PARTNER_SCOPE_REQUIRED","message":"The bookings:write scope is required","requestId":"req-8k"}} |
| 110 | Reject incomplete fixed-slot hold shape | `POST /api/v1/bookings/hold` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-8l","details":[{"instancePath":"","schemaPath":"#/oneOf/0/required","keyword":"required","params":{"missingProperty":"slotId"},"message":"must have requ... |
| 111 | Hold available fixed Slot | `POST /api/v1/bookings/hold` | 201 | 201 | PASS | {"holdId":"57f1338d-e5b9-45bc-879f-131b5ce3ca16","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-0... |
| 112 | Fixed hold returns durable identifiers, price, and expiry | `ASSERT -` | true | true | PASS | {"holdId":"57f1338d-e5b9-45bc-879f-131b5ce3ca16","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-0... |
| 113 | Reject a competing fixed-slot hold | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"SLOT_NOT_AVAILABLE","message":"Slot is already held, booked, blocked, or unavailable","requestId":"req-8n"}} |
| 114 | Require Idempotency-Key for confirmation | `POST /api/v1/bookings/confirm` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-8o","details":[{"instancePath":"","schemaPath":"#/required","keyword":"required","params":{"missingProperty":"idempotency-key"},"message":"must have req... |
| 115 | Confirm fixed-slot Booking | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a69c293a810e845d732f0a6","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:3... |
| 116 | Confirmation snapshots correct commercial amounts | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c293a810e845d732f0a6","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:3... |
| 117 | Replay fixed confirmation idempotently | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a69c293a810e845d732f0a6","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:3... |
| 118 | Confirmation replay returns original Booking | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c293a810e845d732f0a6","slotId":"6a69c290a810e845d732f08e","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:3... |
| 119 | Reject confirmation key reuse with changed content | `POST /api/v1/bookings/confirm` | 409 | 409 | PASS | {"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"Idempotency key was already used with a different request","requestId":"req-8r"}} |
| 120 | Reject hold on an already booked Slot | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"SLOT_NOT_AVAILABLE","message":"Slot is already held, booked, blocked, or unavailable","requestId":"req-8s"}} |
| 134 | Require Idempotency-Key for cancellation | `POST /api/v1/bookings/6a69c293a810e845d732f0a6/cancel` | 400 | 400 | PASS | {"error":{"code":"VALIDATION_ERROR","message":"The request is invalid","requestId":"req-91","details":[{"instancePath":"","schemaPath":"#/required","keyword":"required","params":{"missingProperty":"idempotency-key"},"message":"must have req... |
| 135 | Cancel confirmed fixed-slot Booking | `POST /api/v1/bookings/6a69c293a810e845d732f0a6/cancel` | 201 | 201 | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:28.437Z"} |
| 136 | Cancellation applies snapshotted refund and releases inventory | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:28.437Z"} |
| 137 | Replay cancellation idempotently | `POST /api/v1/bookings/6a69c293a810e845d732f0a6/cancel` | 201 | 201 | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:28.437Z"} |
| 138 | Cancellation replay returns original result | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:28.437Z"} |
| 139 | Reject cancellation key reuse with changed content | `POST /api/v1/bookings/6a69c293a810e845d732f0a6/cancel` | 409 | 409 | PASS | {"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"Idempotency key was already used with a different request","requestId":"req-94"}} |
| 145 | Read inventory after fixed cancellation | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/courts/6a69c290a810e845d732f08a/inventory?from=2026-07-30T00%3A00%3A00.000Z&to=2026-07-31T00%3A00%3A00.000Z` | 200 | 200 | PASS | [{"id":"6a69c290a810e845d732f08e","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":125000,"currency":"INR","sta... |
| 146 | Cancelled fixed Slot is available for resale | `ASSERT -` | true | true | PASS | {"id":"6a69c290a810e845d732f08e","courtId":"6a69c290a810e845d732f08a","environment":"PRODUCTION","bookingType":"FIXED_SLOT","startsAt":"2026-07-30T00:30:00.000Z","endsAt":"2026-07-30T01:30:00.000Z","priceMinor":125000,"currency":"INR","stat... |
| 147 | Reject open-time duration below minimum | `POST /api/v1/bookings/hold` | 400 | 400 | PASS | {"error":{"code":"INVALID_BOOKING_DURATION","message":"Duration must be at least 60 minutes and follow 30-minute increments","requestId":"req-99"}} |
| 148 | Hold valid open-time interval | `POST /api/v1/bookings/hold` | 201 | 201 | PASS | {"holdId":"74bca003-786c-423f-8201-3308341bf2dd","slotId":"6a69c295a810e845d732f0be","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"OPEN_TIME","startsAt":"2026-07-30T01:30:00.000Z","endsAt":"2026-07... |
| 149 | Open-time hold calculates the hourly price | `ASSERT -` | true | true | PASS | {"holdId":"74bca003-786c-423f-8201-3308341bf2dd","slotId":"6a69c295a810e845d732f0be","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"OPEN_TIME","startsAt":"2026-07-30T01:30:00.000Z","endsAt":"2026-07... |
| 150 | Reject overlapping open-time hold | `POST /api/v1/bookings/hold` | 409 | 409 | PASS | {"error":{"code":"INVENTORY_OVERLAP","message":"The requested interval overlaps unavailable inventory","requestId":"req-9b"}} |
| 151 | Confirm open-time Booking | `POST /api/v1/bookings/confirm` | 201 | 201 | PASS | {"bookingId":"6a69c295a810e845d732f0c1","slotId":"6a69c295a810e845d732f0be","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"OPEN_TIME","startsAt":"2026-07-30T01:30:00.000Z","endsAt":"2026-07-30T02:30... |
| 152 | Open-time confirmation uses currently effective version 1 | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c295a810e845d732f0c1","slotId":"6a69c295a810e845d732f0be","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","bookingType":"OPEN_TIME","startsAt":"2026-07-30T01:30:00.000Z","endsAt":"2026-07-30T02:30... |
| 153 | Cancel open-time Booking | `POST /api/v1/bookings/6a69c295a810e845d732f0c1/cancel` | 201 | 201 | PASS | {"bookingId":"6a69c295a810e845d732f0c1","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:29.220Z"} |
| 154 | Open-time cancellation releases provisional inventory | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c295a810e845d732f0c1","status":"CANCELLED","refundPercent":80,"refundAmountMinor":100000,"currency":"INR","slotDisposition":"RELEASE_TO_INVENTORY","cancelledAt":"2026-07-29T09:06:29.220Z"} |

## Contracts

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 95 | Require Admin authentication for Contract list | `GET /api/v1/admin/contracts` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-89"}} |
| 96 | Reject Contract for an unknown Partner | `POST /api/v1/admin/contracts` | 409 | 409 | PASS | {"error":{"code":"CONTRACT_PARTNER_NOT_ELIGIBLE","message":"Partner must be ACTIVE","requestId":"req-8a"}} |
| 97 | Reject commission and tax above 100 percent | `POST /api/v1/admin/contracts` | 400 | 400 | PASS | {"error":{"code":"INVALID_CONTRACT_TERMS","message":"Commission and tax must total at most 100 percent","requestId":"req-8b"}} |
| 98 | Reject duplicate refund thresholds | `POST /api/v1/admin/contracts` | 400 | 400 | PASS | {"error":{"code":"INVALID_CONTRACT_TERMS","message":"Refund-rule thresholds must be unique non-negative integers","requestId":"req-8c"}} |
| 99 | Create effective Contract version 1 | `POST /api/v1/admin/contracts` | 201 | 201 | PASS | {"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 100 | Version 1 preserves commercial and cancellation terms | `ASSERT -` | true | true | PASS | {"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 101 | Read Contract detail | `GET /api/v1/admin/contracts/6a69c292a810e845d732f0a1` | 200 | 200 | PASS | {"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 102 | Contract detail matches created relationship | `ASSERT -` | true | true | PASS | {"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 103 | Filter Contract versions by Partner and Venue | `GET /api/v1/admin/contracts?partnerId=6a69c291a810e845d732f096&venueId=6a69c28da810e845d732f07e` | 200 | 200 | PASS | [{"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes"... |
| 104 | Filtered Contract list contains version 1 | `ASSERT -` | true | true | PASS | {"id":"6a69c292a810e845d732f0a1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":1000,"taxRateBps":180,"settlementCycle":"WEEKLY","settlementLagDays":2,"allowedBookingModes":... |
| 105 | Reject a non-increasing effective date | `POST /api/v1/admin/contracts` | 409 | 409 | PASS | {"error":{"code":"CONTRACT_EFFECTIVE_DATE_CONFLICT","message":"A new contract version must start after the latest version","requestId":"req-8g"}} |
| 106 | Return not found for unknown Contract detail | `GET /api/v1/admin/contracts/000000000000000000000002` | 404 | 404 | PASS | {"error":{"code":"CONTRACT_NOT_FOUND","message":"Partner-Venue contract was not found","requestId":"req-8h"}} |
| 107 | Expose no Venue Owner Contract mutation route | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/contracts` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-8i"}} |
| 128 | Create future Contract version 2 | `POST /api/v1/admin/contracts` | 201 | 201 | PASS | {"id":"6a69c294a810e845d732f0b1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes"... |
| 129 | Future Contract increments immutable terms version | `ASSERT -` | true | true | PASS | {"id":"6a69c294a810e845d732f0b1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes"... |
| 130 | List complete Contract version history | `GET /api/v1/admin/contracts?partnerId=6a69c291a810e845d732f096&venueId=6a69c28da810e845d732f07e` | 200 | 200 | PASS | [{"id":"6a69c294a810e845d732f0b1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes... |
| 131 | Version 1 is closed at version 2 effective time | `ASSERT -` | true | true | PASS | [{"id":"6a69c294a810e845d732f0b1","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","status":"ACTIVE","commissionRateBps":2000,"taxRateBps":360,"settlementCycle":"MONTHLY","settlementLagDays":5,"allowedBookingModes... |

## Owner Bookings

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 121 | List confirmed Venue bookings with filters | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings?courtId=6a69c290a810e845d732f08a&status=CONFIRMED&page=1&limit=10` | 200 | 200 | PASS | {"items":[{"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environ... |
| 122 | Owner list exposes Partner reference and scoped Booking | `ASSERT -` | true | true | PASS | {"items":[{"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environ... |
| 123 | Prevent cross-Venue Owner booking access | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings` | 403 | 403 | PASS | {"error":{"code":"PERMISSION_DENIED","message":"You do not have permission for this venue","requestId":"req-8u"}} |
| 124 | Reject an inverted booking date filter | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings?from=2026-07-31T00%3A00%3A00.000Z&to=2026-07-30T00%3A00%3A00.000Z` | 400 | 400 | PASS | {"error":{"code":"INVALID_BOOKING_DATE_RANGE","message":"The booking filter start must be before its end","requestId":"req-8v"}} |
| 125 | Expose no Venue Owner booking creation route | `POST /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings` | 404 | 404 | PASS | {"error":{"code":"ROUTE_NOT_FOUND","message":"The requested route does not exist","requestId":"req-8w"}} |
| 126 | Read confirmed Booking detail | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings/6a69c293a810e845d732f0a6` | 200 | 200 | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 127 | Booking detail references Contract version 1 | `ASSERT -` | true | true | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 132 | Read Booking after future Contract change | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings/6a69c293a810e845d732f0a6` | 200 | 200 | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 133 | Existing Booking commercial snapshot remains unchanged | `ASSERT -` | true | true | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 140 | Read cancellation outcome in Owner detail | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings/6a69c293a810e845d732f0a6` | 200 | 200 | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 141 | Owner detail contains cancellation reason and refund | `ASSERT -` | true | true | PASS | {"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environment":"PRO... |
| 155 | Filter cancelled Venue bookings | `GET /api/v1/owner/venues/6a69c28da810e845d732f07e/bookings?status=CANCELLED&limit=10` | 200 | 200 | PASS | {"items":[{"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environ... |
| 156 | Owner sees both cancelled booking modes | `ASSERT -` | true | true | PASS | {"items":[{"id":"6a69c293a810e845d732f0a6","partnerId":"6a69c291a810e845d732f096","venueId":"6a69c28da810e845d732f07e","courtId":"6a69c290a810e845d732f08a","slotId":"6a69c290a810e845d732f08e","contractId":"6a69c292a810e845d732f0a1","environ... |

## Booking Audit

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 142 | Require Admin authentication for Booking audit | `GET /api/v1/bookings/admin/6a69c293a810e845d732f0a6/audit` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-96"}} |
| 143 | Read chronological Booking audit trail | `GET /api/v1/bookings/admin/6a69c293a810e845d732f0a6/audit` | 200 | 200 | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","auditHistory":[{"eventType":"BOOKING_CONFIRMED","actorType":"PARTNER","actorId":"6a69c291a810e845d732f096","correlationId":"req-8p","changes":{"previous_status":null,"new_status"... |
| 144 | Audit contains confirmation then cancellation | `ASSERT -` | true | true | PASS | {"bookingId":"6a69c293a810e845d732f0a6","status":"CANCELLED","auditHistory":[{"eventType":"BOOKING_CONFIRMED","actorType":"PARTNER","actorId":"6a69c291a810e845d732f096","correlationId":"req-8p","changes":{"previous_status":null,"new_status"... |

## Partner Webhooks

| # | Test case | Request | Expected | Actual | Result | Evidence |
|---:|---|---|---:|---:|---|---|
| 157 | Reject unsigned Partner request | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"AUTHENTICATION_REQUIRED","message":"Valid authentication is required","requestId":"req-9f"}} |
| 158 | Reject invalid HMAC signature | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-9g"}} |
| 159 | Reject stale signed timestamp | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-9h"}} |
| 160 | Require HTTPS webhook URL | `POST /api/v1/partners/webhooks` | 400 | 400 | PASS | {"error":{"code":"HTTPS_WEBHOOK_REQUIRED","message":"Webhook URLs must use HTTPS","requestId":"req-9i"}} |
| 161 | Register signed Partner webhook | `POST /api/v1/partners/webhooks` | 201 | 201 | PASS | {"webhookId":"6a69c295a810e845d732f0d2","status":"PENDING","signingSecret":"[REDACTED]"} |
| 162 | Reject duplicate Partner webhook | `POST /api/v1/partners/webhooks` | 409 | 409 | PASS | {"error":{"code":"WEBHOOK_ALREADY_EXISTS","message":"This webhook URL is already configured","requestId":"req-9k"}} |
| 163 | Admin verifies Partner webhook | `POST /api/v1/partners/admin/webhooks/6a69c295a810e845d732f0d2/verify` | 204 | 204 | PASS |  |
| 164 | Partner disables own webhook | `DELETE /api/v1/partners/webhooks/6a69c295a810e845d732f0d2` | 204 | 204 | PASS |  |
| 165 | Reject repeated webhook disable | `DELETE /api/v1/partners/webhooks/6a69c295a810e845d732f0d2` | 409 | 409 | PASS | {"error":{"code":"TRANSITION_NOT_ALLOWED","message":"The requested state transition is not allowed","requestId":"req-9n"}} |
| 167 | Reject revoked Partner key | `POST /api/v1/partners/webhooks` | 401 | 401 | PASS | {"error":{"code":"INVALID_PARTNER_AUTHENTICATION","message":"Partner API authentication failed","requestId":"req-9p"}} |

## Deferred Actor APIs

Partner availability/search and Admin payout-verification endpoints are intentionally not registered in the current Venue Owner-first phase. Their absence is architectural scope, not a cURL failure. Partner identity/onboarding/webhook APIs already present in the application were tested.

## Booking And Contracts Assessment

- Target-module checks: 63
- Target-module passed: 63
- Target-module failed: 0
- Booking Lifecycle: 30/30
- Owner Bookings: 13/13
- Booking Audit: 3/3
- Contracts: 17/17
- Isolated test API errors: none

| Story | HTTP evidence |
|---|---|
| US-04.01 Hold Availability | Fixed-slot and open-time holds, validation, scope enforcement, missing Contract rejection, competing hold rejection, overlap rejection, price and expiry response |
| US-04.02 Confirm Booking Idempotently | Required key, successful confirmation, same-request replay, changed-request key reuse rejection, booked-slot rejection |
| US-04.03 Capture Booking Commercial Amounts | Gross 125000, commission 12500, tax 2250, Venue net 110250; Booking retained Contract version 1 amounts after future version 2 was created |
| US-04.04 Cancel Booking | Fixed-slot and open-time cancellation, 80 percent refund, 100000 refund amount, inventory release, replay, changed-request key reuse rejection |
| US-04.05 Owner Dashboard Booking View | Venue/court/status filtering, Partner reference visibility, detail and cancellation outcome, cross-Venue denial, invalid date range, no Owner create route |
| US-04.06 Booking Audit Trail | Admin authentication and chronological confirmation/cancellation history |
| US-08.03 Configure Partner Venue Contract | Eligibility, financial and refund validation, create/read/filter, effective-date conflict, immutable version 2 history, historical Booking linkage |

### Limits Of Sequential cURL Evidence

- Simultaneous hold/confirmation races require concurrent integration tests; sequential cURL verifies the resulting conflict paths but does not prove two requests raced.
- Transaction rollback across Booking, Slot, Ledger, idempotency, and Outbox requires fault-injection or persistence integration tests because no public read API exposes every participating collection.
- Expired-hold recovery and two-year audit retention are time-dependent worker/retention concerns and were not accelerated in this HTTP run.
- The isolated server bootstraps only an `ADMIN`, so authenticated `OPS`/`SUPPORT` Contract-read and non-ADMIN mutation-denial cases remain route/unit-test concerns.

### Documentation Drift

`docs/contracts-api.md` says weekly and monthly cycles require `dayOfWeek` or
`dayOfMonth`. The current Contract route, service, SRS acceptance criteria, and
ERD-backed type expose `settlementCycle` plus `settlementLagDays` only. This is
a documentation mismatch, not a failed HTTP behavior, and should be reconciled
with the canonical design decision.

## Conclusion

All implemented HTTP modules and tested edge flows passed.
