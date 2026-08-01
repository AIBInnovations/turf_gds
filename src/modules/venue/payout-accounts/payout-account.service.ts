import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { PayoutAccountRepository } from './payout-account.repository.js';
import type { VenuePayoutAccountDocument } from './payout-account.types.js';
import type { MediaStorage } from '../../../shared/media/cloudinary-media-storage.js';

export interface PayoutAccountService {
  add(input: {
    actorOwnerId: string;
    venueId: string;
    accountHolderName: string;
    vaultProvider: string;
    vaultAccountToken: string;
    accountLast4: string;
    bankName: string;
    ifscCode: string;
  }): Promise<object>;
  list(input: {
    actorOwnerId: string;
    venueId: string;
  }): Promise<object[]>;
  get(input:{actorOwnerId:string;venueId:string;accountId:string}):Promise<object>;
  update(input:{actorOwnerId:string;venueId:string;accountId:string;version:number;accountHolderName:string;bankName:string;ifscCode:string}):Promise<object>;
  disable(input:{actorOwnerId:string;venueId:string;accountId:string;version:number}):Promise<object>;
  setDefault(input:{actorOwnerId:string;venueId:string;accountId:string}):Promise<object>;
  uploadDocument(input:{actorOwnerId:string;venueId:string;accountId:string;version:number;documentType:string;filename:string;mimeType:string;buffer:Buffer}):Promise<object>;
  verify(input: {
    adminId: string;
    venueId: string;
    accountId: string;
    outcome: 'VERIFIED' | 'FAILED';
    verificationMethod: 'PENNY_DROP' | 'MANUAL';
    failureReason?: string;
    correlationId: string;
  }): Promise<object>;
}

