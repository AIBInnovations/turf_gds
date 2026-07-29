import { ObjectId, type ClientSession } from 'mongodb';

import type { DatabaseConnection } from '../database/database-connection.js';
import type { WebhookEndpointDocument } from '../../modules/identity/partner/partner-access.types.js';

export interface OutboxEventDocument {
  _id: ObjectId;
  aggregate_type: string;
  aggregate_id: ObjectId;
  partner_id: ObjectId | null;
  venue_id: ObjectId | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  event_type: string;
  event_version: number;
  correlation_id: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  available_at: Date;
  locked_by: string | null;
  locked_until: Date | null;
  webhook_endpoint_ids: ObjectId[];
  published_at: Date | null;
  webhook_deliveries: unknown[];
  created_at: Date;
  updated_at: Date;
}

export interface OutboxRepository {
  enqueue(input: {
    aggregateType: string;
    aggregateId: ObjectId;
    partnerId: ObjectId | null;
    venueId: ObjectId | null;
    environment: 'SANDBOX' | 'PRODUCTION';
    eventType: string;
    eventVersion: number;
    correlationId: string;
    payload: Record<string, unknown>;
    now: Date;
    session: ClientSession;
  }): Promise<void>;
}

export function createOutboxRepository(
  database: DatabaseConnection,
): OutboxRepository {
  return {
    async enqueue(input) {
      const webhookEndpointIds = input.partnerId
        ? (
            await database.db
              .collection<WebhookEndpointDocument>('webhook_endpoints')
              .find(
                {
                  partner_id: input.partnerId,
                  environment: input.environment,
                  status: 'ACTIVE',
                },
                { session: input.session, projection: { _id: 1 } },
              )
              .toArray()
          ).map(({ _id }) => _id)
        : [];
      const event: OutboxEventDocument = {
        _id: new ObjectId(),
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        partner_id: input.partnerId,
        venue_id: input.venueId,
        environment: input.environment,
        event_type: input.eventType,
        event_version: input.eventVersion,
        correlation_id: input.correlationId,
        payload: input.payload,
        status: 'PENDING',
        attempts: 0,
        available_at: input.now,
        locked_by: null,
        locked_until: null,
        webhook_endpoint_ids: webhookEndpointIds,
        published_at: null,
        webhook_deliveries: [],
        created_at: input.now,
        updated_at: input.now,
      };
      await database.db
        .collection<OutboxEventDocument>('outbox_events')
        .insertOne(event, { session: input.session });
    },
  };
}
