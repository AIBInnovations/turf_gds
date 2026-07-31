import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type {
  ApiUsageDailyDocument,
  PartnerApiKeyDocument,
  PartnerDocument,
  PartnerEnvironment,
  WebhookEndpointDocument,
} from './partner-access.types.js';

export interface PartnerAccessRepository {
  createPartner(partner: PartnerDocument): Promise<boolean>;
  findPartner(id: ObjectId): Promise<PartnerDocument | null>;
  approveSandbox(
    partnerId: ObjectId,
    adminId: ObjectId,
    correlationId: string,
    now: Date,
  ): Promise<boolean>;
  approveProduction(
    partnerId: ObjectId,
    adminId: ObjectId,
    correlationId: string,
    now: Date,
  ): Promise<boolean>;
  setIntegrationReviewStatus(
    partnerId: ObjectId,
    adminId: ObjectId,
    status: 'PENDING' | 'PASSED' | 'FAILED',
    correlationId: string,
    now: Date,
  ): Promise<boolean>;
  insertApiKey(key: PartnerApiKeyDocument): Promise<void>;
  findApiKeyByPrefix(
    prefix: string,
  ): Promise<PartnerApiKeyDocument | null>;
  touchApiKey(id: ObjectId, now: Date): Promise<void>;
  revokeApiKey(id: ObjectId, now: Date): Promise<boolean>;
  recordUsage(input: {
    partnerId: ObjectId;
    environment: PartnerEnvironment;
    statusCode: number;
    latencyMs: number;
    rateLimited: boolean;
    now: Date;
  }): Promise<void>;
  setRateLimitTier?(
    partnerId: ObjectId,
    tier: PartnerDocument['rate_limit_tier'],
    adminId: ObjectId,
    correlationId: string,
    now: Date,
  ): Promise<boolean>;
  consumeRateLimitWindow?(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    limit: number;
    windowStartedAt: Date;
    now: Date;
  }): Promise<{ count: number }>;
  insertWebhook(endpoint: WebhookEndpointDocument): Promise<boolean>;
  verifyWebhook(id: ObjectId, now: Date): Promise<boolean>;
  replaceWebhookSubscriptions(
    id: ObjectId,
    partnerId: ObjectId,
    environment: PartnerEnvironment,
    subscribedEventTypes: WebhookEndpointDocument['subscribed_event_types'],
    now: Date,
  ): Promise<boolean>;
  disableWebhook(
    id: ObjectId,
    partnerId: ObjectId,
    environment: PartnerEnvironment,
    now: Date,
  ): Promise<boolean>;
}

