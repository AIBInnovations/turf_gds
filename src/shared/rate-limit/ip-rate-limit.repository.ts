import { ObjectId, type Db } from 'mongodb';

import type { IpRateLimitFallback } from './ip-rate-limiter.js';

export interface IpRateLimitWindowDocument {
  _id: ObjectId;
  scope: string;
  ip_hash: string;
  window_started_at: Date;
  count: number;
  expires_at: Date;
  updated_at: Date;
}

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'scope',
      'ip_hash',
      'window_started_at',
      'count',
      'expires_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      scope: { bsonType: 'string' },
      ip_hash: { bsonType: 'string' },
      window_started_at: { bsonType: 'date' },
      count: { bsonType: ['int', 'long'] },
      expires_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

/**
 * A dedicated collection rather than reusing `api_usage_daily`: that one is
 * validated with `partner_id: objectId`, uniquely indexed per partner, and has
 * no TTL — none of which suits an IP key.
 */
export async function initializeIpRateLimitPersistence(db: Db): Promise<void> {
  const exists = await db
    .listCollections({ name: 'ip_rate_limit_windows' }, { nameOnly: true })
    .hasNext();
  if (!exists) {
    await db.createCollection('ip_rate_limit_windows', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: 'ip_rate_limit_windows',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await db
    .collection('ip_rate_limit_windows')
    .createIndex(
      { scope: 1, ip_hash: 1, window_started_at: 1 },
      { unique: true, name: 'uq_ip_rate_limit_window' },
    );
  await db
    .collection('ip_rate_limit_windows')
    .createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0, name: 'ttl_ip_rate_limit_window' },
    );
}

export function createIpRateLimitFallback(db: Db): IpRateLimitFallback {
  const windows = () =>
    db.collection<IpRateLimitWindowDocument>('ip_rate_limit_windows');

  return {
    async consumeIpRateLimitWindow(input) {
      const filter = {
        scope: input.scope,
        ip_hash: input.ipHash,
        window_started_at: input.windowStartedAt,
      };
      // Single atomic upsert-and-increment: no read-modify-write race.
      const update = [
        {
          $set: {
            _id: { $ifNull: ['$_id', new ObjectId()] },
            scope: input.scope,
            ip_hash: input.ipHash,
            window_started_at: input.windowStartedAt,
            count: { $add: [{ $ifNull: ['$count', 0] }, 1] },
            expires_at: new Date(
              input.windowStartedAt.getTime() + input.windowMs * 2,
            ),
            updated_at: input.now,
          },
        },
      ];

      let value;
      try {
        value = await windows().findOneAndUpdate(filter, update, {
          upsert: true,
          returnDocument: 'after',
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        // Lost an upsert race; the document now exists.
        value = await windows().findOneAndUpdate(filter, update, {
          returnDocument: 'after',
        });
      }
      // A missing result means the window could not be counted; deny rather
      // than silently granting unlimited requests.
      return { count: value?.count ?? Number.MAX_SAFE_INTEGER };
    },
  };
}
