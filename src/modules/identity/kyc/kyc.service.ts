import { ObjectId, type ClientSession } from 'mongodb';

import type { AppConfig } from '../../../config/env.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { MediaStorage } from '../../../shared/media/cloudinary-media-storage.js';
import type { KycRepository } from './kyc.repository.js';
import type {
  KycDocumentType,
  KycStatus,
  KycSubjectType,
  KycVerificationType,
  KycVerificationDocument,
  KycDocumentDocument,
} from './kyc.types.js';
import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { OutboxRepository } from '../../../shared/communications/outbox.repository.js';
import { inspectUploadedFile } from '../../../shared/media/file-security.js';

export interface KycService {
  createDraft(input: {
    subjectType: KycSubjectType;
    subjectId: string;
    verificationType: string;
  }): Promise<ReturnType<typeof presentVerification>>;
  uploadDocument(input: {
    verificationId: string;
    subjectId: string;
    documentType: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
    details?: Record<string,string>;
  }): Promise<{ documentId: string; status: 'PENDING' }>;
  updateDocumentDetails(input:{verificationId:string;documentId:string;subjectId:string;documentType:string;details:Record<string,string>}):Promise<void>;
  listDocuments(input:{verificationId:string;subjectId:string}):Promise<unknown[]>;
  submit(input: {
    verificationId: string;
    subjectId: string;
    correlationId: string;
  }): Promise<void>;
  getCurrent(input: {
    subjectType: KycSubjectType;
    subjectId: string;
    verificationType: string;
  }): Promise<ReturnType<typeof presentVerification>>;
  isVerified(
    subjectType: KycSubjectType,
    subjectId: string,
    verificationType: string,
    session?: ClientSession,
  ): Promise<boolean>;
  review(input: {
    verificationId: string;
    adminId: string;
    status: Extract<KycStatus, 'VERIFIED' | 'REJECTED'>;
    rejectionReason?: string;
    expiresAt?: string;
    correlationId: string;
  }): Promise<void>;
  preliminaryReview?(input:{verificationId:string;reviewerId:string;status:'APPROVED'|'REJECTED';checklist:Record<string,boolean>;notes?:string;correlationId:string}):Promise<void>;
}

