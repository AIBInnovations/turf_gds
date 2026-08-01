# Venue Owner API

All routes are under `/api/v1`. Owner routes require a revocable Venue Owner
Bearer session and enforce exact Venue membership and role permissions.

## Profile, courts, pricing, and availability

- `GET/PATCH /owner/venues/:venueId` reads and versions the core profile.
- `POST /owner/venues/:venueId/media?version=` uploads Venue media.
- `POST/GET/PATCH /owner/venues/:venueId/courts[...]` manages Courts.
- `POST /owner/venues/:venueId/courts/:courtId/media?version=` uploads Court media.
- `PUT /owner/venues/:venueId/courts/:courtId/operating-hours` replaces hours.
- `POST/GET/PATCH .../pricing-rules[...]` manages effective INR pricing.
- `POST .../slots/generate` generates fixed inventory.
- `GET .../inventory` reads the availability calendar.
- `POST .../inventory/block` and `POST .../inventory/:slotId/release` manually block and release inventory.

All mutations use optimistic versions, Venue scoping, bounded audit history,
and correlation IDs. Media bytes are stored in Cloudinary; public delivery
metadata is embedded in the owning aggregate.

## Flexible venue content

- `GET /owner/venues/:venueId/content?locale=en-IN`
- `PUT /owner/venues/:venueId/content?locale=en-IN`

Content is a flexible JSON object, localized, limited to 256 KiB, and protected
by optimistic versioning. Top-level keys must be stable identifier-style names.
This supports descriptions, amenities, facilities, policies, directions, FAQs,
and future content without changing the core Venue schema.

## Direct bookings, payments, refunds, and cancellation

- `GET /owner/venues/:venueId/bookings`
- `GET /owner/venues/:venueId/bookings/:bookingId`
- `POST /owner/venues/:venueId/bookings`
- `POST /owner/venues/:venueId/bookings/:bookingId/payment`
- `POST /owner/venues/:venueId/bookings/:bookingId/payment/refund`
- `POST /owner/venues/:venueId/bookings/:bookingId/cancel`

Direct creation atomically validates the active Venue and Court, rejects
unavailable overlap, creates booked inventory, creates a `DIRECT` Booking, and
enqueues a notification. Direct payments support cash, card, UPI, bank transfer,
and other methods, plus partial/full refunds. Cancelling a paid direct booking
fully refunds the remaining paid amount and releases inventory transactionally.
Direct payments do not enter Partner contract settlement accounting.

## Onboarding agreement and cancellation policy

- `POST /admin/onboarding/venues/:venueId/agreement` proposes terms.
- `GET /owner/venues/:venueId/onboarding-agreement` returns current terms.
- `POST /owner/venues/:venueId/onboarding-agreement/accept` accepts one version.

The agreement includes contract text, commission basis points, settlement cycle
and lag, cancellation permission, default/no-show refund basis points, owner
cancellation notice, and refund tiers. Acceptance records the owner, exact
version, timestamp, IP address, and audit event. Production onboarding approval
requires verified BUSINESS KYC and an accepted agreement. Partner-specific
distribution contracts remain independently versioned by the Contracts module.

## KYC and payout accounts

KYC supports draft creation, authenticated Cloudinary document upload,
submission, current-status reads, and Admin review.

- `POST/GET /owner/venues/:venueId/payout-accounts`
- `GET/PATCH/DELETE /owner/venues/:venueId/payout-accounts/:accountId`
- `POST /owner/venues/:venueId/payout-accounts/:accountId/default`
- `POST /owner/venues/:venueId/payout-accounts/:accountId/documents?version=&documentType=`

The API accepts only vault tokens and masked account metadata, never raw account
numbers. Owners can inspect details, update and re-submit, disable, choose a
verified default, and upload protected PDF/image evidence. Admin verification
supports penny-drop and documented manual review.

## Dashboard and notifications

- `GET /owner/venues/:venueId/dashboard?from=&to=` returns booking counts and
  values, direct-booking counts, inventory occupancy, Court health, unread
  notifications, upcoming bookings, and recent payouts.
- `GET /owner/notifications` lists the bounded durable inbox.
- `PATCH /owner/notifications/read` marks a notification read.
- Device endpoints register and remove FCM tokens for best-effort push delivery.

Notification identities cover bookings, cancellation, payment/refund,
settlement, payout, onboarding contracts, KYC, Venue, Court, and availability.
Transactional producers are wired for booking, payment/refund, payout, KYC,
and onboarding-agreement events. The outbox worker preserves the durable inbox
even when push delivery fails.

## Finance and downloadable documents

- `GET /owner/venues/:venueId/finance/settlements[/:settlementId]`
- `GET /owner/venues/:venueId/finance/payouts[/:payoutId]`
- `GET /owner/venues/:venueId/finance/settlements/:settlementId/statement.pdf`
- `GET /owner/venues/:venueId/finance/settlements/:settlementId/invoice.pdf`

The statement and invoice are generated from the owner-scoped immutable
Settlement and Ledger allocation view. Cross-Venue access is rejected before a
document is generated.
