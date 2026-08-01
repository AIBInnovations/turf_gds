import { ObjectId, type Filter } from 'mongodb';

import type { WebhookEndpointDocument } from '../../modules/identity/partner/partner-access.types.js';
import type { VenuePermission } from '../../modules/identity/owner/owner.types.js';
import type { DatabaseConnection } from '../database/database-connection.js';
import type {
  DevicePlatform,
  FcmTokenDocument,
  OutboxEventDocument,
  OwnerNotificationDocument,
  OwnerNotificationType,
  OwnerNotificationAggregateType,
  WebhookDeliveryDocument,
} from './communications.types.js';

interface Membership {
  owner_id: ObjectId;
  venue_id: ObjectId;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  status: 'ACTIVE' | 'REVOKED';
}

interface RolePermission {
  role: Membership['role'];
  permission: VenuePermission;
}

interface OwnerDocument {
  _id: ObjectId;
  status: 'ACTIVE' | 'SUSPENDED';
  fcm_tokens: FcmTokenDocument[];
  notifications: OwnerNotificationDocument[];
  updated_at: Date;
}

export interface CommunicationsRepository {
  claimNext(input: {
    workerId: string;
    now: Date;
    lockedUntil: Date;
  }): Promise<OutboxEventDocument | null>;
  renewLease(input: {
    eventId: ObjectId;
    workerId: string;
    now: Date;
    lockedUntil: Date;
  }): Promise<boolean>;
  saveEvent(input: {
    eventId: ObjectId;
    workerId: string;
    status: OutboxEventDocument['status'];
    deliveries: WebhookDeliveryDocument[];
    availableAt: Date;
    publishedAt: Date | null;
    now: Date;
  }): Promise<boolean>;
  findEndpoint(id: ObjectId): Promise<WebhookEndpointDocument | null>;
  listRecipientOwnerIds(
    venueId: ObjectId,
    permission: VenuePermission,
  ): Promise<ObjectId[]>;
  appendNotification(
    ownerId: ObjectId,
    notification: OwnerNotificationDocument,
    now: Date,
  ): Promise<boolean>;
  listOwnerTokens(ownerId: ObjectId): Promise<FcmTokenDocument[]>;
  removeOwnerTokens(ownerId: ObjectId, tokens: string[], now: Date): Promise<void>;
  upsertDevice(input: {
    ownerId: ObjectId;
    deviceId: string;
    token: string;
    platform: DevicePlatform;
    now: Date;
  }): Promise<'UPDATED' | 'TOKEN_CONFLICT' | 'OWNER_NOT_FOUND'>;
  removeDevice(ownerId: ObjectId, deviceId: string, now: Date): Promise<boolean>;
  listNotifications(input: {
    ownerId: ObjectId;
    venueId?: ObjectId;
    type?: OwnerNotificationType;
    unreadOnly?: boolean;
    page: number;
    limit: number;
  }): Promise<{
    items: OwnerNotificationDocument[];
    total: number;
    unreadCount: number;
  }>;
  markNotificationRead(input: {
    ownerId: ObjectId;
    notificationType: OwnerNotificationType;
    aggregateType: OwnerNotificationAggregateType;
    aggregateId: ObjectId;
    now: Date;
  }): Promise<'UPDATED' | 'ALREADY_READ' | 'NOT_FOUND'>;
  listDeliveries(input: {
    partnerId?: ObjectId;
    endpointId?: ObjectId;
    environment?: 'SANDBOX' | 'PRODUCTION';
    eventType?: string;
    status?: WebhookDeliveryDocument['status'];
    from?: Date;
    to?: Date;
    page: number;
    limit: number;
  }): Promise<{ items: Record<string, unknown>[]; total: number }>;
  findEvent(id: ObjectId): Promise<OutboxEventDocument | null>;
  scheduleRetry(
    eventId: ObjectId,
    endpointId: ObjectId,
    now: Date,
  ): Promise<boolean>;
}