export function createKycService(input: {
  repository: KycRepository;
  mediaStorage: MediaStorage;
  config: AppConfig['kyc'];
  database?: DatabaseConnection;
  outboxRepository?: OutboxRepository;
  now?: () => Date;
}): KycService {
  const now = input.now ?? (() => new Date());

  async function createDraft(
    values: Parameters<KycService['createDraft']>[0],
  ): ReturnType<KycService['createDraft']> {
    const subjectId = toObjectId(values.subjectId);
    const verificationType = normalizeType(values.verificationType);
    const current = await input.repository.findCurrent(
      values.subjectType,
      subjectId,
      verificationType,
    );

    if (
      current?.status === 'PENDING' &&
      current.audit_history.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'event_type' in event &&
          event.event_type === 'KYC_SUBMITTED',
      )
    ) {
      throw new AppError({
        code: 'KYC_ALREADY_IN_PROGRESS',
        message: 'The current KYC verification is already being reviewed',
        statusCode: 409,
      });
    }
    if (current?.status === 'PENDING') {
      return presentVerification(current);
    }

    if (
      current?.status === 'VERIFIED' &&
      (!current.expires_at || current.expires_at > now())
    ) {
      throw new AppError({
        code: 'KYC_ALREADY_VERIFIED',
        message: 'The current KYC verification is already valid',
        statusCode: 409,
      });
    }

    const verification = await input.repository.createDraft({
      subjectType: values.subjectType,
      subjectId,
      verificationType,
      now: now(),
    });
    return presentVerification(verification);
  }

  async function uploadDocument(
    values: Parameters<KycService['uploadDocument']>[0],
  ): ReturnType<KycService['uploadDocument']> {
    const documentType=normalizeType(values.documentType,true);
    const mimeType=values.mimeType.toLowerCase();
    if (
      !input.config.allowedMimeTypes.includes(
        values.mimeType.toLowerCase(),
      ) ||
      values.buffer.length > input.config.maxFileBytes
    ) {
      throw new AppError({
        code: 'UNSUPPORTED_KYC_FILE',
        message: 'The KYC file type or size is not supported',
        statusCode: 400,
      });
    }
    if(REGISTRATION_DOCUMENTS.includes(documentType)&&!['image/jpeg','image/png'].includes(mimeType))throw new AppError({code:'KYC_REGISTRATION_IMAGE_REQUIRED',message:'GST certificate, PAN, passbook, and Aadhaar must be uploaded as JPEG or PNG images',statusCode:400});
    if(input.database)inspectUploadedFile(values.buffer,mimeType,input.config.allowedMimeTypes);

    const verification = await input.repository.findVerification(
      toObjectId(values.verificationId),
    );

    if (
      !verification ||
      !verification.subject_id.equals(toObjectId(values.subjectId)) ||
      verification.status !== 'PENDING' ||
      !verification.is_current
    ) {
      throw verificationNotEditable();
    }

    const uploaded = await input.mediaStorage.uploadBuffer(values.buffer, {
      access: 'authenticated',
      folder: `turf-gds/kyc/${verification.subject_type.toLowerCase()}/${verification.subject_id.toHexString()}`,
      resourceType: 'auto',
      tags: ['kyc', verification.verification_type],
    });
    const documentId = new ObjectId();
    const timestamp = now();

    try {
      await input.repository.insertDocument({
        _id: documentId,
        kyc_verification_id: verification._id,
        document_type: documentType,
        details: validateDocumentDetails(documentType,values.details??{},false),
        file: {
          storage_key: uploaded.publicId,
          mime_type: values.mimeType.toLowerCase(),
          size_bytes: uploaded.bytes,
          checksum: uploaded.checksum ?? uploaded.publicId,
          classification: 'SENSITIVE',
          status: 'ACTIVE',
          created_at: timestamp,
        },
        status: 'PENDING',
        rejection_reason: null,
        created_at: timestamp,
      });
    } catch (error) {
      await input.mediaStorage
        .delete(uploaded.publicId, toDeletableResource(uploaded.resourceType))
        .catch(() => undefined);
      throw error;
    }

    return { documentId: documentId.toHexString(), status: 'PENDING' };
  }

  async function updateDocumentDetails(values:Parameters<KycService['updateDocumentDetails']>[0]):Promise<void>{
    const verification=await input.repository.findVerification(toObjectId(values.verificationId));
    if(!verification||!verification.subject_id.equals(toObjectId(values.subjectId))||verification.status!=='PENDING'||!verification.is_current)throw verificationNotEditable();
    const details=validateDocumentDetails(normalizeType(values.documentType,true),values.details,true);
    if(!(await input.repository.updateDocumentDetails?.(toObjectId(values.documentId),verification._id,details)))throw new AppError({code:'KYC_DOCUMENT_NOT_FOUND',message:'The editable KYC document was not found',statusCode:404});
  }

  async function listDocuments(values:Parameters<KycService['listDocuments']>[0]){const verification=await input.repository.findVerification(toObjectId(values.verificationId));if(!verification||!verification.subject_id.equals(toObjectId(values.subjectId)))throw new AppError({code:'KYC_NOT_FOUND',message:'KYC verification was not found',statusCode:404});const documents=await input.repository.listActiveDocuments?.(verification._id)??[];const expiresAt=new Date(now().getTime()+10*60_000);return documents.map(document=>({documentId:document._id.toHexString(),documentType:document.document_type,details:document.details??{},mimeType:document.file.mime_type,sizeBytes:document.file.size_bytes,status:document.status,downloadUrl:input.mediaStorage.signedUrl?.(document.file.storage_key,expiresAt)??null,downloadUrlExpiresAt:input.mediaStorage.signedUrl?expiresAt.toISOString():null,createdAt:document.created_at.toISOString()}));}

  async function submit(
    values: Parameters<KycService['submit']>[0],
  ): Promise<void> {
    const verificationId = toObjectId(values.verificationId);
    const verification = await input.repository.findVerification(
      verificationId,
    );
    if (
      !verification ||
      !verification.subject_id.equals(toObjectId(values.subjectId)) ||
      verification.status !== 'PENDING' ||
      !verification.is_current
    ) {
      throw verificationNotEditable();
    }
    const documentCount =
      await input.repository.countActiveDocuments(verificationId);

    if(verification.verification_type==='BUSINESS'&&input.repository.listActiveDocuments){
      const documents=await input.repository.listActiveDocuments(verificationId);
      assertRegistrationChecklist(documents);
    }

    if (documentCount === 0) {
      throw new AppError({
        code: 'KYC_DOCUMENT_REQUIRED',
        message: 'At least one active document is required',
        statusCode: 409,
      });
    }

    const submitted = await input.repository.submit(
      verificationId,
      toObjectId(values.subjectId),
      verification.subject_type,
      required(values.correlationId, 'correlationId'),
      now(),
    );

    if (!submitted) {
      throw verificationNotEditable();
    }
    await notifyKyc(verification, 'KYC_SUBMITTED', values.correlationId);
  }

  async function getCurrent(
    values: Parameters<KycService['getCurrent']>[0],
  ): ReturnType<KycService['getCurrent']> {
    const verification = await input.repository.findCurrent(
      values.subjectType,
      toObjectId(values.subjectId),
      normalizeType(values.verificationType),
    );

    if (!verification) {
      throw new AppError({
        code: 'KYC_NOT_FOUND',
        message: 'Current KYC verification was not found',
        statusCode: 404,
      });
    }

    return presentVerification(verification);
  }

  async function isVerified(
    subjectType: KycSubjectType,
    subjectId: string,
    verificationType: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const verification = await input.repository.findCurrent(
      subjectType,
      toObjectId(subjectId),
      normalizeType(verificationType),
      session,
    );
    return (
      verification?.status === 'VERIFIED' &&
      (!verification.expires_at || verification.expires_at > now())
    );
  }

  async function review(
    values: Parameters<KycService['review']>[0],
  ): Promise<void> {
    if (values.status === 'REJECTED' && !values.rejectionReason?.trim()) {
      throw new AppError({
        code: 'REJECTION_REASON_REQUIRED',
        message: 'A rejection reason is required',
        statusCode: 400,
      });
    }

    const expiresAt = values.expiresAt
      ? new Date(values.expiresAt)
      : null;

    if (
      expiresAt &&
      (Number.isNaN(expiresAt.getTime()) || expiresAt <= now())
    ) {
      throw new AppError({
        code: 'INVALID_KYC_EXPIRY',
        message: 'KYC expiry must be a valid future date',
        statusCode: 400,
      });
    }
    const verification = await input.repository.findVerification(
      toObjectId(values.verificationId),
    );
    const wasSubmitted = verification?.audit_history.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'event_type' in event &&
        event.event_type === 'KYC_SUBMITTED',
    );
    if (
      !verification ||
      verification.status !== 'PENDING' ||
      !verification.is_current ||
      !wasSubmitted ||
      (await input.repository.countActiveDocuments(verification._id)) === 0
    ) {
      throw new AppError({
        code: 'KYC_REVIEW_NOT_READY',
        message: 'Only a submitted current KYC with documents can be reviewed',
        statusCode: 409,
      });
    }
    if(input.repository.preliminaryReview&&verification.preliminary_status!=='APPROVED')throw new AppError({code:'KYC_PRELIMINARY_APPROVAL_REQUIRED',message:'A preliminary approval is required before final KYC approval',statusCode:409});
    if(verification.preliminary_reviewed_by?.equals(toObjectId(values.adminId)))throw new AppError({code:'KYC_MAKER_CHECKER_REQUIRED',message:'The final reviewer must be different from the preliminary reviewer',statusCode:409});

    const reviewed = await input.repository.review({
      id: verification._id,
      adminId: toObjectId(values.adminId),
      status: values.status,
      rejectionReason: values.rejectionReason?.trim() ?? null,
      expiresAt,
      correlationId: required(values.correlationId, 'correlationId'),
      now: now(),
    });

    if (!reviewed) {
      throw new AppError({
        code: 'KYC_REVIEW_NOT_ALLOWED',
        message: 'This verification cannot be reviewed',
        statusCode: 409,
      });
    }
    if(input.database){const target=verification.subject_type==='PARTNER'?'partners':'venue_owners';await input.database.db.collection(target).updateOne({_id:verification.subject_id},{$set:{kyc_status:values.status,updated_at:now()}});}
    await notifyKyc(verification, values.status === 'VERIFIED' ? 'KYC_VERIFIED' : 'KYC_REJECTED', values.correlationId, values.rejectionReason?.trim() ?? null);
  }

  async function preliminaryReview(values:Parameters<NonNullable<KycService['preliminaryReview']>>[0]){if(!input.repository.preliminaryReview)throw new AppError({code:'KYC_PRELIMINARY_REVIEW_UNAVAILABLE',message:'Preliminary KYC review is unavailable',statusCode:503});const requiredChecks=['documentReadable','detailsMatch','gstChecked','panChecked','bankChecked','aadhaarMasked'];if(requiredChecks.some(key=>typeof values.checklist[key]!=='boolean'))throw new AppError({code:'KYC_CHECKLIST_INCOMPLETE',message:'The complete KYC review checklist is required',statusCode:400});if(values.status==='APPROVED'&&requiredChecks.some(key=>values.checklist[key]!==true))throw new AppError({code:'KYC_CHECKLIST_FAILED',message:'Every checklist item must pass for preliminary approval',statusCode:409});if(!(await input.repository.preliminaryReview({id:toObjectId(values.verificationId),reviewerId:toObjectId(values.reviewerId),status:values.status,checklist:values.checklist,notes:values.notes?.trim()||null,correlationId:required(values.correlationId,'correlationId'),now:now()})))throw new AppError({code:'KYC_PRELIMINARY_REVIEW_NOT_ALLOWED',message:'This verification cannot receive a preliminary review',statusCode:409});}

  async function notifyKyc(verification: KycVerificationDocument, eventType: 'KYC_SUBMITTED'|'KYC_VERIFIED'|'KYC_REJECTED', correlationId: string, rejectionReason: string|null = null): Promise<void> {
    if (!input.database || !input.outboxRepository || verification.subject_type !== 'VENUE_OWNER') return;
    const timestamp=now();
    await input.database.withTransaction(async({session})=>{
      const memberships=await input.database!.db.collection<{venue_id:ObjectId}>('venue_owner_memberships').find({owner_id:verification.subject_id,status:'ACTIVE'},{session,projection:{venue_id:1}}).toArray();
      const venues=await input.database!.db.collection<{_id:ObjectId;environment:'SANDBOX'|'PRODUCTION'}>('venues').find({_id:{$in:memberships.map(v=>v.venue_id)}},{session}).toArray();
      for(const venue of venues) await input.outboxRepository!.enqueue({aggregateType:'KYC',aggregateId:verification._id,partnerId:null,venueId:venue._id,environment:venue.environment,eventType,eventVersion:1,correlationId,payload:{verificationId:verification._id.toHexString(),verificationType:verification.verification_type,status:eventType.replace('KYC_',''),rejectionReason},now:timestamp,session});
    });
  }

  return {
    createDraft,
    uploadDocument,
    updateDocumentDetails,
    listDocuments,
    submit,
    getCurrent,
    isVerified,
    review,
    preliminaryReview,
  };
}

