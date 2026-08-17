import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import { createPartnerPayoutAccountService } from '../src/modules/identity/partner/partner-payout-account.service.js';
import type { MediaStorage } from '../src/shared/media/cloudinary-media-storage.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { mismatchedMagicBytesBuffer, validPdfBuffer } from './fixtures/magic-bytes.js';

const now = new Date('2026-07-28T09:00:00.000Z');

interface StoredAccount {
  _id: ObjectId;
  [key: string]: unknown;
}

function createFakeDb() {
  const store = new Map<string, StoredAccount>();
  const collection = {
    async insertOne(doc: StoredAccount) {
      store.set(doc._id.toHexString(), doc);
    },
    find(filter: Record<string, unknown>) {
      const results = [...store.values()].filter((doc) =>
        Object.entries(filter).every(([key, value]) => doc[key] === value),
      );
      return {
        sort: () => ({
          toArray: async () => results,
        }),
      };
    },
    async findOneAndUpdate(
      filter: { _id: ObjectId; version?: number },
      update: { $push?: Record<string, unknown>; $set?: Record<string, unknown> },
    ) {
      const existing = store.get(filter._id.toHexString());
      if (!existing) return null;
      if (filter.version !== undefined && existing.version !== filter.version) return null;
      const documents = (existing.documents as unknown[]) ?? [];
      const pushed = update.$push?.documents
        ? [...documents, update.$push.documents]
        : documents;
      const updated: StoredAccount = {
        ...existing,
        ...update.$set,
        documents: pushed,
        version: (existing.version as number) + 1,
      };
      store.set(filter._id.toHexString(), updated);
      return updated;
    },
  };
  return {
    collection: () => collection,
    store,
  };
}

function createFixture() {
  const fakeDb = createFakeDb();
  const uploadedBuffers: { publicId: string }[] = [];
  const mediaStorage: MediaStorage = {
    async ping() {},
    async uploadBuffer() {
      const publicId = `partner-payout-accounts/doc-${uploadedBuffers.length + 1}`;
      uploadedBuffers.push({ publicId });
      return {
        publicId,
        secureUrl: `https://cdn.example.com/${publicId}`,
        resourceType: 'image',
        deliveryType: 'authenticated',
        format: 'pdf',
        bytes: 1024,
      } as never;
    },
    async delete() {},
  };
  const service = createPartnerPayoutAccountService(
    fakeDb as never,
    mediaStorage,
    () => now,
  );
  return { service, fakeDb };
}

test('partner payout account upload accepts a valid PDF and lowercases the stored MIME type', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    partnerId: new ObjectId().toHexString(),
    label: 'Primary Account',
    accountHolderName: 'Turf Partner',
    bankName: 'Example Bank',
    ifscCode: 'RAZR0000001',
    accountLast4: '6789',
    accountVaultToken: 'vault_abcdef123456',
  }) as { accountId: string; partnerId: string; version: number };

  const result = await fixture.service.upload({
    partnerId: created.partnerId,
    accountId: created.accountId,
    version: created.version,
    documentType: 'CANCELLED_CHEQUE',
    filename: 'cheque.PDF',
    mimeType: 'APPLICATION/PDF',
    buffer: validPdfBuffer(),
  }) as { documents: Array<{ mimeType: string }> };

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.mimeType, 'application/pdf');
});

test('partner payout account upload rejects content whose magic bytes do not match the declared MIME type', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    partnerId: new ObjectId().toHexString(),
    label: 'Primary Account',
    accountHolderName: 'Turf Partner',
    bankName: 'Example Bank',
    ifscCode: 'RAZR0000001',
    accountLast4: '6789',
    accountVaultToken: 'vault_abcdef123456',
  }) as { accountId: string; partnerId: string; version: number };

  await assert.rejects(
    fixture.service.upload({
      partnerId: created.partnerId,
      accountId: created.accountId,
      version: created.version,
      documentType: 'CANCELLED_CHEQUE',
      filename: 'cheque.jpg',
      mimeType: 'image/jpeg',
      buffer: mismatchedMagicBytesBuffer(),
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'FILE_CONTENT_MISMATCH',
  );
});