export function createPayoutAccountService(input: {
  repository: PayoutAccountRepository;
  ownerAccessService: OwnerAccessService;
  mediaStorage: MediaStorage;
  now?: () => Date;
}): PayoutAccountService {
  const now = input.now ?? (() => new Date());
  return {
    async add(values) {
      await input.ownerAccessService.requirePermission(
        values.actorOwnerId,
        values.venueId,
        'MANAGE_VENUE',
      );
      if (
        !/^[0-9]{4}$/.test(values.accountLast4) ||
        values.vaultAccountToken.trim().length < 12 ||
        /^[0-9]{6,34}$/.test(values.vaultAccountToken.trim()) ||
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(values.ifscCode.toUpperCase())
      ) {
        throw invalid(
          'INVALID_PAYOUT_ACCOUNT',
          'Tokenized payout-account metadata is invalid',
        );
      }
      const timestamp = now();
      const account: VenuePayoutAccountDocument = {
        _id: new ObjectId(),
        venue_id: oid(values.venueId),
        account_holder_name: required(
          values.accountHolderName,
          'accountHolderName',
        ),
        vault_provider: required(values.vaultProvider, 'vaultProvider'),
        vault_account_token: values.vaultAccountToken.trim(),
        account_last4: values.accountLast4,
        bank_name: required(values.bankName, 'bankName'),
        ifsc_code: values.ifscCode.toUpperCase(),
        status: 'PENDING',
        verified_by: null,
        verified_at: null,
        verification_failure_reason: null,
        verification_method: 'PENNY_DROP',
        is_default: false,
        documents: [],
        version: 1,
        audit_history: [],
        created_at: timestamp,
        updated_at: timestamp,
      };
      try {
        await input.repository.insert(account);
      } catch (error) {
        if (duplicate(error)) {
          throw conflict(
            'PAYOUT_ACCOUNT_ALREADY_EXISTS',
            'This tokenized payout account already exists',
          );
        }
        throw error;
      }
      return present(account);
    },
    async list(values) {
      await input.ownerAccessService.requirePermission(
        values.actorOwnerId,
        values.venueId,
        'VIEW_FINANCE',
      );
      return (await input.repository.list(oid(values.venueId))).map((value) => present(value));
    },
    async get(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'VIEW_FINANCE'); const value=await input.repository.find(oid(values.venueId),oid(values.accountId)); if(!value)throw notFound(); return present(value,true); },
    async update(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_VENUE'); const ifsc=values.ifscCode.toUpperCase(); if(!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))throw invalid('INVALID_PAYOUT_ACCOUNT','IFSC code is invalid'); const value=await input.repository.updateDetails({venueId:oid(values.venueId),accountId:oid(values.accountId),expectedVersion:values.version,accountHolderName:required(values.accountHolderName,'accountHolderName'),bankName:required(values.bankName,'bankName'),ifscCode:ifsc,now:now(),actorOwnerId:oid(values.actorOwnerId)}); if(!value)throw versionConflict(); return present(value,true); },
    async disable(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_VENUE'); const value=await input.repository.disable({venueId:oid(values.venueId),accountId:oid(values.accountId),expectedVersion:values.version,now:now(),actorOwnerId:oid(values.actorOwnerId)}); if(!value)throw versionConflict(); return present(value,true); },
    async setDefault(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_VENUE'); const value=await input.repository.setDefault({venueId:oid(values.venueId),accountId:oid(values.accountId),now:now(),actorOwnerId:oid(values.actorOwnerId)}); if(!value)throw new AppError({code:'PAYOUT_ACCOUNT_NOT_VERIFIED',message:'Only a verified payout account can be the default',statusCode:409}); return present(value,true); },
    async uploadDocument(values) { await input.ownerAccessService.requirePermission(values.actorOwnerId,values.venueId,'MANAGE_VENUE'); if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(values.mimeType)||values.buffer.length===0||values.buffer.length>10*1024*1024)throw invalid('UNSUPPORTED_PAYOUT_DOCUMENT','Payout document must be PDF, JPEG, PNG, or WebP up to 10 MB'); const uploaded=await input.mediaStorage.uploadBuffer(values.buffer,{folder:`turf-gds/payout-accounts/${values.venueId}`,access:'authenticated',resourceType:'auto',tags:['payout-account',values.documentType]}); const timestamp=now(); try { const value=await input.repository.addDocument({venueId:oid(values.venueId),accountId:oid(values.accountId),expectedVersion:values.version,actorOwnerId:oid(values.actorOwnerId),now:timestamp,document:{document_id:new ObjectId(),document_type:required(values.documentType,'documentType').toUpperCase(),provider:'CLOUDINARY',storage_key:uploaded.publicId,secure_url:uploaded.secureUrl,mime_type:values.mimeType,original_filename:values.filename,bytes:uploaded.bytes,checksum:uploaded.checksum??null,uploaded_at:timestamp}}); if(!value)throw versionConflict(); return present(value,true); } catch(error){await input.mediaStorage.delete(uploaded.publicId,uploaded.resourceType as 'image'|'video'|'raw').catch(()=>undefined);throw error;} },
    async verify(values) {
      const failureReason =
        values.outcome === 'FAILED'
          ? required(values.failureReason ?? '', 'failureReason')
          : null;
      if (values.outcome === 'VERIFIED' && values.failureReason?.trim()) {
        throw invalid(
          'INVALID_PAYOUT_VERIFICATION',
          'failureReason is only valid for a failed verification',
        );
      }
      const account = await input.repository.verify({
        accountId: oid(values.accountId),
        venueId: oid(values.venueId),
        adminId: oid(values.adminId),
        outcome: values.outcome,
        verificationMethod: values.verificationMethod,
        failureReason,
        correlationId: values.correlationId,
        now: now(),
      });
      if (!account) {
        throw conflict(
          'PAYOUT_ACCOUNT_NOT_PENDING',
          'Payout account was not found for the Venue or is no longer pending',
        );
      }
      return present(account);
    },
  };
}

function present(value: VenuePayoutAccountDocument, detail = false) {
  return {
    id: value._id.toHexString(),
    venueId: value.venue_id.toHexString(),
    accountHolderName: value.account_holder_name,
    vaultProvider: value.vault_provider,
    accountLast4: value.account_last4,
    bankName: value.bank_name,
    ifscCode: value.ifsc_code,
    status: value.status,
    verifiedAt: value.verified_at?.toISOString() ?? null,
    verificationMethod: value.verification_method,
    isDefault: value.is_default,
    version: value.version,
    ...(detail ? { verificationFailureReason:value.verification_failure_reason, documents:value.documents.map(document=>({documentId:document.document_id.toHexString(),documentType:document.document_type,mimeType:document.mime_type,originalFilename:document.original_filename,bytes:document.bytes,uploadedAt:document.uploaded_at.toISOString()})), createdAt:value.created_at.toISOString(), updatedAt:value.updated_at.toISOString() } : {}),
  };
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw invalid('INVALID_ID', 'Identifier is invalid');
  }
  return new ObjectId(value);
}

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw invalid('FIELD_REQUIRED', `${field} is required`);
  return result;
}

function invalid(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 409 });
}
function notFound(){return new AppError({code:'PAYOUT_ACCOUNT_NOT_FOUND',message:'Payout account was not found',statusCode:404});}
function versionConflict(){return conflict('PAYOUT_ACCOUNT_VERSION_CONFLICT','Payout account changed concurrently or is disabled');}

function duplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}
