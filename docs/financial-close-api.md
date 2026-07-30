# Financial Close API

The Venue Owner completion slice exposes Admin Financial Close operations at
`/api/v1/admin/financial-close` and owner history at
`/api/v1/owner/venues/:venueId/finance`.

All financial mutations require an authenticated `ADMIN`. `OPS` and `SUPPORT`
may use the filtered Admin Settlement reads but cannot mutate financial state.
Owner reads require an active membership with `VIEW_FINANCE`. Money is in INR
minor units; periods use an inclusive start and exclusive end.

## Settlement and reconciliation

- `POST /settlements` creates a `DRAFT` from one Partner, environment, period,
  currency, and contract cycle. Ledger allocation is transactional and
  one-time. Original entries referenced by cross-period reversals are loaded
  when totals are classified.
- `GET /settlements` and `GET /settlements/:settlementId` support Admin review.
- `POST /settlements/:settlementId/submit` moves `DRAFT` to `PENDING_FUNDS`.
- `POST /settlements/:settlementId/reconciliation` requires
  `reportedAmountMinor` and `bankReference`. It compares the remittance with
  `netAmountMinor`, producing `RECONCILED` on a match or `RECONCILING` on a
  documented mismatch.
- `POST /settlements/:settlementId/reconciliation/resolve` requires both
  `evidenceUri` and `notes`.
- `POST /settlements/:settlementId/complete` moves only `RECONCILED` to
  `COMPLETED`.

Example generation:

```json
{
  "partnerId": "687f00000000000000000001",
  "environment": "PRODUCTION",
  "periodStart": "2026-08-01T00:00:00.000Z",
  "periodEnd": "2026-08-08T00:00:00.000Z"
}
```

Reconciliation and financial audit histories are capped at 100 entries.

## Payout account verification and payout

Verify a Venue-owned account:

`POST /api/v1/admin/venues/:venueId/payout-accounts/:accountId/verification`

```json
{
  "outcome": "VERIFIED",
  "verificationMethod": "PENNY_DROP"
}
```

`FAILED` requires `failureReason` and disables the account. Actor metadata and
bounded audit history are retained.

Initiate a payout:

`POST /settlements/:settlementId/venues/:venueId/payouts`

```json
{
  "payoutAccountId": "687f00000000000000000002",
  "idempotencyKey": "venue-2026-w31"
}
```

The Settlement must be completed and match the Venue environment. The Venue's
canonical active `OWNER` must have a current, unexpired, verified `BUSINESS`
KYC record, and the selected account must be verified. The amount is the
positive net of unallocated Venue Ledger entries. One Payout is permitted per
Settlement/Venue and eligible entries are linked transactionally.

Record a manual result at `POST /payouts/:payoutId/result`. `PAID` requires
`bankReference`; `FAILED` requires `failureReason`. Manual processing moves
directly from `PENDING` to the result. `PROCESSING` is reserved for a future
provider integration. Payout creation and result events are inserted into the
Outbox transactionally.

## Owner finance history

- `GET /owner/venues/:venueId/finance/settlements`
- `GET /owner/venues/:venueId/finance/settlements/:settlementId`
- `GET /owner/venues/:venueId/finance/payouts`
- `GET /owner/venues/:venueId/finance/payouts/:payoutId`

Lists support status/date filters and stable `page`/`limit` pagination.
Responses contain only Venue-specific totals and allocations, masked payout
account details, payout status/reference, and booking-level Ledger allocation.
Cross-Venue access is rejected.

Settlement adjustments, Partner statements, Invoice services/routes, and
communications delivery is handled by the dedicated Epic 07 worker. Invoice persistence uses
`subtotal_minor`, `tax_amount_minor`, `total_minor`, and nullable
`document_uri`.
