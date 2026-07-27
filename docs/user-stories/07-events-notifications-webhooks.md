# Epic 07 - Shared Communications Infrastructure

This epic covers the `shared/communications` infrastructure submodule. It is not
a business module: Booking, Financial Close, and Venue decide which domain
events occurred, while Communications reliably transports those events to Venue
Users and Booking Partners.

## US-07.01 - Enqueue Business Event

Story ID: `US-07.01`
As the: System
I want: modules to enqueue domain events transactionally
So that: webhooks and notifications are reliable without blocking the main request.

Acceptance Criteria:

- Given Booking, Financial Close, or Venue changes require external communication, when the business transaction commits, then an `OutboxEvent` is created in the same transaction.
- Given the same aggregate event and correlation ID is retried, when enqueue is called, then duplicate outbox events are not created.
- Given enqueue fails, when the parent transaction is rolling back, then no partial business state is committed.
- Given an event is created, when routing fields are populated, then `environment`, applicable `partner_id`/`venue_id`, `event_version`, correlation ID, and payload are stored.
- Given endpoints are selected for delivery, when Communications reads Identity configuration, then matching endpoint IDs are snapshotted in `OutboxEvent.webhook_endpoint_ids` and every endpoint environment matches the event environment.

Primary Module: `shared/communications`
Supporting Modules: `booking`, `venue`, `financial-close`, `shared/db`
Data: `OutboxEvent`
API/UI: Internal `communications.enqueue()`
Priority: `P0`
Notes: Transactional outbox is core reliability infrastructure.

## US-07.02 - Deliver Partner Webhook

Story ID: `US-07.02`
As a: Partner
I want: to receive webhook events for booking and slot changes
So that: my application can keep customer-facing state synchronized.

Acceptance Criteria:

- Given an `OutboxEvent` is pending and a Partner has an active endpoint, when the worker drains the event, then an embedded delivery document is created in `OutboxEvent.webhook_deliveries`.
- Given delivery succeeds, when response is 2xx, then the embedded delivery status becomes `DELIVERED`.
- Given delivery fails, when the response is non-2xx or a network error occurs, then embedded status becomes `RETRYING`, bounded attempt history is appended, and `next_attempt_at` is set.
- Given max retries are exhausted, when delivery still fails, then status becomes `FAILED`.
- Given fixed-slot or open-time inventory becomes unavailable after a Partner-visible change, when delivered, then the affected Partner receives booking mode, venue, court, start, end, and correlation context.
- Given delivery attempts accumulate, when the configured cap is reached, then retention rules bound the embedded array without allowing OutboxEvent to grow indefinitely.

Primary Module: `shared/communications`
Supporting Modules: `identity`
Data: `OutboxEvent`, `OutboxEvent.webhook_deliveries`, `WebhookEndpoint`
API/UI: Webhook worker
Priority: `P0`
Notes: Event types include `booking.confirmed`, `booking.cancelled`, `booking.refunded`, `inventory.unavailable`, `settlement.completed`, and `payout.completed`.

## US-07.03 - Owner Notifications

Story ID: `US-07.03`
As a: Venue Partner
I want: to receive dashboard notifications for bookings, cancellations, and completed payouts
So that: I can act on operational changes quickly.

Acceptance Criteria:

- Given a booking is confirmed for a venue, when event is processed, then relevant venue owners receive `BOOKING_CONFIRMED` notification.
- Given a booking is cancelled, when event is processed, then relevant owners receive `BOOKING_CANCELLED` notification.
- Given payout is completed, when event is processed, then relevant owners receive `PAYOUT_COMPLETED` notification.
- Given an owner has active embedded FCM tokens, when a notification is stored, then push delivery is attempted without making push success a prerequisite for the durable inbox update.
- Given FCM reports an embedded token as invalid, when processed, then the token is removed from `VenueOwner.fcm_tokens`.
- Given a notification is read, when owner marks it read, then `read_at` is saved.

Primary Module: `shared/communications`
Supporting Modules: `identity`, `booking`, `financial-close`
Data: `VenueOwner.notifications`, `VenueOwnerMembership`, `Booking`, `Payout`
API/UI: Owner Dashboard notification center
Priority: `P1`
Notes: `VenueOwner.notifications` is the bounded durable dashboard inbox. FCM tokens and best-effort push delivery remain embedded on VenueOwner.

## US-07.04 - Webhook Delivery Monitoring

Story ID: `US-07.04`
As an: Admin
I want: to monitor webhook delivery health
So that: partner integration failures can be detected and resolved.

Acceptance Criteria:

- Given admin opens webhook monitoring, when data loads, then failed, retrying, and delivered attempts are visible by partner and endpoint.
- Given a failed delivery is selected, when details load, then response code, last error, attempt count, and next attempt time are shown.
- Given admin triggers a retry, when endpoint is active, then a new delivery attempt is scheduled.
- Given endpoint is disabled, when retry is requested, then the system blocks retry.

Primary Module: `admin`
Supporting Modules: `shared/communications`, `identity`
Data: `OutboxEvent`, `OutboxEvent.webhook_deliveries`, `WebhookEndpoint`
API/UI: Admin webhook health console
Priority: `P1`
Notes: Admin does not own Communications collections.

## US-07.05 - Outbox Worker Recovery

Story ID: `US-07.05`
As the: System
I want: the outbox worker to recover pending events after failure
So that: business events are not lost.

Acceptance Criteria:

- Given worker process stops, when restarted, then pending due events are picked up.
- Given a due event is available, when a worker claims it, then status atomically changes from `PENDING` to `PROCESSING` and a bounded `locked_until` lease is stored.
- Given a worker crashes after claiming an event, when its lease expires, then another worker can safely reclaim it.
- Given event attempts exceed threshold, when exhausted, then status is `FAILED` and visible to admin.

Primary Module: `shared/communications`
Supporting Modules: `shared/db`
Data: `OutboxEvent`, `OutboxEvent.webhook_deliveries`
API/UI: Background worker
Priority: `P0`
Notes: Worker must be idempotent.
