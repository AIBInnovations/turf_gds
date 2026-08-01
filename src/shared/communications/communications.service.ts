import { ObjectId } from 'mongodb';

import type { AppConfig } from '../../config/env.js';
import {
  deriveSigningSecret,
  hashCredential,
} from '../auth/partner-signature.js';
import { AppError } from '../errors/app-error.js';
import type { CommunicationsRepository } from './communications.repository.js';
import type {
  DevicePlatform,
  OutboxEventDocument,
  OwnerNotificationDocument,
  OwnerNotificationType,
  OwnerNotificationAggregateType,
  WebhookDeliveryDocument,
  WebhookEnvelope,
} from './communications.types.js';
import { externalEventType } from './communications.types.js';
import type { PushDelivery } from './push-delivery.js';
import type { WebhookTransport } from './webhook-transport.js';

export interface CommunicationsService {
  registerDevice(input: {
    ownerId: string;
    deviceId: string;
    token: string;
    platform: DevicePlatform;
  }): Promise<{ deviceId: string; platform: DevicePlatform }>;
  removeDevice(input: { ownerId: string; deviceId: string }): Promise<void>;
  listNotifications(input: {
    ownerId: string;
    venueId?: string;
    type?: OwnerNotificationType;
    unreadOnly?: boolean;
    page?: number;
    limit?: number;
  }): Promise<Record<string, unknown>>;
  markNotificationRead(input: {
    ownerId: string;
    notificationType: OwnerNotificationType;
    aggregateType: OwnerNotificationAggregateType;
    aggregateId: string;
  }): Promise<void>;
  listDeliveries(input: {
    partnerId?: string;
    endpointId?: string;
    environment?: 'SANDBOX' | 'PRODUCTION';
    eventType?: string;
    status?: WebhookDeliveryDocument['status'];
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<Record<string, unknown>>;
  getEvent(eventId: string): Promise<Record<string, unknown>>;
  retryDelivery(input: {
    eventId: string;
    endpointId: string;
  }): Promise<void>;
  processNext(workerId: string): Promise<boolean>;
  drain(workerId: string, limit?: number): Promise<number>;
}

export function createCommunicationsService(input: {
  repository: CommunicationsRepository;
  webhookTransport: WebhookTransport;
  pushDelivery: PushDelivery;
  authConfig: AppConfig['auth'];
  config: AppConfig['communications'];
  now?: () => Date;
  random?: () => number;
}): CommunicationsService {
  const now = input.now ?? (() => new Date());
  const random = input.random ?? Math.random;

  return {
    async registerDevice(values) {
      const ownerId = oid(values.ownerId);
      const deviceId = values.deviceId.trim();
      const token = values.token.trim();
      if (!deviceId || deviceId.length > 200 || token.length < 20 ||
          token.length > 4_096) {
        throw badRequest(
          'INVALID_DEVICE_REGISTRATION',
          'Device ID or FCM token is invalid',
        );
      }
      const result = await input.repository.upsertDevice({
        ownerId,
        deviceId,
        token,
        platform: values.platform,
        now: now(),
      });
      if (result === 'TOKEN_CONFLICT') {
        throw new AppError({
          code: 'FCM_TOKEN_ALREADY_REGISTERED',
          message: 'This FCM token belongs to another account',
          statusCode: 409,
        });
      }
      if (result === 'OWNER_NOT_FOUND') throw ownerNotFound();
      return { deviceId, platform: values.platform };
    },
    async removeDevice(values) {
      const deviceId = values.deviceId.trim();
      if (!deviceId || deviceId.length > 128) {
        throw new AppError({
          code: 'INVALID_DEVICE_ID',
          message: 'A valid device ID is required',
          statusCode: 400,
        });
      }
      if (
        !(await input.repository.removeDevice(
          oid(values.ownerId),
          deviceId,
          now(),
        ))
      ) {
        throw new AppError({
          code: 'DEVICE_NOT_FOUND',
          message: 'The device registration was not found',
          statusCode: 404,
        });
      }
    },
    async listNotifications(values) {
      const pagination = page(values.page, values.limit);
      const result = await input.repository.listNotifications({
        ownerId: oid(values.ownerId),
        ...(values.venueId ? { venueId: oid(values.venueId) } : {}),
        ...(values.type ? { type: values.type } : {}),
        ...(values.unreadOnly !== undefined
          ? { unreadOnly: values.unreadOnly }
          : {}),
        ...pagination,
      });
      return {
        items: result.items.map(notificationView),
        unreadCount: result.unreadCount,
        pagination: pageMetadata(
          result.total,
          pagination.page,
          pagination.limit,
        ),
      };
    },
    async markNotificationRead(values) {
      const expectedAggregate = notificationAggregate(values.notificationType);
      if (values.aggregateType !== expectedAggregate) {
        throw badRequest(
          'INVALID_NOTIFICATION_IDENTITY',
          'Notification and aggregate types do not match',
        );
      }
      const result = await input.repository.markNotificationRead({
        ownerId: oid(values.ownerId),
        notificationType: values.notificationType,
        aggregateType: values.aggregateType,
        aggregateId: oid(values.aggregateId),
        now: now(),
      });
      if (result === 'NOT_FOUND') {
        throw new AppError({
          code: 'NOTIFICATION_NOT_FOUND',
          message: 'The notification was not found',
          statusCode: 404,
        });
      }
    },
    async listDeliveries(values) {
      const pagination = page(values.page, values.limit);
      const from = values.from ? instant(values.from, 'from') : undefined;
      const to = values.to ? instant(values.to, 'to') : undefined;
      if (from && to && from >= to) {
        throw badRequest('INVALID_DATE_RANGE', 'from must be before to');
      }
      const result = await input.repository.listDeliveries({
        ...(values.partnerId ? { partnerId: oid(values.partnerId) } : {}),
        ...(values.endpointId ? { endpointId: oid(values.endpointId) } : {}),
        ...(values.environment ? { environment: values.environment } : {}),
        ...(values.eventType ? { eventType: values.eventType } : {}),
        ...(values.status ? { status: values.status } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...pagination,
      });
      return {
        items: result.items.map(deliveryListView),
        pagination: pageMetadata(
          result.total,
          pagination.page,
          pagination.limit,
        ),
      };
    },
    async getEvent(eventId) {
      const event = await input.repository.findEvent(oid(eventId));
      if (!event) throw eventNotFound();
      return eventView(event);
    },
    async retryDelivery(values) {
      const eventId = oid(values.eventId);
      const endpointId = oid(values.endpointId);
      const [event, endpoint] = await Promise.all([
        input.repository.findEvent(eventId),
        input.repository.findEndpoint(endpointId),
      ]);
      if (!event) throw eventNotFound();
      if (!endpoint || endpoint.status !== 'ACTIVE') {
        throw new AppError({
          code: 'WEBHOOK_ENDPOINT_NOT_ACTIVE',
          message: 'A disabled or missing endpoint cannot be retried',
          statusCode: 409,
        });
      }
      const delivery = event.webhook_deliveries.find(({ endpoint_id }) =>
        endpoint_id.equals(endpointId));
      if (!delivery || delivery.status !== 'FAILED') {
        throw new AppError({
          code: 'WEBHOOK_DELIVERY_NOT_FAILED',
          message: 'Only a terminally failed delivery can be retried',
          statusCode: 409,
        });
      }
      if (!(await input.repository.scheduleRetry(eventId, endpointId, now()))) {
        throw new AppError({
          code: 'WEBHOOK_RETRY_CONFLICT',
          message: 'The delivery changed before retry could be scheduled',
          statusCode: 409,
        });
      }
    },
    async processNext(workerId) {
      const claimedAt = now();
      const event = await input.repository.claimNext({
        workerId,
        now: claimedAt,
        lockedUntil: new Date(
          claimedAt.getTime() + input.config.leaseSeconds * 1_000,
        ),
      });
      if (!event) return false;
      await processClaimedEvent(event, workerId);
      return true;
    },
    async drain(workerId, limit = input.config.batchSize) {
      let processed = 0;
      while (processed < limit && await this.processNext(workerId)) {
        processed += 1;
      }
      return processed;
    },
  };

  async function processClaimedEvent(
    event: OutboxEventDocument,
    workerId: string,
  ): Promise<void> {
    const eventType = externalEventType(event.event_type);
    await publishOwnerNotifications(event, workerId);
    const byEndpoint = new Map(
      event.webhook_deliveries.map((delivery) => [
        delivery.endpoint_id.toHexString(),
        delivery,
      ]),
    );
    const deliveries = event.webhook_endpoint_ids.map((endpointId) =>
      byEndpoint.get(endpointId.toHexString()) ??
      newDelivery(endpointId, event.created_at),
    );
    const envelope = webhookEnvelope(event);
    const body = JSON.stringify(envelope);
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index]!;
      const timestamp = now();
      if (
        delivery.status === 'DELIVERED' ||
        delivery.status === 'FAILED' ||
        (delivery.next_attempt_at && delivery.next_attempt_at > timestamp)
      ) {
        continue;
      }
      await renewLease(event._id, workerId);
      const endpoint = await input.repository.findEndpoint(
        delivery.endpoint_id,
      );
      if (
        !endpoint ||
        endpoint.status !== 'ACTIVE' ||
        endpoint.environment !== event.environment ||
        !endpoint.subscribed_event_types.includes(eventType)
      ) {
        deliveries[index] = terminalDelivery(
          delivery,
          'Endpoint is missing, disabled, unsubscribed, or cross-environment',
          timestamp,
        );
        continue;
      }
      const secret = deriveSigningSecret(
        input.authConfig.partnerCredentialMasterSecret,
        (endpoint.secret_version??1)===1?`webhook:${endpoint._id.toHexString()}`:`webhook:${endpoint._id.toHexString()}:v${endpoint.secret_version}`,
      );
      if (hashCredential(secret) !== endpoint.signing_secret_hash) {
        deliveries[index] = terminalDelivery(
          delivery,
          'Endpoint signing-secret integrity check failed',
          timestamp,
        );
        continue;
      }
      const result = await input.webhookTransport.deliver({
        url: endpoint.url,
        secret,
        eventId: event._id.toHexString(),
        eventType,
        body,
        timeoutMs: input.config.requestTimeoutMs,
        now: timestamp,
      });
      const attemptCount = delivery.attempt_count + 1;
      if (result.delivered) {
        deliveries[index] = {
          ...delivery,
          status: 'DELIVERED',
          attempt_count: attemptCount,
          next_attempt_at: null,
          last_error: null,
          delivered_at: result.attempt.completed_at,
          attempts: [...delivery.attempts, result.attempt].slice(-8),
          updated_at: result.attempt.completed_at,
        };
      } else {
        const retrying =
          result.retryable &&
          attemptCount < input.config.maxWebhookAttempts;
        deliveries[index] = {
          ...delivery,
          status: retrying ? 'RETRYING' : 'FAILED',
          attempt_count: attemptCount,
          next_attempt_at: retrying
            ? retryAt(result.attempt.completed_at, attemptCount)
            : null,
          last_error: result.attempt.error ?? 'Webhook delivery failed',
          attempts: [...delivery.attempts, result.attempt].slice(-8),
          updated_at: result.attempt.completed_at,
        };
      }
    }
    const timestamp = now();
    const retryDates = deliveries.flatMap(({ status, next_attempt_at }) =>
      status === 'RETRYING' && next_attempt_at ? [next_attempt_at] : []);
    const failed = deliveries.some(({ status }) => status === 'FAILED');
    const status: OutboxEventDocument['status'] =
      retryDates.length > 0 ? 'PENDING' : failed ? 'FAILED' : 'PUBLISHED';
    const saved = await input.repository.saveEvent({
      eventId: event._id,
      workerId,
      status,
      deliveries,
      availableAt: retryDates.length > 0
        ? new Date(Math.min(...retryDates.map((value) => value.getTime())))
        : timestamp,
      publishedAt: status === 'PUBLISHED' ? timestamp : null,
      now: timestamp,
    });
    if (!saved) throw new Error('Communications worker lease was lost');
  }

  async function publishOwnerNotifications(
    event: OutboxEventDocument,
    workerId: string,
  ): Promise<void> {
    const target = ownerTarget(event);
    if (!target || !event.venue_id) return;
    const ownerIds = await input.repository.listRecipientOwnerIds(
      event.venue_id,
      target.permission,
    );
    for (const ownerId of ownerIds) {
      await renewLease(event._id, workerId);
      const timestamp = now();
      const notification: OwnerNotificationDocument = {
        notification_type: target.type,
        aggregate_type: target.aggregateType,
        aggregate_id: event.aggregate_id,
        venue_id: event.venue_id,
        payload: event.payload,
        read_at: null,
        created_at: event.created_at,
      };
      const inserted = await input.repository.appendNotification(
        ownerId,
        notification,
        timestamp,
      );
      if (!inserted) continue;
      const tokens = await input.repository.listOwnerTokens(ownerId);
      try {
        const result = await input.pushDelivery.send({ tokens, notification });
        await input.repository.removeOwnerTokens(
          ownerId,
          result.invalidTokens,
          now(),
        );
      } catch {
        // Durable inbox delivery intentionally does not depend on push success.
      }
    }
  }

  async function renewLease(
    eventId: ObjectId,
    workerId: string,
  ): Promise<void> {
    const timestamp = now();
    const renewed = await input.repository.renewLease({
      eventId,
      workerId,
      now: timestamp,
      lockedUntil: new Date(
        timestamp.getTime() + input.config.leaseSeconds * 1_000,
      ),
    });
    if (!renewed) throw new Error('Communications worker lease was lost');
  }

  function retryAt(timestamp: Date, attemptCount: number): Date {
    const base = Math.min(
      input.config.retryMaxSeconds,
      input.config.retryBaseSeconds * 2 ** Math.max(0, attemptCount - 1),
    );
    const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, random())));
    return new Date(timestamp.getTime() + (base + jitter) * 1_000);
  }
}

