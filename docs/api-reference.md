# Turf GDS Complete API Reference

Date: 2026-08-03  
API version: `v1`  
Base path: `/api/v1`

This document consolidates the HTTP surfaces implemented by the Turf GDS API.
The machine-readable entry point is `GET /api/v1/openapi.json`; module-specific
documents under `docs/` remain the detailed authority for request schemas and
business rules.

## Platform endpoints

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | Public | Process liveness |
| `GET` | `/ready` | Public | MongoDB and external dependency readiness |
| `GET` | `/metrics` | Public/operations boundary | Prometheus-compatible metrics |
| `GET` | `/api/v1` | Public | Service and API-version discovery |
| `GET` | `/api/v1/openapi.json` | Public | OpenAPI 3.1 description |

## Authentication models

| Actor | Authentication | Notes |
|---|---|---|
| Venue Owner | Opaque Bearer session | Revocable; only the SHA-256 token hash is stored |
| Partner portal user | Opaque Bearer session | Human dashboard access |
| Partner API client | API key plus HMAC | Environment and scopes come from the credential |
| Platform user | HS256 Bearer JWT | Role is `ADMIN`, `OPS`, or `SUPPORT` |
| Inventory connector | Connector signature | Raw request body is signed |
| Razorpay | Provider webhook signature | Raw request body is verified |

Partner HMAC requests send `X-Api-Key`, `X-Timestamp`, `X-Request-Id`, and
`X-Signature`. The signature covers timestamp, method, path, raw-body SHA-256,
and request ID.

## Venue Owner identity and membership

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/auth/venue-owners/register` | Register an owner, initial Venue, and OWNER membership |
| `POST` | `/auth/venue-owners/login` | Create a bounded owner session |
| `GET` | `/auth/venue-owners/me` | Read owner profile, memberships, roles, and permissions |
| `POST` | `/auth/venue-owners/logout` | Revoke the current session |
| `GET` | `/auth/venue-owners/venues/:venueId/members` | List Venue members |
| `POST` | `/auth/venue-owners/venues/:venueId/members` | Add or reactivate a manager/staff member |
| `DELETE` | `/auth/venue-owners/venues/:venueId/members/:memberOwnerId` | Revoke membership |
| `POST` | `/auth/venue-owners/devices` | Register or replace an owner device token |
| `DELETE` | `/auth/venue-owners/devices/:deviceId` | Remove an owner device |

## Venue, Court, pricing, and inventory

All routes below require an Owner session and exact Venue permission.

| Method | Route | Purpose |
|---|---|---|
| `GET`, `PATCH` | `/owner/venues/:venueId` | Read or version-update the Venue profile |
| `POST` | `/owner/venues/:venueId/media?version=` | Upload Venue media |
| `GET`, `POST` | `/owner/venues/:venueId/courts` | List or create Courts |
| `GET`, `PATCH` | `/owner/venues/:venueId/courts/:courtId` | Read or version-update a Court |
| `POST` | `/owner/venues/:venueId/courts/:courtId/media?version=` | Upload Court media |
| `PUT` | `/owner/venues/:venueId/courts/:courtId/operating-hours` | Replace operating hours |
| `GET`, `POST` | `/owner/venues/:venueId/courts/:courtId/pricing-rules` | List or create pricing rules |
| `PATCH` | `/owner/venues/:venueId/courts/:courtId/pricing-rules/:ruleId` | Version-update a pricing rule |
| `POST` | `/owner/venues/:venueId/courts/:courtId/slots/generate` | Generate fixed-slot inventory |
| `GET` | `/owner/venues/:venueId/courts/:courtId/inventory` | Read the inventory calendar |
| `POST` | `/owner/venues/:venueId/courts/:courtId/inventory/block` | Block fixed or open-time inventory |
| `POST` | `/owner/venues/:venueId/courts/:courtId/inventory/:slotId/release` | Release inventory |
| `GET`, `PUT` | `/owner/venues/:venueId/content?locale=` | Read or replace localized flexible content |
| `GET` | `/owner/venues/:venueId/dashboard?from=&to=` | Read the operational dashboard |

## Partner booking lifecycle

Partner routes require HMAC authentication and the `bookings:write` scope.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/availability` | Search contract-authorized availability |
| `POST` | `/bookings/hold` | Hold fixed-slot or open-time inventory |
| `POST` | `/bookings/confirm` | Confirm an active hold idempotently |
| `POST` | `/bookings/:bookingId/cancel` | Cancel a confirmed booking idempotently |
| `GET` | `/bookings/admin/:bookingId/audit` | Admin-only chronological audit history |

Confirmation and cancellation require `Idempotency-Key`. The same key and
normalized request returns the stored response; different content returns
`IDEMPOTENCY_KEY_REUSED`.

