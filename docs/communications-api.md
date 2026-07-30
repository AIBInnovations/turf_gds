# Communications API and Worker

Shared Communications transports transactional Outbox events to Partner
webhooks and the embedded Venue Owner notification inbox. It owns no standalone
Notification or WebhookDelivery collection.

## Runtime

Run the API and worker as separate processes:

```sh
npm run dev
npm run worker:dev
```

Production uses `npm start` and `npm run worker:start`. The worker claims due
events with a 60-second MongoDB lease, processes batches of 20, recovers expired
claims, and retries transient webhook failures up to eight times.

FCM is optional. With `FCM_ENABLED=false`, inbox delivery remains durable and
push is skipped. When enabled, the Firebase project ID, client email, and
private key are required.

## Owner devices

All routes require a valid Venue Owner Bearer session.

### Register or replace a device

```http
PUT /api/v1/auth/venue-owners/devices/:deviceId
Content-Type: application/json

{
  "token": "fcm-registration-token",
  "platform": "ANDROID"
}
```

Platforms are `ANDROID`, `IOS`, and `WEB`. Repeating the request updates
`last_seen_at`; changing the token replaces the token for that device. A token
registered to another Owner is rejected.

### Remove a device

```http
DELETE /api/v1/auth/venue-owners/devices/:deviceId
```

## Owner notification inbox

```http
GET /api/v1/owner/notifications
```

Filters are `venueId`, `type`, `unreadOnly`, `page`, and `limit`. Responses are
newest-first and include `unreadCount` plus stable pagination. The inbox is
bounded to the 100 most recent notifications.

```http
PATCH /api/v1/owner/notifications/read
Content-Type: application/json

{
  "notificationType": "BOOKING_CONFIRMED",
  "aggregateType": "BOOKING",
  "aggregateId": "..."
}
```

Mark-read is idempotent. Booking notifications are sent to active members with
`VIEW_BOOKINGS`; completed payout notifications require `VIEW_FINANCE`.

## Partner webhook subscriptions

Creating an endpoint persists one to twenty supported subscriptions:

```http
POST /api/v1/partners/webhooks

{
  "url": "https://partner.example.com/events",
  "subscribedEvents": [
    "booking.confirmed",
    "booking.cancelled",
    "payout.completed"
  ]
}
```

Replace subscriptions for an owned, same-environment endpoint:

```http
PUT /api/v1/partners/webhooks/:webhookId/subscriptions
```

Partner authentication uses the existing API-key/HMAC request scheme and
requires `webhooks:write`.

Outbound requests contain `X-Turf-Event-Id`, `X-Turf-Event-Type`,
`X-Turf-Timestamp`, and `X-Turf-Signature`. The signature is
`HMAC-SHA256(secret, timestamp + "." + rawBody)`. Receivers should deduplicate
on event ID because delivery is at least once.

The worker disables redirects, pins a public DNS result to the TLS connection,
rejects private/reserved destinations, applies a ten-second timeout, and stores
only bounded redacted evidence. HTTP 408, 425, 429, 5xx, and network failures
are retryable; other 4xx responses are terminal.

## Admin monitoring

All Platform roles may read:

```http
GET /api/v1/admin/communications/deliveries
GET /api/v1/admin/communications/events/:eventId
```

Delivery filters include Partner, endpoint, environment, internal event type,
status, dates, page, and limit. ADMIN and OPS may retry a terminally failed
delivery:

```http
POST /api/v1/admin/communications/events/:eventId/endpoints/:endpointId/retry
```

SUPPORT is read-only. Disabled endpoints and non-failed deliveries cannot be
retried.

## Event catalog

Internal event names remain uppercase. Partner wire names are:

| Internal | Partner |
|---|---|
| `BOOKING_CONFIRMED` | `booking.confirmed` |
| `BOOKING_CANCELLED` | `booking.cancelled` |
| `SETTLEMENT_DRAFT_CREATED` | `settlement.created` |
| `SETTLEMENT_COMPLETED` | `settlement.completed` |
| `PAYOUT_PENDING` | `payout.pending` |
| `PAYOUT_PAID` | `payout.completed` |
| `PAYOUT_FAILED` | `payout.failed` |
