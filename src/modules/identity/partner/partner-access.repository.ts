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
    now: Date,
  ): Promise<boolean>;
  approveProduction(
    partnerId: ObjectId,
    adminId: ObjectId,
    now: Date,
  ): Promise<boolean>;
  setIntegrationReviewStatus(
    partnerId: ObjectId,
    status: 'PENDING' | 'PASSED' | 'FAILED',
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
  insertWebhook(endpoint: WebhookEndpointDocument): Promise<boolean>;
  verifyWebhook(id: ObjectId, now: Date): Promise<boolean>;
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
    async approveSandbox(partnerId, adminId, now) {
      const result = await partners().updateOne(
        { _id: partnerId, status: 'PENDING', sandbox_approved_at: null },
        {
          $set: {
            sandbox_approved_at: now,
            updated_at: now,
          },
          $push: {
            audit_history: {
              event_type: 'SANDBOX_APPROVED',
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: new ObjectId().toHexString(),
              changes: {},
              occurred_at: now,
            },
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async approveProduction(partnerId, adminId, now) {
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
          $push: {
            audit_history: {
              event_type: 'PRODUCTION_APPROVED',
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: new ObjectId().toHexString(),
              changes: { status: 'ACTIVE' },
              occurred_at: now,
            },
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async setIntegrationReviewStatus(partnerId, status, now) {
      const result = await partners().updateOne(
        {
          _id: partnerId,
          status: { $in: ['PENDING', 'ACTIVE'] },
        },
        {
          $set: {
            updated_at: now,
          },
          $push: {
            audit_history: {
              event_type: 'INTEGRATION_REVIEW',
              actor_type: 'SYSTEM',
              actor_id: null,
              correlation_id: new ObjectId().toHexString(),
              changes: { status },
              occurred_at: now,
            },
          },
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
          $setOnInsert: { _id: new ObjectId() },
        },
        { upsert: true },
      );
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
