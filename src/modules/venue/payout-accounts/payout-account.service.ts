import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../../identity/owner/owner-access.service.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { PayoutAccountRepository } from './payout-account.repository.js';
import type { VenuePayoutAccountDocument } from './payout-account.types.js';

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
      return (await input.repository.list(oid(values.venueId))).map(present);
    },
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

function present(value: VenuePayoutAccountDocument) {
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

function duplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11_000
  );
}