function presentVerification(verification: KycVerificationDocument) {
  return {
    id: verification._id.toHexString(),
    subjectType: verification.subject_type,
    subjectId: verification.subject_id.toHexString(),
    verificationType: verification.verification_type,
    status: verification.status,
    isCurrent: verification.is_current,
    reviewedAt: verification.reviewed_at?.toISOString() ?? null,
    rejectionReason: verification.rejection_reason,
    expiresAt: verification.expires_at?.toISOString() ?? null,
  };
}

function normalizeType(value: string): KycVerificationType;
function normalizeType(value: string, document: true): KycDocumentType;
function normalizeType(
  value: string,
  document = false,
): KycVerificationType | KycDocumentType {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const allowed = document
    ? ['PAN', 'AADHAAR', 'GST_CERTIFICATE', 'PASSBOOK', 'BUSINESS_REGISTRATION', 'ADDRESS_PROOF', 'ID_PROOF']
    : ['IDENTITY', 'BUSINESS', 'ADDRESS'];
  if (!allowed.includes(normalized)) {
    throw new AppError({
      code: 'INVALID_KYC_TYPE',
      message: document
        ? 'Document type is not supported'
        : 'Verification type must be IDENTITY, BUSINESS, or ADDRESS',
      statusCode: 400,
    });
  }
  return normalized as KycVerificationType | KycDocumentType;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError({
      code: 'FIELD_REQUIRED',
      message: `${field} is required`,
      statusCode: 400,
    });
  }
  return normalized;
}