function ownerTarget(event: OutboxEventDocument): {
  type: OwnerNotificationType;
  aggregateType: import('./communications.types.js').OwnerNotificationAggregateType;
  permission: import('../../modules/identity/owner/owner.types.js').VenuePermission;
} | null {
  if (event.event_type === 'BOOKING_CONFIRMED') {
    return {
      type: 'BOOKING_CONFIRMED',
      aggregateType: 'BOOKING',
      permission: 'VIEW_BOOKINGS',
    };
  }
  if (event.event_type === 'BOOKING_CANCELLED') {
    return {
      type: 'BOOKING_CANCELLED',
      aggregateType: 'BOOKING',
      permission: 'VIEW_BOOKINGS',
    };
  }
  if (event.event_type === 'PAYOUT_PAID') {
    return {
      type: 'PAYOUT_COMPLETED',
      aggregateType: 'PAYOUT',
      permission: 'VIEW_FINANCE',
    };
  }
  const mapped = {
    PAYOUT_PENDING: ['PAYOUT_PENDING', 'PAYOUT', 'VIEW_FINANCE'],
    PAYOUT_FAILED: ['PAYOUT_FAILED', 'PAYOUT', 'VIEW_FINANCE'],
    SETTLEMENT_DRAFT_CREATED: ['SETTLEMENT_CREATED', 'SETTLEMENT', 'VIEW_FINANCE'],
    SETTLEMENT_COMPLETED: ['SETTLEMENT_COMPLETED', 'SETTLEMENT', 'VIEW_FINANCE'],
    CONTRACT_PROPOSED: ['CONTRACT_PROPOSED', 'CONTRACT', 'MANAGE_VENUE'],
    CONTRACT_ACCEPTED: ['CONTRACT_ACCEPTED', 'CONTRACT', 'MANAGE_VENUE'],
    KYC_SUBMITTED: ['KYC_SUBMITTED', 'KYC', 'MANAGE_KYC'],
    KYC_VERIFIED: ['KYC_VERIFIED', 'KYC', 'MANAGE_KYC'],
    KYC_REJECTED: ['KYC_REJECTED', 'KYC', 'MANAGE_KYC'],
    PAYMENT_RECORDED: ['PAYMENT_RECORDED', 'PAYMENT', 'VIEW_FINANCE'],
    PAYMENT_REFUNDED: ['PAYMENT_REFUNDED', 'PAYMENT', 'VIEW_FINANCE'],
    VENUE_UPDATED: ['VENUE_UPDATED', 'VENUE', 'MANAGE_VENUE'],
    COURT_UPDATED: ['COURT_UPDATED', 'COURT', 'MANAGE_COURTS'],
    AVAILABILITY_CHANGED: ['AVAILABILITY_CHANGED', 'INVENTORY', 'MANAGE_AVAILABILITY'],
  } as const;
  const value = mapped[event.event_type as keyof typeof mapped];
  if (value) return { type: value[0], aggregateType: value[1], permission: value[2] };
  return null;
}

