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
} from './kyc.types.js';

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
  }): Promise<{ documentId: string; status: 'PENDING' }>;
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
}

export function createKycService(input: {
  repository: KycRepository;
  mediaStorage: MediaStorage;
  config: AppConfig['kyc'];
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
        document_type: normalizeType(values.documentType, true),
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
  }

  return {
    createDraft,
    uploadDocument,
    submit,
    getCurrent,
    isVerified,
    review,
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
    ? ['PAN', 'AADHAAR', 'GST_CERTIFICATE', 'BUSINESS_REGISTRATION', 'ADDRESS_PROOF', 'ID_PROOF']
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
