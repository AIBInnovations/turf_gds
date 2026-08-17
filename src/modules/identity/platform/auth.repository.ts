import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { AdminUserDocument } from './auth.types.js';

export interface AdminAuthRepository {
  findByEmail(email: string): Promise<AdminUserDocument | null>;
  findById(id: ObjectId): Promise<AdminUserDocument | null>;
  recordLogin(id: ObjectId, now: Date): Promise<void>;
  recordFailedLogin(
    id: ObjectId,
    maximumAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<void>;
  resetLoginFailures(id: ObjectId, now: Date): Promise<void>;
  createAdmin(admin: AdminUserDocument): Promise<void>;
  revokeToken?(
    jti: string,
    adminId: ObjectId,
    expiresAt: Date,
    now: Date,
  ): Promise<void>;
  isTokenRevoked?(jti: string): Promise<boolean>;
}

export function createAdminAuthRepository(
  database: DatabaseConnection,
): AdminAuthRepository {
  const admins = () => database.db.collection<AdminUserDocument>('admin_users');

  return {
    findByEmail(email) {
      return admins().findOne({ email });
    },
    findById(id) {
      return admins().findOne({ _id: id });
    },
    async recordLogin(id, now) {
      await admins().updateOne(
        { _id: id },
        {
          $set: {
            last_login_at: now,
            failed_login_count: 0,
            locked_until: null,
            updated_at: now,
          },
        },
      );
    },
    async recordFailedLogin(id, maximumAttempts, lockedUntil, now) {
      await admins().updateOne({ _id: id }, [
        {
          $set: {
            failed_login_count: { $add: ['$failed_login_count', 1] },
            locked_until: {
              $cond: [
                {
                  $gte: [{ $add: ['$failed_login_count', 1] }, maximumAttempts],
                },
                lockedUntil,
                '$locked_until',
              ],
            },
            updated_at: now,
          },
        },
      ]);
    },
    async resetLoginFailures(id, now) {
      await admins().updateOne(
        { _id: id },
        {
          $set: { failed_login_count: 0, locked_until: null, updated_at: now },
        },
      );
    },
    async createAdmin(admin) {
      await admins().insertOne(admin);
    },
    async revokeToken(jti, adminId, expiresAt, now) {
      await database.db
        .collection('admin_revoked_tokens')
        .updateOne(
          { jti },
          {
            $setOnInsert: {
              _id: new ObjectId(),
              jti,
              admin_id: adminId,
              expires_at: expiresAt,
              created_at: now,
            },
          },
          { upsert: true },
        );
    },
    async isTokenRevoked(jti) {
      return Boolean(
        await database.db
          .collection('admin_revoked_tokens')
          .findOne({ jti }, { projection: { _id: 1 } }),
      );
    },
  };
}