export function createCommunicationsRepository(
  database: DatabaseConnection,
): CommunicationsRepository {
  const events = () =>
    database.db.collection<OutboxEventDocument>('outbox_events');
  const endpoints = () =>
    database.db.collection<WebhookEndpointDocument>('webhook_endpoints');
  const owners = () => database.db.collection<OwnerDocument>('venue_owners');

  return {
    async claimNext(input) {
      return events().findOneAndUpdate(
        {
          $or: [
            { status: 'PENDING', available_at: { $lte: input.now } },
            {
              status: 'PROCESSING',
              locked_until: { $lte: input.now },
            },
          ],
        },
        {
          $set: {
            status: 'PROCESSING',
            locked_by: input.workerId,
            locked_until: input.lockedUntil,
            updated_at: input.now,
          },
          $inc: { attempts: 1 },
        },
        {
          sort: { available_at: 1, _id: 1 },
          returnDocument: 'after',
        },
      );
    },
    async renewLease(input) {
      const result = await events().updateOne(
        {
          _id: input.eventId,
          status: 'PROCESSING',
          locked_by: input.workerId,
        },
        {
          $set: {
            locked_until: input.lockedUntil,
            updated_at: input.now,
          },
        },
      );
      return result.matchedCount > 0;
    },
    async saveEvent(input) {
      const result = await events().updateOne(
        {
          _id: input.eventId,
          status: 'PROCESSING',
          locked_by: input.workerId,
        },
        {
          $set: {
            status: input.status,
            webhook_deliveries: input.deliveries,
            available_at: input.availableAt,
            published_at: input.publishedAt,
            locked_by: null,
            locked_until: null,
            updated_at: input.now,
          },
        },
      );
      return result.modifiedCount > 0;
    },
    findEndpoint(id) {
      return endpoints().findOne({ _id: id });
    },
    async listRecipientOwnerIds(venueId, permission) {
      const roleDocuments = await database.db
        .collection<RolePermission>('venue_role_permissions')
        .find({ permission }, { projection: { role: 1 } })
        .toArray();
      const roles = roleDocuments.map(({ role }) => role);
      if (roles.length === 0) return [];
      const memberships = await database.db
        .collection<Membership>('venue_owner_memberships')
        .find(
          { venue_id: venueId, status: 'ACTIVE', role: { $in: roles } },
          { projection: { owner_id: 1 } },
        )
        .toArray();
      const ownerIds = memberships.map(({ owner_id }) => owner_id);
      if (ownerIds.length === 0) return [];
      const active = await owners()
        .find(
          { _id: { $in: ownerIds }, status: 'ACTIVE' },
          { projection: { _id: 1 } },
        )
        .toArray();
      return active.map(({ _id }) => _id);
    },
    async appendNotification(ownerId, notification, now) {
      const result = await owners().updateOne(
        {
          _id: ownerId,
          status: 'ACTIVE',
          notifications: {
            $not: {
              $elemMatch: {
                notification_type: notification.notification_type,
                aggregate_type: notification.aggregate_type,
                aggregate_id: notification.aggregate_id,
              },
            },
          },
        },
        {
          $push: {
            notifications: {
              $each: [notification],
              $slice: -100,
            },
          },
          $set: { updated_at: now },
        },
      );
      return result.modifiedCount > 0;
    },
    async listOwnerTokens(ownerId) {
      const owner = await owners().findOne(
        { _id: ownerId, status: 'ACTIVE' },
        { projection: { fcm_tokens: 1 } },
      );
      return owner?.fcm_tokens ?? [];
    },
    async removeOwnerTokens(ownerId, tokens, now) {
      if (tokens.length === 0) return;
      await owners().updateOne(
        { _id: ownerId },
        {
          $pull: { fcm_tokens: { token: { $in: tokens } } },
          $set: { updated_at: now },
        },
      );
    },
    async upsertDevice(input) {
      const conflict = await owners().findOne(
        {
          _id: { $ne: input.ownerId },
          'fcm_tokens.token': input.token,
        },
        { projection: { _id: 1 } },
      );
      if (conflict) return 'TOKEN_CONFLICT';
      const owner = await owners().findOne(
        { _id: input.ownerId, status: 'ACTIVE' },
        { projection: { _id: 1, fcm_tokens: 1 } },
      );
      if (!owner) return 'OWNER_NOT_FOUND';
      const retained = (owner.fcm_tokens ?? []).filter(
        ({ device_id, token }) =>
          device_id !== input.deviceId && token !== input.token,
      );
      const existing = (owner.fcm_tokens ?? []).find(
        ({ device_id }) => device_id === input.deviceId,
      );
      const next: FcmTokenDocument = {
        token: input.token,
        device_id: input.deviceId,
        platform: input.platform,
        last_seen_at: input.now,
        created_at: existing?.created_at ?? input.now,
      };
      try {
        const result = await owners().updateOne(
          { _id: input.ownerId, status: 'ACTIVE' },
          {
            $set: {
              fcm_tokens: [...retained, next].slice(-20),
              updated_at: input.now,
            },
          },
        );
        return result.matchedCount ? 'UPDATED' : 'OWNER_NOT_FOUND';
      } catch (error) {
        if (duplicate(error)) return 'TOKEN_CONFLICT';
        throw error;
      }
    },
    async removeDevice(ownerId, deviceId, now) {
      const result = await owners().updateOne(
        { _id: ownerId, 'fcm_tokens.device_id': deviceId },
        {
          $pull: { fcm_tokens: { device_id: deviceId } },
          $set: { updated_at: now },
        },
      );
      return result.modifiedCount > 0;
    },
    async listNotifications(input) {
      const owner = await owners().findOne(
        { _id: input.ownerId, status: 'ACTIVE' },
        { projection: { notifications: 1 } },
      );
      const all = [...(owner?.notifications ?? [])].sort(
        (a, b) =>
          b.created_at.getTime() - a.created_at.getTime() ||
          b.aggregate_id.toHexString().localeCompare(
            a.aggregate_id.toHexString(),
          ),
      );
      const unreadCount = all.filter(({ read_at }) => read_at === null).length;
      const filtered = all.filter(
        (value) =>
          (!input.venueId || value.venue_id.equals(input.venueId)) &&
          (!input.type || value.notification_type === input.type) &&
          (!input.unreadOnly || value.read_at === null),
      );
      const offset = (input.page - 1) * input.limit;
      return {
        items: filtered.slice(offset, offset + input.limit),
        total: filtered.length,
        unreadCount,
      };
    },
    async markNotificationRead(input) {
      const owner = await owners().findOne(
        {
          _id: input.ownerId,
          notifications: {
            $elemMatch: {
              notification_type: input.notificationType,
              aggregate_type: input.aggregateType,
              aggregate_id: input.aggregateId,
            },
          },
        },
        { projection: { notifications: 1 } },
      );
      if (!owner) return 'NOT_FOUND';
      const notification = owner.notifications.find(
        (value) =>
          value.notification_type === input.notificationType &&
          value.aggregate_type === input.aggregateType &&
          value.aggregate_id.equals(input.aggregateId),
      );
      if (notification?.read_at) return 'ALREADY_READ';
      const result = await owners().updateOne(
        { _id: input.ownerId },
        {
          $set: {
            'notifications.$[notification].read_at': input.now,
            updated_at: input.now,
          },
        },
        {
          arrayFilters: [{
            'notification.notification_type': input.notificationType,
            'notification.aggregate_type': input.aggregateType,
            'notification.aggregate_id': input.aggregateId,
            'notification.read_at': null,
          }],
        },
      );
      return result.modifiedCount ? 'UPDATED' : 'ALREADY_READ';
    },
    async listDeliveries(input) {
      const eventMatch: Filter<OutboxEventDocument> = {
        ...(input.partnerId ? { partner_id: input.partnerId } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.eventType ? { event_type: input.eventType } : {}),
        ...(input.from || input.to
          ? {
              created_at: {
                ...(input.from ? { $gte: input.from } : {}),
                ...(input.to ? { $lt: input.to } : {}),
              },
            }
          : {}),
      };
      const deliveryMatch: Record<string, unknown> = {
        ...(input.endpointId
          ? { 'webhook_deliveries.endpoint_id': input.endpointId }
          : {}),
        ...(input.status
          ? { 'webhook_deliveries.status': input.status }
          : {}),
      };
      const offset = (input.page - 1) * input.limit;
      const result = await events()
        .aggregate<{
          items: Record<string, unknown>[];
          total: Array<{ count: number }>;
        }>([
          { $match: eventMatch },
          { $unwind: '$webhook_deliveries' },
          { $match: deliveryMatch },
          { $sort: { 'webhook_deliveries.updated_at': -1, _id: -1 } },
          {
            $facet: {
              items: [
                { $skip: offset },
                { $limit: input.limit },
                {
                  $project: {
                    _id: 0,
                    event_id: '$_id',
                    partner_id: 1,
                    environment: 1,
                    event_type: 1,
                    aggregate_type: 1,
                    aggregate_id: 1,
                    correlation_id: 1,
                    delivery: '$webhook_deliveries',
                    created_at: 1,
                  },
                },
              ],
              total: [{ $count: 'count' }],
            },
          },
        ])
        .next();
      return {
        items: result?.items ?? [],
        total: result?.total[0]?.count ?? 0,
      };
    },
    findEvent(id) {
      return events().findOne({ _id: id });
    },
    async scheduleRetry(eventId, endpointId, now) {
      const result = await events().updateOne(
        {
          _id: eventId,
          'webhook_deliveries': {
            $elemMatch: { endpoint_id: endpointId, status: 'FAILED' },
          },
        },
        {
          $set: {
            status: 'PENDING',
            available_at: now,
            locked_by: null,
            locked_until: null,
            published_at: null,
            'webhook_deliveries.$[delivery].status': 'RETRYING',
            'webhook_deliveries.$[delivery].next_attempt_at': now,
            'webhook_deliveries.$[delivery].last_error': null,
            'webhook_deliveries.$[delivery].attempt_count': 0,
            'webhook_deliveries.$[delivery].updated_at': now,
            updated_at: now,
          },
        },
        {
          arrayFilters: [{
            'delivery.endpoint_id': endpointId,
            'delivery.status': 'FAILED',
          }],
        },
      );
      return result.modifiedCount > 0;
    },
  };
}

function duplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}