const REGISTRATION_DOCUMENTS:KycDocumentType[]=['GST_CERTIFICATE','PAN','PASSBOOK','AADHAAR'];
function assertRegistrationChecklist(documents:KycDocumentDocument[]):void{
  const missing:string[]=[];
  for(const type of REGISTRATION_DOCUMENTS){const document=documents.find(v=>v.document_type===type);if(!document){missing.push(type);continue;}validateDocumentDetails(type,document.details??{},true);}
  if(missing.length)throw new AppError({code:'KYC_REGISTRATION_DOCUMENTS_REQUIRED',message:'GST certificate, PAN card, passbook, and owner Aadhaar are required before submission',statusCode:409,details:{missingDocumentTypes:missing}});
}
function validateDocumentDetails(type:KycDocumentType,value:Record<string,string>,mustBeComplete:boolean):Record<string,string>{
  const details=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,String(item).trim()]));
  if(!mustBeComplete&&Object.keys(details).length===0)return{};
  const need=(key:string)=>{const result=details[key];if(!result)throw new AppError({code:'KYC_DOCUMENT_DETAILS_REQUIRED',message:`${type} requires ${key}`,statusCode:400});return result;};
  if(type==='GST_CERTIFICATE'){const gstNumber=need('gstNumber').toUpperCase();if(!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstNumber))invalidDetails('GST number is invalid');return{gstNumber,legalName:need('legalName'),tradeName:details.tradeName??''};}
  if(type==='PAN'){const panNumber=need('panNumber').toUpperCase();if(!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber))invalidDetails('PAN number is invalid');return{panNumber,nameOnPan:need('nameOnPan')};}
  if(type==='PASSBOOK'){const ifscCode=need('ifscCode').toUpperCase(),accountLast4=need('accountLast4');if(!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)||!/^\d{4}$/.test(accountLast4))invalidDetails('Passbook IFSC or account last four digits are invalid');return{accountHolderName:need('accountHolderName'),bankName:need('bankName'),ifscCode,accountLast4};}
  if(type==='AADHAAR'){const aadhaarLast4=need('aadhaarLast4');if(!/^\d{4}$/.test(aadhaarLast4))invalidDetails('Aadhaar last four digits are invalid');return{holderName:need('holderName'),aadhaarLast4};}
  return details;
}
function invalidDetails(message:string):never{throw new AppError({code:'INVALID_KYC_DOCUMENT_DETAILS',message,statusCode:400});}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'INVALID_ID',
      message: 'A supplied identifier is invalid',
      statusCode: 400,
    });
  }
  return new ObjectId(value);
}

function verificationNotEditable(): AppError {
  return new AppError({
    code: 'KYC_NOT_EDITABLE',
    message: 'The KYC verification is not an editable current draft',
    statusCode: 409,
  });
}

function toDeletableResource(
  value: string,
): 'image' | 'video' | 'raw' {
  return value === 'video' || value === 'raw' ? value : 'image';
}