## Owner direct booking and payment

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/owner/venues/:venueId/bookings` | List bookings with Court, status, date, and pagination filters |
| `GET` | `/owner/venues/:venueId/bookings/:bookingId` | Read booking, cancellation, and payment detail |
| `POST` | `/owner/venues/:venueId/bookings` | Create a direct booking transactionally |
| `POST` | `/owner/venues/:venueId/bookings/:bookingId/cancel` | Cancel a direct booking and release inventory |
| `POST` | `/owner/venues/:venueId/bookings/:bookingId/payment` | Record cash/card/UPI/bank/other payment |
| `POST` | `/owner/venues/:venueId/bookings/:bookingId/payment/refund` | Apply an optimistic partial/full refund |

Money is represented in INR minor units. Direct payments do not participate in
Partner settlement accounting.

## Owner onboarding, KYC, and payout accounts

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/owner/venues/:venueId/onboarding-agreement` | Read the current agreement |
| `POST` | `/owner/venues/:venueId/onboarding-agreement/accept` | Accept an exact agreement version |
| `POST` | `/kyc/owner/verifications` | Create an Owner KYC draft |
| `POST` | `/kyc/owner/verifications/:verificationId/documents?documentType=` | Upload protected evidence |
| `PATCH` | `/kyc/owner/verifications/:verificationId/documents/:documentId/details` | Update document metadata |
| `GET` | `/kyc/owner/verifications/:verificationId/documents` | List verification documents |
| `POST` | `/kyc/owner/verifications/:verificationId/submit` | Submit a draft |
| `GET` | `/kyc/owner/verifications/current/:verificationType` | Get current verification |
| `GET`, `POST` | `/owner/venues/:venueId/payout-accounts` | List or create tokenized payout accounts |
| `GET`, `PATCH`, `DELETE` | `/owner/venues/:venueId/payout-accounts/:accountId` | Read, update, or disable an account |
| `POST` | `/owner/venues/:venueId/payout-accounts/:accountId/default` | Select a verified default |
| `POST` | `/owner/venues/:venueId/payout-accounts/:accountId/documents` | Upload verification evidence |

Raw bank account numbers are never accepted; only vault tokens and masked
metadata are stored.

## Owner notifications and finance

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/owner/notifications` | List the durable bounded inbox |
| `PATCH` | `/owner/notifications/read` | Mark notifications read idempotently |
| `GET` | `/owner/venues/:venueId/finance/settlements` | List settlements |
| `GET` | `/owner/venues/:venueId/finance/settlements/:settlementId` | Read settlement detail |
| `GET` | `/owner/venues/:venueId/finance/payouts` | List payouts |
| `GET` | `/owner/venues/:venueId/finance/payouts/:payoutId` | Read payout detail |
| `GET` | `/owner/venues/:venueId/finance/settlements/:settlementId/statement.pdf` | Download statement |
| `GET` | `/owner/venues/:venueId/finance/settlements/:settlementId/invoice.pdf` | Download invoice |

## Partner onboarding and portal

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/partners/applications` | Submit a Partner application |
| `POST` | `/partners/auth/login` | Create a Partner portal session |
| `GET` | `/partners/me` | Read the portal profile |
| `PATCH` | `/partners/me` | Update allowed profile fields |
| `POST` | `/partners/auth/logout` | Revoke the current portal session |
| `GET` | `/partners/me/usage` | Read environment-scoped API usage |
| `GET` | `/partners/me/bookings` | List Partner bookings |
| `GET` | `/partners/me/bookings/:bookingId` | Read Partner booking detail |
| `GET` | `/partners/me/settlements` | List settlements |
| `GET` | `/partners/me/settlements/:settlementId` | Read settlement detail |
| `GET` | `/partners/me/settlements/:settlementId/statement.pdf` | Download statement |
| `GET` | `/partners/me/invoices` | List invoices |
| `GET` | `/partners/me/invoices/:invoiceId` | Read invoice detail |