export function createPartnerAccessRepository(
  database: DatabaseConnection,
): PartnerAccessRepository {
  const partners = () =>
    database.db.collection<PartnerDocument>('partners');
  const apiKeys = () =>
    database.db.collection<PartnerApiKeyDocument>('partner_api_keys');
  const usage = () =>
    database.db.collection<ApiUsageDailyDocument>('api_usage_daily');
  const webhooks = () =>
    database.db.collection<WebhookEndpointDocument>('webhook_endpoints');

  return {
    async createPartner(partner) {
      try {
        await partners().insertOne(partner);
        return true;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return false;
        }
        throw error;
      }
    },
    findPartner(id) {
      return partners().findOne({ _id: id });
    },
    async approveSandbox(partnerId, adminId, correlationId, now) {
      const result = await partners().updateOne(
        { _id: partnerId, status: 'PENDING', sandbox_approved_at: null },
        {
          $set: {
            sandbox_approved_at: now,
            updated_at: now,
          },
          $push: { audit_history: boundedAudit({
            event_type: 'SANDBOX_APPROVED',
            actor_type: 'ADMIN',
            actor_id: adminId,
            correlation_id: correlationId,
            changes: {},
            occurred_at: now,
          }) },
        },
      );
      return result.modifiedCount > 0;
    },
    async approveProduction(partnerId, adminId, correlationId, now) {
      const result = await partners().updateOne(
        {
          _id: partnerId,
          status: 'PENDING',
          sandbox_approved_at: { $ne: null },
          audit_history: {
            $elemMatch: {
              event_type: 'INTEGRATION_REVIEW',
              'changes.status': 'PASSED',
            },
          },
        },
        {
          $set: {
            status: 'ACTIVE',
            production_approved_by: adminId,
            production_approved_at: now,
            updated_at: now,
          },
          $push: { audit_history: boundedAudit({
            event_type: 'PRODUCTION_APPROVED',
            actor_type: 'ADMIN',
            actor_id: adminId,
            correlation_id: correlationId,
            changes: { status: 'ACTIVE' },
            occurred_at: now,
          }) },
        },
      );
      return result.modifiedCount > 0;
    },
    async setIntegrationReviewStatus(
      partnerId,
      adminId,
      status,
      correlationId,
      now,
    ) {
      const result = await partners().updateOne(
        {
          _id: partnerId,
          status: { $in: ['PENDING', 'ACTIVE'] },
        },
        {
          $set: {
            updated_at: now,
          },
          $push: { audit_history: boundedAudit({
            event_type: 'INTEGRATION_REVIEW',
            actor_type: 'ADMIN',
            actor_id: adminId,
            correlation_id: correlationId,
            changes: { status },
            occurred_at: now,
          }) },
        },
      );
      return result.matchedCount > 0;
    },
    async insertApiKey(key) {
      await apiKeys().insertOne(key);
    },
    findApiKeyByPrefix(prefix) {
      return apiKeys().findOne({ key_prefix: prefix });
    },
    async touchApiKey(id, now) {
      await apiKeys().updateOne(
        { _id: id },
        { $set: { last_used_at: now } },
      );
    },
    async revokeApiKey(id, now) {
      const result = await apiKeys().updateOne(
        { _id: id, status: 'ACTIVE' },
        {
          $set: {
            status: 'REVOKED',
            revoked_at: now,
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async recordUsage(input) {
      const usageDate = new Date(input.now);
      usageDate.setUTCHours(0, 0, 0, 0);
      await usage().updateOne(
        {
          partner_id: input.partnerId,
          environment: input.environment,
          usage_date: usageDate,
        },
        {
          $inc: {
            request_count: 1,
            error_count: input.statusCode >= 400 ? 1 : 0,
            rate_limited_count: input.rateLimited ? 1 : 0,
          },
          $max: {
            p95_latency_ms: Math.max(0, Math.round(input.latencyMs)),
          },
          $set: { updated_at: input.now },
          $setOnInsert: {
            _id: new ObjectId(),
            rate_limit_window_started_at: new Date(0),
            rate_limit_window_count: 0,
          },
        },
        { upsert: true },
      );
    },
    async setRateLimitTier(
      partnerId,
      tier,
      adminId,
      correlationId,
      now,
    ) {
      const result = await partners().updateOne(
        { _id: partnerId, status: { $in: ['PENDING', 'ACTIVE'] } },
        {
          $set: { rate_limit_tier: tier, updated_at: now },
          $push: {
            audit_history: boundedAudit({
              event_type: 'RATE_LIMIT_TIER_CHANGED',
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: correlationId,
              changes: { rate_limit_tier: tier },
              occurred_at: now,
            }),
          },
        },
      );
      return result.matchedCount > 0;
    },
    async consumeRateLimitWindow(input) {
      const partnerId = new ObjectId(input.partnerId);
      const usageDate = new Date(input.now);
      usageDate.setUTCHours(0, 0, 0, 0);
      const filter = {
        partner_id: partnerId,
        environment: input.environment,
        usage_date: usageDate,
      };
      const update = [
          {
            $set: {
              _id: { $ifNull: ['$_id', new ObjectId()] },
              partner_id: partnerId,
              environment: input.environment,
              usage_date: usageDate,
              request_count: { $ifNull: ['$request_count', 0] },
              error_count: { $ifNull: ['$error_count', 0] },
              rate_limited_count: { $ifNull: ['$rate_limited_count', 0] },
              p95_latency_ms: { $ifNull: ['$p95_latency_ms', 0] },
              rate_limit_window_count: {
                $cond: [
                  {
                    $eq: [
                      '$rate_limit_window_started_at',
                      input.windowStartedAt,
                    ],
                  },
                  { $add: [{ $ifNull: ['$rate_limit_window_count', 0] }, 1] },
                  1,
                ],
              },
              rate_limit_window_started_at: input.windowStartedAt,
              updated_at: input.now,
            },
          },
        ];
      let value;
      try {
        value = await usage().findOneAndUpdate(
          filter,
          update,
          { upsert: true, returnDocument: 'after' },
        );
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        value = await usage().findOneAndUpdate(
          filter,
          update,
          { returnDocument: 'after' },
        );
      }
      return { count: value?.rate_limit_window_count ?? input.limit + 1 };
    },
    async insertWebhook(endpoint) {
      try {
        await webhooks().insertOne(endpoint);
        return true;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return false;
        }
        throw error;
      }
    },
    async verifyWebhook(id, now) {
      const result = await webhooks().updateOne(
        { _id: id, status: 'PENDING' },
        {
          $set: {
            status: 'ACTIVE',
            verified_at: now,
            updated_at: now,
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async replaceWebhookSubscriptions(
      id,
      partnerId,
      environment,
      subscribedEventTypes,
      now,
    ) {
      const result = await webhooks().updateOne(
        {
          _id: id,
          partner_id: partnerId,
          environment,
          status: { $ne: 'DISABLED' },
        },
        {
          $set: {
            subscribed_event_types: subscribedEventTypes,
            updated_at: now,
          },
        },
      );
      return result.matchedCount > 0;
    },
    async disableWebhook(id, partnerId, environment, now) {
      const result = await webhooks().updateOne(
        {
          _id: id,
          partner_id: partnerId,
          environment,
          status: { $ne: 'DISABLED' },
        },
        {
          $set: { status: 'DISABLED', updated_at: now },
        },
      );
      return result.modifiedCount > 0;
    },
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}

function boundedAudit(event: Record<string, unknown>) {
  return { $each: [event], $slice: -100 };
}
