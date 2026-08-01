# Partner and Admin completion

## Partner identity

Partner dashboard users and Partner API clients use different credentials:

- `POST /api/v1/partners/applications` registers the business and dashboard login.
- `POST /api/v1/partners/auth/login` returns a Bearer session for human dashboard operations.
- Admin-issued `X-API-Key`, `X-Timestamp`, and `X-Signature` credentials authenticate machine-to-machine Partner API traffic.

Dashboard sessions are used for Partner KYC and tokenized payout-account configuration. API keys remain environment-scoped and permission-scoped.

## Webhook configuration

Webhook configuration and webhook delivery are separate workflows.

### Configuration lifecycle

1. Register an HTTPS endpoint with `POST /api/v1/partners/webhooks` using a Partner API key with `webhooks:write`.
2. Store the returned signing secret. It is returned only in the registration response.
3. The endpoint begins in `PENDING` and receives no business events.
4. Call `POST /api/v1/partners/webhooks/:webhookId/test`. The platform sends a signed `webhook.test` payload.
5. A `2xx` response activates the endpoint. Failed tests leave it pending.
6. Read configuration with `GET /api/v1/partners/webhooks` and replace subscriptions with `PUT /api/v1/partners/webhooks/:webhookId/subscriptions`.
7. `POST /api/v1/partners/webhooks/:webhookId/rotate-secret` returns a replacement secret and returns the endpoint to `PENDING`. Retest it before business delivery resumes.
8. Disable it with `DELETE /api/v1/partners/webhooks/:webhookId`.

Each delivery contains `X-Turf-Event-Id`, `X-Turf-Event-Type`, `X-Turf-Timestamp`, and `X-Turf-Signature`. The signature is HMAC-SHA256 over `timestamp + "." + exactBody`. Consumers must validate the signature against the exact request bytes and reject stale timestamps.

The background communications worker performs business-event delivery, retries retryable failures with bounded exponential backoff, and retains an Admin-visible attempt history. Partner-facing delivery monitoring is intentionally not exposed.

## Cancellation policy

Partners do not configure cancellation/refund policy. The Admin contract API still accepts legacy cancellation fields for backward-compatible request validation, but production contract creation replaces them with the venue owner's latest accepted onboarding policy. Booking confirmation snapshots that accepted policy and cancellation evaluates the immutable snapshot.

## Partner finance and KYC

- Partner KYC: `/api/v1/kyc/partner/verifications...` using the dashboard Bearer session.
- Partner payout accounts: `/api/v1/partners/me/payout-accounts...`; raw account numbers are not accepted, only vault tokens and last-four metadata.
- Settlement PDF: `/api/v1/partners/me/settlements/:settlementId/statement.pdf`.
- Invoice PDF: `/api/v1/partners/me/invoices/:invoiceId/invoice.pdf`.

### Required BUSINESS KYC registration pack

The same checklist is required for Partner and Venue Owner production registration:

- `GST_CERTIFICATE`: JPEG/PNG plus `gstNumber`, `legalName`, and optional `tradeName`.
- `PAN`: JPEG/PNG plus `panNumber` and `nameOnPan`.
- `PASSBOOK`: JPEG/PNG plus `accountHolderName`, `bankName`, `ifscCode`, and `accountLast4`.
- `AADHAAR`: JPEG/PNG plus `holderName` and `aadhaarLast4`.

Full Aadhaar and bank-account numbers are deliberately not stored. Document details are attached with the authenticated `.../documents/:documentId/details` endpoint. BUSINESS KYC submission is rejected until all four active images and complete validated details are present. Authenticated document listing returns ten-minute signed download links for the applicant and Admin review.

## Admin operations

- Partner list/detail: `/api/v1/admin/partners` and `/api/v1/admin/partners/:partnerId`.
- API usage: `/api/v1/admin/reports/partner-api-usage`.
- Dispute queue/resolution: `/api/v1/admin/disputes` and `/api/v1/admin/disputes/bookings/:bookingId/resolve`.
- Operations summary: `/api/v1/admin/operations/health`.
- Inventory health: `/api/v1/admin/operations/inventory-health`.
- Contract templates: `/api/v1/admin/contract-templates`.
