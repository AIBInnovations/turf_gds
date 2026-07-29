import { ObjectId, type ClientSession } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type {
  KycDocumentDocument,
  KycStatus,
  KycSubjectType,
  KycVerificationType,
  KycVerificationDocument,
} from './kyc.types.js';

export interface KycRepository {
  createDraft(input: {
    subjectType: KycSubjectType;
    subjectId: ObjectId;
    verificationType: KycVerificationType;
    now: Date;
  }): Promise<KycVerificationDocument>;
  findVerification(id: ObjectId): Promise<KycVerificationDocument | null>;
  findCurrent(
    subjectType: KycSubjectType,
    subjectId: ObjectId,
    verificationType: KycVerificationType,
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
    verificationType: KycVerificationType;
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
          $set: { is_current: false },
        },
        ...(session ? [{ session }] : []),
      );
      const verification: KycVerificationDocument = {
        _id: new ObjectId(),
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        verification_type: input.verificationType,
        status: 'PENDING',
        is_current: true,
        reviewed_by: null,
        reviewed_at: null,
        rejection_reason: null,
        expires_at: null,
        audit_history: [],
        created_at: input.now,
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
        status: 'PENDING',
      });
    },
    async submit(id, subjectId, _now) {
      const result = await verifications().updateOne(
        {
          _id: id,
          subject_id: subjectId,
          status: 'PENDING',
          is_current: true,
        },
        {
          $set: {
            status: 'PENDING',
          },
          $push: {
            audit_history: {
              event_type: 'KYC_SUBMITTED',
              actor_type: inputActorType(),
              actor_id: subjectId,
              correlation_id: new ObjectId().toHexString(),
              changes: {},
              occurred_at: _now,
            },
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async review(input) {
      const result = await verifications().updateOne(
        {
          _id: input.id,
          status: 'PENDING',
          is_current: true,
        },
        {
          $set: {
            status: input.status,
            reviewed_by: input.adminId,
            reviewed_at: input.now,
            rejection_reason: input.rejectionReason,
            expires_at: input.expiresAt,
          },
        },
      );
      return result.modifiedCount > 0;
    },
  };
}

function inputActorType(): 'VENUE_OWNER_OR_PARTNER' {
  return 'VENUE_OWNER_OR_PARTNER';
}
