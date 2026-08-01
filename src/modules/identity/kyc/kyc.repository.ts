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
  listActiveDocuments?(verificationId:ObjectId):Promise<KycDocumentDocument[]>;
  updateDocumentDetails?(documentId:ObjectId,verificationId:ObjectId,details:Record<string,string>):Promise<boolean>;
  countActiveDocuments(verificationId: ObjectId): Promise<number>;
  submit(
    id: ObjectId,
    subjectId: ObjectId,
    actorType: KycSubjectType,
    correlationId: string,
    now: Date,
  ): Promise<boolean>;
  review(input: {
    id: ObjectId;
    adminId: ObjectId;
    status: Extract<KycStatus, 'VERIFIED' | 'REJECTED'>;
    rejectionReason: string | null;
    expiresAt: Date | null;
    correlationId: string;
    now: Date;
  }): Promise<boolean>;
  preliminaryReview?(input:{id:ObjectId;reviewerId:ObjectId;status:'APPROVED'|'REJECTED';checklist:Record<string,boolean>;notes:string|null;correlationId:string;now:Date}):Promise<boolean>;
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
        preliminary_reviewed_by: null,
        preliminary_reviewed_at: null,
        preliminary_status: null,
        preliminary_checklist: null,
        preliminary_notes: null,
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
    listActiveDocuments(verificationId){return documents().find({kyc_verification_id:verificationId,status:'PENDING','file.status':'ACTIVE'}).sort({created_at:-1}).toArray();},
    async updateDocumentDetails(documentId,verificationId,details){const result=await documents().updateOne({_id:documentId,kyc_verification_id:verificationId,status:'PENDING','file.status':'ACTIVE'},{$set:{details}});return result.matchedCount>0;},
    countActiveDocuments(verificationId) {
      return documents().countDocuments({
        kyc_verification_id: verificationId,
        status: 'PENDING',
      });
    },
    async submit(id, subjectId, actorType, correlationId, _now) {
      const result = await verifications().updateOne(
        {
          _id: id,
          subject_id: subjectId,
          status: 'PENDING',
          is_current: true,
          'audit_history.event_type': { $ne: 'KYC_SUBMITTED' },
        },
        {
          $set: {
            status: 'PENDING',
          },
          $push: {
            audit_history: {
              event_type: 'KYC_SUBMITTED',
              actor_type: actorType,
              actor_id: subjectId,
              correlation_id: correlationId,
              changes: {},
              occurred_at: _now,
            },
          },
        },
      );
      return result.modifiedCount > 0;
    },
    async review(input) {
      return database.withTransaction(async ({ session }) => {
        const verification = await verifications().findOne(
          {
            _id: input.id,
            status: 'PENDING',
            is_current: true,
            preliminary_status: 'APPROVED',
            preliminary_reviewed_by: { $ne: input.adminId },
            audit_history: { $elemMatch: { event_type: 'KYC_SUBMITTED' } },
          },
          { session },
        );
        if (!verification) return false;

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
            $push: {
              audit_history: {
                $each: [{
                  event_type: `KYC_${input.status}`,
                  actor_type: 'ADMIN',
                  actor_id: input.adminId,
                  correlation_id: input.correlationId,
                  changes: {
                    status: input.status,
                    expires_at: input.expiresAt,
                    rejection_reason: input.rejectionReason,
                  },
                  occurred_at: input.now,
                }],
                $slice: -100,
              },
            },
          },
          { session },
        );
        if (result.modifiedCount !== 1) return false;

        await documents().updateMany(
          {
            kyc_verification_id: input.id,
            status: 'PENDING',
          },
          {
            $set: {
              status:
                input.status === 'VERIFIED' ? 'ACCEPTED' : 'REJECTED',
              rejection_reason:
                input.status === 'REJECTED'
                  ? input.rejectionReason
                  : null,
            },
          },
          { session },
        );

        const collection =
          verification.subject_type === 'VENUE_OWNER'
            ? 'venue_owners'
            : 'partners';
        await database.db.collection(collection).updateOne(
          { _id: verification.subject_id },
          {
            $set: {
              kyc_status: input.status,
              updated_at: input.now,
            },
          },
          { session },
        );
        return true;
      });
    },
    async preliminaryReview(input){const result=await verifications().updateOne({_id:input.id,status:'PENDING',is_current:true,audit_history:{$elemMatch:{event_type:'KYC_SUBMITTED'}},preliminary_status:null},{$set:{preliminary_reviewed_by:input.reviewerId,preliminary_reviewed_at:input.now,preliminary_status:input.status,preliminary_checklist:input.checklist,preliminary_notes:input.notes},$push:{audit_history:{$each:[{event_type:'KYC_PRELIMINARY_REVIEWED',actor_type:'ADMIN',actor_id:input.reviewerId,correlation_id:input.correlationId,changes:{status:input.status,checklist:input.checklist,notes:input.notes},occurred_at:input.now}],$slice:-100}}});return result.modifiedCount>0;},
  };
}
