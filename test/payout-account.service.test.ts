import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { PayoutAccountRepository } from '../src/modules/venue/payout-accounts/payout-account.repository.js';
import { createPayoutAccountService } from '../src/modules/venue/payout-accounts/payout-account.service.js';
import type { VenuePayoutAccountDocument } from '../src/modules/venue/payout-accounts/payout-account.types.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { mismatchedMagicBytesBuffer, validPdfBuffer } from './fixtures/magic-bytes.js';

const ownerId = new ObjectId('687f00000000000000000100');
const venueId = new ObjectId('687f00000000000000000101');
const fixedNow = new Date('2026-07-28T00:00:00.000Z');

function fixture() {
  const accounts: VenuePayoutAccountDocument[] = [];
  const permissions: string[] = [];
  const repository = {
    async insert(value) {
      if (accounts.some(({ vault_account_token }) =>
        vault_account_token === value.vault_account_token)) {
        throw { code: 11_000 };
      }
      accounts.push(value);
    },
    async list(id) {
      return accounts.filter(({ venue_id }) => venue_id.equals(id));
    },
    async verify(input) {
      const account = accounts.find(
        (value) =>
          value._id.equals(input.accountId) &&
          value.venue_id.equals(input.venueId) &&
          value.status === 'PENDING',
      );
      if (!account) return null;
      account.status =
        input.outcome === 'VERIFIED' ? 'VERIFIED' : 'DISABLED';
      account.verified_by =
        input.outcome === 'VERIFIED' ? input.adminId : null;
      account.verified_at =
        input.outcome === 'VERIFIED' ? input.now : null;
      account.verification_method = input.verificationMethod;
      account.verification_failure_reason = input.failureReason;
      account.updated_at = input.now;
      return account;
    },
    async addDocument(input) {
      const account = accounts.find(
        (value) =>
          value._id.equals(input.accountId) &&
          value.venue_id.equals(input.venueId) &&
          value.version === input.expectedVersion,
      );
      if (!account) return null;
      account.documents = [...account.documents, input.document];
      account.version += 1;
      account.updated_at = input.now;
      return account;
    },
  } as PayoutAccountRepository;
  const ownerAccessService = {
    async requirePermission(
      _ownerId: string,
      _venueId: string,
      permission: string,
    ) {
      permissions.push(permission);
    },
  } as unknown as OwnerAccessService;
  const deletedPublicIds: string[] = [];
  return {
    accounts,
    permissions,
    getDeletedPublicIds: () => deletedPublicIds,
    service: createPayoutAccountService({
      repository,
      ownerAccessService,
      mediaStorage: {
        async ping() {},
        async uploadBuffer() {
          return {
            publicId: 'payout-accounts/doc-1',
            secureUrl: 'https://cdn.example.com/payout-accounts/doc-1',
            resourceType: 'image',
            deliveryType: 'authenticated',
            format: 'pdf',
            bytes: 2048,
          } as never;
        },
        async delete(publicId) {
          deletedPublicIds.push(publicId);
        },
      },
      now: () => fixedNow,
    }),
  };
}

test('payout account service stores tokenized metadata and verifies it', async () => {
  const value = fixture();
  const account = await value.service.add({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountHolderName: 'Venue Operations Pvt Ltd',
    vaultProvider: 'bank-vault',
    vaultAccountToken: 'tok_account_123456',
    accountLast4: '6789',
    bankName: 'Example Bank',
    ifscCode: 'ABCD0123456',
  }) as Record<string, unknown>;
  assert.equal(account.status, 'PENDING');
  assert.equal('vaultAccountToken' in account, false);
  assert.deepEqual(value.permissions, ['MANAGE_VENUE']);
  await value.service.list({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
  });
  assert.deepEqual(value.permissions, ['MANAGE_VENUE', 'VIEW_FINANCE']);
  const verified = await value.service.verify({
    adminId: new ObjectId().toHexString(),
    venueId: venueId.toHexString(),
    accountId: account.id as string,
    outcome: 'VERIFIED',
    verificationMethod: 'PENNY_DROP',
    correlationId: 'verify-account',
  }) as Record<string, unknown>;
  assert.equal(verified.status, 'VERIFIED');
  assert.ok(verified.verifiedAt);
});

test('failed payout-account verification requires a reason and disables it', async () => {
  const value = fixture();
  const account = await value.service.add({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountHolderName: 'Venue Operations Pvt Ltd',
    vaultProvider: 'bank-vault',
    vaultAccountToken: 'tok_account_failed_123',
    accountLast4: '1234',
    bankName: 'Example Bank',
    ifscCode: 'ABCD0123456',
  }) as Record<string, unknown>;
  const common = {
    adminId: new ObjectId().toHexString(),
    venueId: venueId.toHexString(),
    accountId: account.id as string,
    outcome: 'FAILED' as const,
    verificationMethod: 'MANUAL' as const,
    correlationId: 'fail-account',
  };
  await assert.rejects(
    value.service.verify(common),
    (error: unknown) =>
      error instanceof AppError && error.code === 'FIELD_REQUIRED',
  );
  const failed = await value.service.verify({
    ...common,
    failureReason: 'Account-holder name mismatch',
  }) as Record<string, unknown>;
  assert.equal(failed.status, 'DISABLED');
});

test('payout account document upload accepts a valid PDF and lowercases the stored MIME type', async () => {
  const value = fixture();
  const account = await value.service.add({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountHolderName: 'Venue Operations Pvt Ltd',
    vaultProvider: 'bank-vault',
    vaultAccountToken: 'tok_account_upload_123',
    accountLast4: '4321',
    bankName: 'Example Bank',
    ifscCode: 'ABCD0123456',
  }) as Record<string, unknown>;

  const result = await value.service.uploadDocument({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountId: account.id as string,
    version: account.version as number,
    documentType: 'CANCELLED_CHEQUE',
    filename: 'cheque.PDF',
    mimeType: 'APPLICATION/PDF',
    buffer: validPdfBuffer(),
  }) as { documents: Array<{ mimeType: string }> };

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.mimeType, 'application/pdf');
});

test('payout account document upload rejects content whose magic bytes do not match the declared MIME type', async () => {
  const value = fixture();
  const account = await value.service.add({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountHolderName: 'Venue Operations Pvt Ltd',
    vaultProvider: 'bank-vault',
    vaultAccountToken: 'tok_account_mismatch_123',
    accountLast4: '5678',
    bankName: 'Example Bank',
    ifscCode: 'ABCD0123456',
  }) as Record<string, unknown>;

  await assert.rejects(
    value.service.uploadDocument({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      accountId: account.id as string,
      version: account.version as number,
      documentType: 'CANCELLED_CHEQUE',
      filename: 'cheque.jpg',
      mimeType: 'image/jpeg',
      buffer: mismatchedMagicBytesBuffer(),
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'FILE_CONTENT_MISMATCH',
  );
});

test('payout account rejects a raw numeric bank account in the vault-token field', async () => {
  const value = fixture();
  await assert.rejects(
    value.service.add({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      accountHolderName: 'Arena Owner',
      vaultProvider: 'bank-vault',
      vaultAccountToken: '1234567890123456',
      accountLast4: '3456',
      bankName: 'Example Bank',
      ifscCode: 'ABCD0123456',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_PAYOUT_ACCOUNT',
  );
});
