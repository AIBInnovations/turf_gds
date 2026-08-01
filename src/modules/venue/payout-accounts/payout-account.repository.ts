import type { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { VenuePayoutAccountDocument } from './payout-account.types.js';

export interface PayoutAccountRepository {
  insert(account: VenuePayoutAccountDocument): Promise<void>;
  list(venueId: ObjectId): Promise<VenuePayoutAccountDocument[]>;
  find(venueId: ObjectId, accountId: ObjectId): Promise<VenuePayoutAccountDocument | null>;
  updateDetails(input: { venueId:ObjectId; accountId:ObjectId; expectedVersion:number; accountHolderName:string; bankName:string; ifscCode:string; now:Date; actorOwnerId:ObjectId }): Promise<VenuePayoutAccountDocument|null>;
  disable(input: { venueId:ObjectId; accountId:ObjectId; expectedVersion:number; now:Date; actorOwnerId:ObjectId }): Promise<VenuePayoutAccountDocument|null>;
  addDocument(input: { venueId:ObjectId; accountId:ObjectId; expectedVersion:number; document:VenuePayoutAccountDocument['documents'][number]; now:Date; actorOwnerId:ObjectId }): Promise<VenuePayoutAccountDocument|null>;
  setDefault(input: { venueId:ObjectId; accountId:ObjectId; now:Date; actorOwnerId:ObjectId }): Promise<VenuePayoutAccountDocument|null>;
  verify(input: {
    accountId: ObjectId;
    venueId: ObjectId;
    adminId: ObjectId;
    outcome: 'VERIFIED' | 'FAILED';
    verificationMethod: 'PENNY_DROP' | 'MANUAL';
    failureReason: string | null;
    correlationId: string;
    now: Date;
  }): Promise<VenuePayoutAccountDocument | null>;
}

export function createPayoutAccountRepository(
  database: DatabaseConnection,
): PayoutAccountRepository {
  const accounts = () =>
    database.db.collection<VenuePayoutAccountDocument>('venue_payout_accounts');
  return {
    async insert(account) {
      await accounts().insertOne(account);
    },
    list(venueId) {
      return accounts()
        .find({ venue_id: venueId })
        .sort({ created_at: -1 })
        .toArray();
    },
    find(venueId, accountId) { return accounts().findOne({ _id: accountId, venue_id: venueId }); },
    updateDetails(input) { return accounts().findOneAndUpdate({ _id:input.accountId,venue_id:input.venueId,version:input.expectedVersion,status:{$ne:'DISABLED'} },{ $set:{account_holder_name:input.accountHolderName,bank_name:input.bankName,ifsc_code:input.ifscCode,status:'PENDING',verified_by:null,verified_at:null,verification_failure_reason:null,updated_at:input.now},$inc:{version:1},$push:{audit_history:{$each:[{event_type:'PAYOUT_ACCOUNT_DETAILS_UPDATED',actor_type:'VENUE_OWNER',actor_id:input.actorOwnerId,occurred_at:input.now}],$slice:-100}} },{returnDocument:'after'}); },
    disable(input) { return accounts().findOneAndUpdate({ _id:input.accountId,venue_id:input.venueId,version:input.expectedVersion,status:{$ne:'DISABLED'} },{ $set:{status:'DISABLED',is_default:false,updated_at:input.now},$inc:{version:1},$push:{audit_history:{$each:[{event_type:'PAYOUT_ACCOUNT_DISABLED',actor_type:'VENUE_OWNER',actor_id:input.actorOwnerId,occurred_at:input.now}],$slice:-100}} },{returnDocument:'after'}); },
    addDocument(input) { return accounts().findOneAndUpdate({ _id:input.accountId,venue_id:input.venueId,version:input.expectedVersion,status:{$ne:'DISABLED'},'documents.document_id':{$ne:input.document.document_id} },{ $push:{documents:input.document,audit_history:{$each:[{event_type:'PAYOUT_ACCOUNT_DOCUMENT_ADDED',actor_type:'VENUE_OWNER',actor_id:input.actorOwnerId,document_id:input.document.document_id,occurred_at:input.now}],$slice:-100}},$inc:{version:1},$set:{updated_at:input.now} },{returnDocument:'after'}); },
    async setDefault(input) { let result:VenuePayoutAccountDocument|null=null; await database.withTransaction(async({session})=>{ const eligible=await accounts().findOne({_id:input.accountId,venue_id:input.venueId,status:'VERIFIED'},{session}); if(!eligible)return; await accounts().updateMany({venue_id:input.venueId,is_default:true},{$set:{is_default:false,updated_at:input.now}},{session}); result=await accounts().findOneAndUpdate({_id:input.accountId,venue_id:input.venueId,status:'VERIFIED'},{$set:{is_default:true,updated_at:input.now},$inc:{version:1},$push:{audit_history:{$each:[{event_type:'PAYOUT_ACCOUNT_SET_DEFAULT',actor_type:'VENUE_OWNER',actor_id:input.actorOwnerId,occurred_at:input.now}],$slice:-100}}},{returnDocument:'after',session}); }); return result; },
    verify(input) {
      const verified = input.outcome === 'VERIFIED';
      return accounts().findOneAndUpdate(
        {
          _id: input.accountId,
          venue_id: input.venueId,
          status: 'PENDING',
        },
        {
          $set: {
            status: verified ? 'VERIFIED' : 'DISABLED',
            verification_method: input.verificationMethod,
            verified_by: verified ? input.adminId : null,
            verified_at: verified ? input.now : null,
            verification_failure_reason: input.failureReason,
            updated_at: input.now,
          },
          $push: {
            audit_history: {
              $each: [{
                event_type: verified
                  ? 'PAYOUT_ACCOUNT_VERIFIED'
                  : 'PAYOUT_ACCOUNT_VERIFICATION_FAILED',
                actor_type: 'ADMIN',
                actor_id: input.adminId,
                correlation_id: input.correlationId,
                changes: {
                  previous_status: 'PENDING',
                  new_status: verified ? 'VERIFIED' : 'DISABLED',
                  verification_method: input.verificationMethod,
                  failure_reason: input.failureReason,
                },
                occurred_at: input.now,
              }],
              $slice: -100,
            },
          },
        },
        { returnDocument: 'after' },
      );
    },
  };
}
