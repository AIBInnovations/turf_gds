# Identity API

All routes are under `/api/v1`.

## Venue Owners

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| POST | `/auth/venue-owners/register` | Public | Create owner, initial venue, and OWNER membership |
| POST | `/auth/venue-owners/login` | Public | Create a bounded hashed session |
| GET | `/auth/venue-owners/me` | Owner Bearer token | Profile, memberships, roles, and permissions |
| POST | `/auth/venue-owners/logout` | Owner Bearer token | Revoke the current embedded session |
| GET | `/auth/venue-owners/venues/:venueId/members` | Owner Bearer token | List active members when the actor has `MANAGE_MEMBERS` |
| POST | `/auth/venue-owners/venues/:venueId/members` | Owner Bearer token | Add or reactivate MANAGER/STAFF membership |
| DELETE | `/auth/venue-owners/venues/:venueId/members/:memberOwnerId` | Owner Bearer token | Revoke a membership |

Owner authentication uses:

```http
Authorization: Bearer <session-token>
```

The raw session token is returned once. Only its SHA-256 hash is stored in
`VenueOwner.sessions`.

Member assignment accepts an existing `VenueOwner` identifier. It never creates
a dangling identity, never changes or revokes the canonical `OWNER`
membership, and always requires `MANAGE_MEMBERS` for the requested Venue.
Cross-venue membership access is rejected.

Email verification, password recovery, and invitation-token delivery are not
part of the canonical v1 schema or current user stories. They require an
explicit product decision and delivery/token model before implementation.

## Admin

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| POST | `/auth/admin/login` | Public | Issue an expiring HS256 JWT |
| GET | `/auth/admin/me` | Platform User JWT | Resolve current identity and role |
| POST | `/admin/onboarding/venues/:venueId/approve` | `ADMIN` JWT | Activate a KYC-verified owner and Venue; body: `ownerId` |

Admin access tokens are standards-shaped JWTs with an `HS256` header and
validated `iss`, `aud`, `sub`, `jti`, `actor`, `role`, `iat`, `nbf`, and `exp`
claims. Authentication also reloads the `AdminUser`, so disabled users and
changed roles take effect before token expiry. `OPS` and `SUPPORT` may use
explicitly read-only Platform User routes; privileged mutations require the
`ADMIN` role.

Create the first Admin with environment variables:

```env
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=a-long-random-password
BOOTSTRAP_ADMIN_DISPLAY_NAME=Platform Admin
BOOTSTRAP_ADMIN_ROLE=ADMIN
```

Then run:

```sh
npm run admin:create
```

## KYC

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| POST | `/kyc/owner/verifications` | Owner | Create a current draft |
| POST | `/kyc/owner/verifications/:id/documents?documentType=...` | Owner | Upload protected multipart document |
| POST | `/kyc/owner/verifications/:id/submit` | Owner | Submit draft for review |
| GET | `/kyc/owner/verifications/current/:type` | Owner | Get current verification |
| PATCH | `/kyc/admin/verifications/:id/review` | `ADMIN` | Verify or reject |
| POST | `/kyc/admin/partners/:partnerId/verifications` | `ADMIN` | Create Partner KYC draft |
| POST | `/kyc/admin/partners/:partnerId/verifications/:id/documents?documentType=...` | `ADMIN` | Upload Partner KYC document |
| POST | `/kyc/admin/partners/:partnerId/verifications/:id/submit` | `ADMIN` | Submit Partner KYC |

KYC bytes use authenticated Cloudinary delivery. MongoDB stores protected
metadata in `KycDocument.file` with `SENSITIVE` classification. Review is
allowed only after a current verification has been submitted with at least one
active document. Verification, document outcome, derived Owner/Partner KYC
status, and bounded audit history are updated atomically.

## Partner access

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| POST | `/partners/applications` | Public | Submit Partner application |
| POST | `/partners/admin/:partnerId/approve-sandbox` | `ADMIN` | Approve sandbox access |
| PATCH | `/partners/admin/:partnerId/integration-review` | `ADMIN` | Record go-live review |
| POST | `/partners/admin/:partnerId/approve-production` | `ADMIN` | Approve production after BUSINESS KYC |
| POST | `/partners/admin/:partnerId/keys` | `ADMIN` | Issue environment-specific credentials |
| DELETE | `/partners/admin/keys/:keyId` | `ADMIN` | Revoke a key |
| POST | `/partners/webhooks` | Partner HMAC | Register environment-matched webhook |
| PUT | `/partners/webhooks/:webhookId/subscriptions` | Partner HMAC | Replace persisted event subscriptions |
| DELETE | `/partners/webhooks/:webhookId` | Partner HMAC | Disable webhook |
| POST | `/partners/admin/webhooks/:webhookId/verify` | `ADMIN` | Mark verified webhook active |

Venue Owner device registration is part of the Communications completion:
`PUT` and `DELETE /auth/venue-owners/devices/:deviceId`. See
`communications-api.md` for the inbox, delivery worker, and monitoring
contracts.

The Partner application accepts only the legal and display fields defined by
the authoritative ERD. Partner API clients are integration identities rather
than password-login users.

API keys and signing secrets are returned once. MongoDB stores their hashes.
Sandbox and production keys can coexist.

### Partner HMAC

Required headers:

```http
X-API-Key: <api-key>
X-Timestamp: <unix-seconds>
X-Signature: sha256=<hex-hmac>
```

The signing input is:

```text
<timestamp>
<UPPERCASE_HTTP_METHOD>
<request_path_with_query>
<lowercase_hex_sha256_of_raw_body>
```

Requests outside `PARTNER_HMAC_MAX_SKEW_SECONDS` are rejected. The resolved
identity contains Partner ID, key ID, environment, and scopes. Partner request
usage is updated after the response.

## Persistence

Identity initialization currently creates validators, indexes, and default role
permissions at application startup. Before horizontally scaled production
deployment, move these operations into versioned migrations and give the
runtime database user only normal application permissions.
