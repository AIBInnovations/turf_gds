import { ObjectId, type ClientSession } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type {
  KycDocumentDocument,
  KycStatus,
  KycSubjectType,
  KycVerificationDocument,
} from './kyc.types.js';

export interface KycRepository {
  createDraft(input: {
    subjectType: KycSubjectType;
    subjectId: ObjectId;
    verificationType: string;
    now: Date;
  }): Promise<KycVerificationDocument>;
  findVerification(id: ObjectId): Promise<KycVerificationDocument | null>;
  findCurrent(
    subjectType: KycSubjectType,
    subjectId: ObjectId,
    verificationType: string,
    session?: ClientSession,
  ): Promise<KycVerificationDocument | null>;
  insertDocument(document: KycDocumentDocument): Promise<void>;
  countActiveDocuments(verificationId: ObjectId): Promise<number>;
  submit(id: ObjectId, subjectId: ObjectId, now: Date): Promise<boolean>;
  review(input: {
    id: ObjectId;
    adminId: ObjectId;
    status: Extract<KycStatus, 'VERIFIED' | 'REJECTED'>;
    rejectionReason: string | null;
    expiresAt: Date | null;
    now: Date;
  }): Promise<boolean>;
}

export function createKycRepository(
  database: DatabaseConnection,
): KycRepository {
  const verifications = () =>
    database.db.collection<KycVerificationDocument>('kyc_verifications');
  const documents = () =>
    database.db.collection<KycDocumentDocument>('kyc_documents');

  async function createDraft(input: {
    subjectType: KycSubjectType;
    subjectId: ObjectId;
    verificationType: string;
    now: Date;
  }): Promise<KycVerificationDocument> {
    return database.withTransaction(async ({ session }) => {
      await verifications().updateMany(
        {
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          verification_type: input.verificationType,
          is_current: true,
        },
        {
          $set: { is_current: false, updated_at: input.now },
        },
        ...(session ? [{ session }] : []),
      );
      const verification: KycVerificationDocument = {
        _id: new ObjectId(),
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        verification_type: input.verificationType,
        status: 'DRAFT',
        is_current: true,
        submitted_at: null,
        reviewed_by: null,
        reviewed_at: null,
        rejection_reason: null,
        expires_at: null,
        created_at: input.now,
        updated_at: input.now,
      };
      await verifications().insertOne(verification, { session });
      return verification;
    });
  }

  return {
    createDraft,
    findVerification(id) {
      return verifications().findOne({ _id: id });
    },
    findCurrent(subjectType, subjectId, verificationType, session) {
      return verifications().findOne(
        {
          subject_type: subjectType,
          subject_id: subjectId,
          verification_type: verificationType,
          is_current: true,
        },
        ...(session ? [{ session }] : []),
      );
    },
    async insertDocument(document) {
      await documents().insertOne(document);
    },
    countActiveDocuments(verificationId) {
      return documents().countDocuments({
        kyc_verification_id: verificationId,
        status: 'ACTIVE',
      });
    },
    async submit(id, subjectId, now) {
      const result = await verifications().updateOne(
        {
          _id: id,
          subject_id: subjectId,
          status: 'DRAFT',
          is_current: true,
        },
        {
          $set: {
            status: 'SUBMITTED',
            submitted_at: now,
            updated_at: now,
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async review(input) {
      const result = await verifications().updateOne(
        {
          _id: input.id,
          status: { $in: ['SUBMITTED', 'IN_REVIEW'] },
          is_current: true,
        },
        {
          $set: {
            status: input.status,
            reviewed_by: input.adminId,
            reviewed_at: input.now,
            rejection_reason: input.rejectionReason,
            expires_at: input.expiresAt,
            updated_at: input.now,
          },
        },
      );
      return result.modifiedCount > 0;
    },
  };
}
