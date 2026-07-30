import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { KycRepository } from '../src/modules/identity/kyc/kyc.repository.js';
import { createKycService } from '../src/modules/identity/kyc/kyc.service.js';
import type {
  KycDocumentDocument,
  KycVerificationDocument,
} from '../src/modules/identity/kyc/kyc.types.js';
import type { MediaStorage } from '../src/shared/media/cloudinary-media-storage.js';
import { AppError } from '../src/shared/errors/app-error.js';

const fixedNow = new Date('2026-07-28T08:00:00.000Z');

function createFixture(options: {
  failInsert?: boolean;
  status?: KycVerificationDocument['status'];
  documentCount?: number;
  expiresAt?: Date | null;
} = {}) {
  const subjectId = new ObjectId('687f00000000000000000020');
  const verification: KycVerificationDocument = {
    _id: new ObjectId('687f00000000000000000021'),
    subject_type: 'VENUE_OWNER',
    subject_id: subjectId,
    verification_type: 'BUSINESS',
    status: options.status ?? 'PENDING',
    is_current: true,
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    expires_at: options.expiresAt ?? null,
    audit_history: [],
    created_at: fixedNow,
  };
  let insertedDocument: KycDocumentDocument | undefined;
  let deletedPublicId: string | undefined;
  let createDraftCalls = 0;
  const repository: KycRepository = {
    async createDraft() {
      createDraftCalls += 1;
      return verification;
    },
    async findVerification(id) {
      return id.equals(verification._id) ? verification : null;
    },
    async findCurrent() {
      return verification;
    },
    async insertDocument(document) {
      if (options.failInsert) {
        throw new Error('database failed');
      }
      insertedDocument = document;
    },
    async countActiveDocuments() {
      return options.documentCount ?? (insertedDocument ? 1 : 0);
    },
    async submit() {
      return true;
    },
    async review() {
      return true;
    },
  };
  const mediaStorage: MediaStorage = {
    async ping() {},
    async uploadBuffer() {
      return {
        publicId: 'kyc/document-1',
        resourceType: 'image',
        deliveryType: 'authenticated',
        format: 'jpg',
        bytes: 128,
        width: 100,
        height: 100,
        url: 'http://example.com/private',
        secureUrl: 'https://example.com/private',
        version: 1,
        checksum: 'etag-value',
      };
    },
    async delete(publicId) {
      deletedPublicId = publicId;
    },
  };
  const service = createKycService({
    repository,
    mediaStorage,
    config: {
      maxFileBytes: 1024,
      allowedMimeTypes: ['image/jpeg', 'application/pdf'],
    },
    now: () => fixedNow,
  });
  return {
    subjectId,
    verification,
    service,
    getInsertedDocument: () => insertedDocument,
    getDeletedPublicId: () => deletedPublicId,
    getCreateDraftCalls: () => createDraftCalls,
  };
}

test('KYC upload stores protected Cloudinary metadata', async () => {
  const fixture = createFixture();
  const result = await fixture.service.uploadDocument({
    verificationId: fixture.verification._id.toHexString(),
    subjectId: fixture.subjectId.toHexString(),
    documentType: 'GST_CERTIFICATE',
    filename: 'gst.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('document'),
  });

  assert.equal(result.status, 'PENDING');
  assert.equal(
    fixture.getInsertedDocument()?.file.status,
    'ACTIVE',
  );
  assert.equal(
    fixture.getInsertedDocument()?.file.storage_key,
    'kyc/document-1',
  );
  assert.equal(
    fixture.getInsertedDocument()?.file.checksum,
    'etag-value',
  );
  assert.equal(
    fixture.getInsertedDocument()?.file.classification,
    'SENSITIVE',
  );
});

test('KYC upload deletes Cloudinary bytes when MongoDB insert fails', async () => {
  const fixture = createFixture({ failInsert: true });

  await assert.rejects(
    fixture.service.uploadDocument({
      verificationId: fixture.verification._id.toHexString(),
      subjectId: fixture.subjectId.toHexString(),
      documentType: 'GST_CERTIFICATE',
      filename: 'gst.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    }),
    /database failed/,
  );
  assert.equal(fixture.getDeletedPublicId(), 'kyc/document-1');
});

test('KYC rejection requires a reason', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.review({
      verificationId: fixture.verification._id.toHexString(),
      adminId: new ObjectId().toHexString(),
      status: 'REJECTED',
      correlationId: 'reject-without-reason',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'REJECTION_REASON_REQUIRED',
  );
});

test('creating a draft is idempotent while the current draft is editable', async () => {
  const fixture = createFixture();

  const result = await fixture.service.createDraft({
    subjectType: 'VENUE_OWNER',
    subjectId: fixture.subjectId.toHexString(),
    verificationType: 'business',
  });

  assert.equal(result.id, fixture.verification._id.toHexString());
  assert.equal(fixture.getCreateDraftCalls(), 0);
});

test('a submitted KYC cannot be replaced by a new draft', async () => {
  const fixture = createFixture({ status: 'PENDING' });
  fixture.verification.audit_history.push({
    event_type: 'KYC_SUBMITTED',
  });

  await assert.rejects(
    fixture.service.createDraft({
      subjectType: 'VENUE_OWNER',
      subjectId: fixture.subjectId.toHexString(),
      verificationType: 'BUSINESS',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'KYC_ALREADY_IN_PROGRESS',
  );
});

test('KYC document access is isolated to the authenticated subject', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.service.uploadDocument({
      verificationId: fixture.verification._id.toHexString(),
      subjectId: new ObjectId().toHexString(),
      documentType: 'GST_CERTIFICATE',
      filename: 'gst.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('document'),
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'KYC_NOT_EDITABLE',
  );
  assert.equal(fixture.getInsertedDocument(), undefined);
});

test('KYC submission requires at least one active document', async () => {
  const fixture = createFixture({ documentCount: 0 });

  await assert.rejects(
    fixture.service.submit({
      verificationId: fixture.verification._id.toHexString(),
      subjectId: fixture.subjectId.toHexString(),
      correlationId: 'submit-without-document',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'KYC_DOCUMENT_REQUIRED',
  );
});

test('KYC review rejects an expiry that is not in the future', async () => {
  const fixture = createFixture({ status: 'PENDING' });

  await assert.rejects(
    fixture.service.review({
      verificationId: fixture.verification._id.toHexString(),
      adminId: new ObjectId().toHexString(),
      status: 'VERIFIED',
      expiresAt: fixedNow.toISOString(),
      correlationId: 'invalid-expiry',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVALID_KYC_EXPIRY',
  );
});

test('KYC review requires a submitted current verification with documents', async () => {
  const fixture = createFixture({ documentCount: 1 });

  await assert.rejects(
    fixture.service.review({
      verificationId: fixture.verification._id.toHexString(),
      adminId: new ObjectId().toHexString(),
      status: 'VERIFIED',
      correlationId: 'review-before-submit',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'KYC_REVIEW_NOT_READY',
  );

  fixture.verification.audit_history.push({
    event_type: 'KYC_SUBMITTED',
  });
  await fixture.service.review({
    verificationId: fixture.verification._id.toHexString(),
    adminId: new ObjectId().toHexString(),
    status: 'VERIFIED',
    correlationId: 'review-submitted',
  });
});
