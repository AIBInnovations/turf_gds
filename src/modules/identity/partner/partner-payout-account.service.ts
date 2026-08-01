import { ObjectId, type Db } from 'mongodb';
import type { MediaStorage } from '../../../shared/media/cloudinary-media-storage.js';
import { AppError } from '../../../shared/errors/app-error.js';

interface PartnerPayoutAccount {
  _id:ObjectId; partner_id:ObjectId; label:string; account_holder_name:string; bank_name:string;
  ifsc_code:string; account_last4:string; account_vault_token:string; status:'PENDING'|'VERIFIED'|'FAILED'|'DISABLED';
  is_default:boolean; failure_reason:string|null; documents:Array<{document_id:ObjectId;document_type:string;storage_key:string;secure_url:string;mime_type:string;original_filename:string;bytes:number;uploaded_at:Date}>;
  version:number; created_at:Date; updated_at:Date;
}

export interface PartnerPayoutAccountService {
  create(input:{partnerId:string;label:string;accountHolderName:string;bankName:string;ifscCode:string;accountLast4:string;accountVaultToken:string}):Promise<unknown>;
  list(partnerId:string):Promise<unknown[]>;
  upload(input:{partnerId:string;accountId:string;version:number;documentType:string;filename:string;mimeType:string;buffer:Buffer}):Promise<unknown>;
  verify(input:{partnerId:string;accountId:string;adminId:string;outcome:'VERIFIED'|'FAILED';failureReason?:string}):Promise<unknown>;
  setDefault(input:{partnerId:string;accountId:string}):Promise<unknown>;
  disable(input:{partnerId:string;accountId:string;version:number}):Promise<void>;
}

export function createPartnerPayoutAccountService(db:Db,media:MediaStorage,now:()=>Date=()=>new Date()):PartnerPayoutAccountService {
  const col=()=>db.collection<PartnerPayoutAccount>('partner_payout_accounts');
  return {
    async create(v){
      if(!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifscCode.toUpperCase())||!/^\d{4}$/.test(v.accountLast4)||!/^vault_[A-Za-z0-9_-]{12,}$/.test(v.accountVaultToken)) invalid('INVALID_PARTNER_PAYOUT_ACCOUNT','Valid IFSC, last four digits, and a tokenized vault reference are required');
      const timestamp=now(); const doc:PartnerPayoutAccount={_id:new ObjectId(),partner_id:oid(v.partnerId),label:req(v.label),account_holder_name:req(v.accountHolderName),bank_name:req(v.bankName),ifsc_code:v.ifscCode.toUpperCase(),account_last4:v.accountLast4,account_vault_token:v.accountVaultToken,status:'PENDING',is_default:false,failure_reason:null,documents:[],version:1,created_at:timestamp,updated_at:timestamp};
      await col().insertOne(doc); return view(doc);
    },
    async list(partnerId){return (await col().find({partner_id:oid(partnerId),status:{$ne:'DISABLED'}}).sort({created_at:-1}).toArray()).map(view);},
    async upload(v){
      if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(v.mimeType)||v.buffer.length===0||v.buffer.length>10*1024*1024) invalid('UNSUPPORTED_PARTNER_PAYOUT_DOCUMENT','Document must be PDF, JPEG, PNG, or WebP up to 10 MB');
      const uploaded=await media.uploadBuffer(v.buffer,{folder:`turf-gds/partner-payout-accounts/${v.partnerId}`,access:'authenticated',resourceType:'auto',tags:['partner-payout-account',v.documentType]});
      const timestamp=now();
      try{const result=await col().findOneAndUpdate({_id:oid(v.accountId),partner_id:oid(v.partnerId),version:v.version,status:{$in:['PENDING','FAILED']}},{$push:{documents:{document_id:new ObjectId(),document_type:req(v.documentType).toUpperCase(),storage_key:uploaded.publicId,secure_url:uploaded.secureUrl,mime_type:v.mimeType,original_filename:v.filename,bytes:uploaded.bytes,uploaded_at:timestamp}},$set:{status:'PENDING',failure_reason:null,updated_at:timestamp},$inc:{version:1}},{returnDocument:'after'});if(!result)conflict();return view(result);}catch(error){await media.delete(uploaded.publicId,uploaded.resourceType as 'image'|'video'|'raw').catch(()=>undefined);throw error;}
    },
    async verify(v){const reason=v.outcome==='FAILED'?req(v.failureReason??''):null;const timestamp=now();const result=await col().findOneAndUpdate({_id:oid(v.accountId),partner_id:oid(v.partnerId),status:'PENDING','documents.0':{$exists:true}},{$set:{status:v.outcome,failure_reason:reason,updated_at:timestamp},$inc:{version:1}},{returnDocument:'after'});if(!result)conflict();return view(result);},
    async setDefault(v){const partnerId=oid(v.partnerId),accountId=oid(v.accountId),timestamp=now();const account=await col().findOne({_id:accountId,partner_id:partnerId,status:'VERIFIED'});if(!account)conflict();await col().updateMany({partner_id:partnerId,is_default:true},{$set:{is_default:false,updated_at:timestamp},$inc:{version:1}});const result=await col().findOneAndUpdate({_id:accountId,partner_id:partnerId,status:'VERIFIED'},{$set:{is_default:true,updated_at:timestamp},$inc:{version:1}},{returnDocument:'after'});if(!result)conflict();return view(result);},
    async disable(v){const result=await col().updateOne({_id:oid(v.accountId),partner_id:oid(v.partnerId),version:v.version},{$set:{status:'DISABLED',is_default:false,updated_at:now()},$inc:{version:1}});if(!result.modifiedCount)conflict();},
  };
}
function view(v:PartnerPayoutAccount){return{accountId:v._id.toHexString(),partnerId:v.partner_id.toHexString(),label:v.label,accountHolderName:v.account_holder_name,bankName:v.bank_name,ifscCode:v.ifsc_code,accountLast4:v.account_last4,status:v.status,isDefault:v.is_default,failureReason:v.failure_reason,documents:v.documents.map(d=>({documentId:d.document_id.toHexString(),documentType:d.document_type,mimeType:d.mime_type,originalFilename:d.original_filename,bytes:d.bytes,uploadedAt:d.uploaded_at.toISOString()})),version:v.version,createdAt:v.created_at.toISOString(),updatedAt:v.updated_at.toISOString()};}
function oid(v:string){if(!ObjectId.isValid(v))invalid('INVALID_ID','Identifier is invalid');return new ObjectId(v);} function req(v:string){const x=v.trim();if(!x)invalid('INVALID_VALUE','A required value is missing');return x;} function invalid(code:string,message:string):never{throw new AppError({code,message,statusCode:400});} function conflict():never{throw new AppError({code:'PARTNER_PAYOUT_ACCOUNT_CONFLICT',message:'The payout account changed or is not reviewable',statusCode:409});}