## Partner credentials, webhooks, KYC, and payout

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/partners/admin/:partnerId/approve-sandbox` | Approve sandbox access |
| `PATCH` | `/partners/admin/:partnerId/integration-review` | Record integration review |
| `POST` | `/partners/admin/:partnerId/approve-production` | Approve production access |
| `POST` | `/partners/admin/:partnerId/keys` | Issue environment-specific credentials |
| `DELETE` | `/partners/admin/keys/:keyId` | Revoke an API key |
| `GET`, `POST` | `/partners/webhooks` | List or register webhooks |
| `POST` | `/partners/webhooks/:webhookId/rotate-secret` | Rotate signing secret |
| `POST` | `/partners/webhooks/:webhookId/test` | Send a test event |
| `PUT` | `/partners/webhooks/:webhookId/subscriptions` | Replace subscriptions |
| `DELETE` | `/partners/webhooks/:webhookId` | Disable a webhook |
| `POST` | `/partners/admin/webhooks/:webhookId/verify` | Verify and activate a webhook |
| `POST` | `/kyc/admin/partners/:partnerId/verifications` | Create Partner KYC draft |
| `POST` | `/kyc/admin/partners/:partnerId/verifications/:verificationId/documents` | Upload evidence |
| `POST` | `/kyc/admin/partners/:partnerId/verifications/:verificationId/submit` | Submit Partner KYC |

Partner payout-account routes are mounted below `/partners` and enforce the
authenticated Partner and environment boundary.

## Admin identity, onboarding, and operations

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/auth/admin/login` | Issue an expiring Platform JWT |
| `GET` | `/auth/admin/me` | Resolve the current Platform identity |
| `POST` | `/admin/onboarding/venues/:venueId/approve` | Activate an eligible Owner and Venue |
| `POST` | `/admin/onboarding/venues/:venueId/agreement` | Propose versioned commercial/cancellation terms |
| `GET`, `POST` | `/admin/venues` | Filter or create Venues |
| `GET`, `PATCH` | `/admin/venues/:venueId` | Read or update a Venue |
| `GET`, `POST` | `/admin/venues/:venueId/courts` | List or create Courts |
| `GET`, `PATCH` | `/admin/venues/:venueId/courts/:courtId` | Read or update a Court |
| `GET` | `/admin/partners` | List Partners |
| `GET` | `/admin/partners/:partnerId` | Read Partner detail |
| `GET` | `/admin/operations/health` | Read operational health |
| `GET` | `/admin/operations/inventory-health` | Read inventory coverage health |

## Contracts, reports, and disputes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/admin/contracts` | Create the next effective contract version |
| `GET` | `/admin/contracts` | List contract versions |
| `GET` | `/admin/contracts/:contractId` | Read an immutable version |
| `GET` | `/admin/reports/bookings` | Booking report |
| `GET` | `/admin/reports/revenue` | Ledger-backed revenue report |
| `GET` | `/admin/reports/venues` | Venue activity report |
| `GET` | `/admin/reports/partners` | Partner activity report |
| `GET` | `/admin/reports/:kind/export` | CSV export for supported reports |
| `GET` | `/admin/reports/partner-api-usage` | Partner usage report |
| `GET` | `/admin/disputes` | List disputes |
| `GET` | `/admin/disputes/bookings/:bookingId` | Read booking dispute context |
| `POST` | `/admin/disputes/bookings/:bookingId/notes` | Add an optimistic dispute note |
| `POST` | `/admin/disputes/bookings/:bookingId/resolve` | Resolve a dispute optimistically |

## Financial close and treasury

Financial Close is mounted below `/admin/financial-close`.

| Method | Relative route | Purpose |
|---|---|---|
| `POST` | `/settlements` | Create a draft settlement |
| `GET` | `/settlements` | List settlements |
| `GET` | `/settlements/:settlementId` | Read settlement detail |
| `POST` | `/settlements/:settlementId/submit` | Move a draft to pending funds |
| `POST` | `/settlements/:settlementId/reconciliation` | Record reconciliation |
| `POST` | `/settlements/:settlementId/reconciliation/resolve` | Resolve mismatches |
| `POST` | `/settlements/:settlementId/complete` | Complete a reconciled settlement |
| `POST` | `/settlements/:settlementId/adjustments` | Post an evidenced balanced adjustment |
| `POST` | `/settlements/:settlementId/invoices` | Create the settlement invoice |
| `GET` | `/invoices` | List invoices |
| `GET` | `/invoices/:invoiceId` | Read an invoice |
| `POST` | `/invoices/:invoiceId/issue` | Issue a draft invoice |
| `POST` | `/invoices/:invoiceId/void` | Void an issued invoice |

Treasury additionally exposes Partner remittance operations and the signed
Razorpay provider webhook.

## Communications and external inventory

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/admin/communications/outbox` | Monitor durable outbox events |
| `GET` | `/admin/communications/webhook-deliveries` | Monitor Partner delivery attempts |
| `POST` | `/inventory-connectors/reference/:connectorId/events` | Apply a signed reference connector event |
| `GET` | `/admin/inventory-conflicts` | List connector conflicts |
| `POST` | `/provider-webhooks/razorpay` | Process signed remittance/payout events idempotently |

## Common behavior

- MongoDB is the system of record and must run as a replica set for
  multi-document transactions.
- Mutations use correlation IDs, strict JSON schemas, bounded audit history,
  and environment/owner scoping.
- Optimistic `version` fields protect mutable aggregates.
- Booking, Ledger, inventory, idempotency, and Outbox writes share transaction
  boundaries where required.
- Standard errors use a stable application `code`, human-readable `message`,
  HTTP status, and request correlation context.

## Detailed module references

- [Identity API](identity-api.md)
- [Venue Owner API](venue-owner-api.md)
- [Booking API](booking-api.md)
- [Booking class and race-safe API](booking-class-api.md)
- [Contracts API](contracts-api.md)
- [Financial Close API](financial-close-api.md)
- [Communications API](communications-api.md)
- [Admin API](admin-api.md)
- [Ledger module](ledger-module.md)

