import { ObjectId, type ClientSession } from 'mongodb';

import type { DatabaseConnection } from '../database/database-connection.js';
import type { WebhookEndpointDocument } from '../../modules/identity/partner/partner-access.types.js';
import {
  externalEventType,
  type OutboxEventDocument,
} from './communications.types.js';

export type { OutboxEventDocument } from './communications.types.js';

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
      const routedEventType = externalEventType(input.eventType);
      if (JSON.stringify(input.payload).length > 65_536) {
        throw new Error('Outbox event payload exceeds 64 KiB');
      }
      const webhookEndpointIds = input.partnerId
        ? (
            await database.db
              .collection<WebhookEndpointDocument>('webhook_endpoints')
              .find(
                {
                  partner_id: input.partnerId,
                  environment: input.environment,
                  status: 'ACTIVE',
                  subscribed_event_types: routedEventType,
                },
                { session: input.session, projection: { _id: 1 } },
              )
              .limit(20)
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
        .updateOne(
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_type: event.event_type,
            correlation_id: event.correlation_id,
          },
          { $setOnInsert: event },
          { session: input.session, upsert: true },
        );
    },
  };
}