function notificationAggregate(type: OwnerNotificationType): import('./communications.types.js').OwnerNotificationAggregateType {
  if (type.startsWith('BOOKING_')) return 'BOOKING';
  if (type.startsWith('PAYMENT_')) return 'PAYMENT';
  if (type.startsWith('SETTLEMENT_')) return 'SETTLEMENT';
  if (type.startsWith('PAYOUT_')) return 'PAYOUT';
  if (type.startsWith('CONTRACT_')) return 'CONTRACT';
  if (type.startsWith('KYC_')) return 'KYC';
  if (type === 'VENUE_UPDATED') return 'VENUE';
  if (type === 'COURT_UPDATED') return 'COURT';
  return 'INVENTORY';
}

function webhookEnvelope(event: OutboxEventDocument): WebhookEnvelope {
  return {
    id: event._id.toHexString(),
    eventType: externalEventType(event.event_type),
    eventVersion: event.event_version,
    occurredAt: event.created_at.toISOString(),
    environment: event.environment,
    aggregate: {
      type: event.aggregate_type,
      id: event.aggregate_id.toHexString(),
    },
    correlationId: event.correlation_id,
    data: event.payload,
  };
}

function newDelivery(
  endpointId: ObjectId,
  timestamp: Date,
): WebhookDeliveryDocument {
  return {
    endpoint_id: endpointId,
    status: 'PENDING',
    attempt_count: 0,
    next_attempt_at: timestamp,
    last_error: null,
    delivered_at: null,
    attempts: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function terminalDelivery(
  delivery: WebhookDeliveryDocument,
  message: string,
  timestamp: Date,
): WebhookDeliveryDocument {
  return {
    ...delivery,
    status: 'FAILED',
    next_attempt_at: null,
    last_error: message,
    updated_at: timestamp,
  };
}

function notificationView(value: OwnerNotificationDocument) {
  return {
    notificationType: value.notification_type,
    aggregateType: value.aggregate_type,
    aggregateId: value.aggregate_id.toHexString(),
    venueId: value.venue_id.toHexString(),
    payload: value.payload,
    readAt: value.read_at?.toISOString() ?? null,
    createdAt: value.created_at.toISOString(),
  };
}

function deliveryListView(value: Record<string, unknown>) {
  const delivery = value.delivery as WebhookDeliveryDocument;
  return {
    eventId: hex(value.event_id),
    partnerId: nullableHex(value.partner_id),
    environment: value.environment,
    eventType: value.event_type,
    aggregateType: value.aggregate_type,
    aggregateId: hex(value.aggregate_id),
    correlationId: value.correlation_id,
    delivery: deliveryView(delivery),
    createdAt: iso(value.created_at),
  };
}

function eventView(value: OutboxEventDocument) {
  return {
    eventId: value._id.toHexString(),
    aggregateType: value.aggregate_type,
    aggregateId: value.aggregate_id.toHexString(),
    partnerId: value.partner_id?.toHexString() ?? null,
    venueId: value.venue_id?.toHexString() ?? null,
    environment: value.environment,
    eventType: value.event_type,
    externalEventType: externalEventType(value.event_type),
    eventVersion: value.event_version,
    correlationId: value.correlation_id,
    payload: value.payload,
    status: value.status,
    attempts: value.attempts,
    availableAt: value.available_at.toISOString(),
    lockedBy: value.locked_by,
    lockedUntil: value.locked_until?.toISOString() ?? null,
    webhookEndpointIds: value.webhook_endpoint_ids.map((id) =>
      id.toHexString()),
    publishedAt: value.published_at?.toISOString() ?? null,
    webhookDeliveries: value.webhook_deliveries.map(deliveryView),
    createdAt: value.created_at.toISOString(),
    updatedAt: value.updated_at.toISOString(),
  };
}

function deliveryView(value: WebhookDeliveryDocument) {
  return {
    endpointId: value.endpoint_id.toHexString(),
    status: value.status,
    attemptCount: value.attempt_count,
    nextAttemptAt: value.next_attempt_at?.toISOString() ?? null,
    lastError: value.last_error,
    deliveredAt: value.delivered_at?.toISOString() ?? null,
    attempts: value.attempts.map((attempt) => ({
      attemptedAt: attempt.attempted_at.toISOString(),
      requestPayload: attempt.request_payload,
      redactedHeaders: attempt.redacted_headers,
      responseCode: attempt.response_code,
      responsePayload: attempt.response_payload,
      error: attempt.error,
      completedAt: attempt.completed_at.toISOString(),
    })),
    createdAt: value.created_at.toISOString(),
    updatedAt: value.updated_at.toISOString(),
  };
}

function hex(value: unknown): string {
  if (value instanceof ObjectId) return value.toHexString();
  return String(value);
}

function nullableHex(value: unknown): string | null {
  return value === null || value === undefined ? null : hex(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function page(pageValue = 1, limitValue = 20) {
  if (
    !Number.isInteger(pageValue) ||
    pageValue < 1 ||
    !Number.isInteger(limitValue) ||
    limitValue < 1 ||
    limitValue > 100
  ) {
    throw badRequest('INVALID_PAGINATION', 'Pagination values are invalid');
  }
  return { page: pageValue, limit: limitValue };
}

function pageMetadata(total: number, pageValue: number, limit: number) {
  return {
    page: pageValue,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

function instant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('INVALID_DATE', `${field} must be an ISO date-time`);
  }
  return parsed;
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw badRequest('INVALID_ID', 'A supplied identifier is invalid');
  }
  return new ObjectId(value);
}

function badRequest(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}

function ownerNotFound(): AppError {
  return new AppError({
    code: 'OWNER_NOT_FOUND',
    message: 'The Venue Owner was not found',
    statusCode: 404,
  });
}

function eventNotFound(): AppError {
  return new AppError({
    code: 'OUTBOX_EVENT_NOT_FOUND',
    message: 'The Outbox event was not found',
    statusCode: 404,
  });
}
