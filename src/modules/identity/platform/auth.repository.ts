import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { AdminUserDocument } from './auth.types.js';

export interface AdminAuthRepository {
  findByEmail(email: string): Promise<AdminUserDocument | null>;
  findById(id: ObjectId): Promise<AdminUserDocument | null>;
  recordLogin(id: ObjectId, now: Date): Promise<void>;
  createAdmin(admin: AdminUserDocument): Promise<void>;
}

export function createAdminAuthRepository(
  database: DatabaseConnection,
): AdminAuthRepository {
  const admins = () =>
    database.db.collection<AdminUserDocument>('admin_users');

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
        { $set: { last_login_at: now, updated_at: now } },
      );
    },
    async createAdmin(admin) {
      await admins().insertOne(admin);
    },
  };
}
