import { ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ContractRepository } from './contract.repository.js';
import type {
  CancellationTermsDocument,
  ContractBookingMode,
  PartnerVenueContractDocument,
  RefundRuleDocument,
  SettlementCycle,
} from './contract.types.js';

export interface SaveContractInput {
  adminId: string;
  partnerId: string;
  venueId: string;
  commissionRateBps: number;
  taxRateBps: number;
  settlementCycle: SettlementCycle;
  settlementLagDays: number;
  allowedBookingModes: ContractBookingMode;
  cancellationTerms?: {
    cancellationAllowed: boolean;
    defaultRefundBps: number;
    releaseInventory: boolean;
  };
  refundRules?: Array<{
    minMinutesBeforeStart: number;
    refundBps: number;
    releaseInventory: boolean;
  }>;
  resaleCutoffMinutes?: number;
  effectiveFrom: string;
}

export interface ContractView {
  id: string;
  partnerId: string;
  venueId: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  commissionRateBps: number;
  taxRateBps: number;
  settlementCycle: SettlementCycle;
  settlementLagDays: number;
  allowedBookingModes: ContractBookingMode;
  cancellationTerms: {
    cancellationAllowed: boolean;
    defaultRefundBps: number;
    releaseInventory: boolean;
  };
  refundRules: Array<{
    minMinutesBeforeStart: number;
    refundBps: number;
    releaseInventory: boolean;
  }>;
  resaleCutoffMinutes: number;
  termsVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractService {
  saveVersion(input: SaveContractInput): Promise<ContractView>;
  get(id: string): Promise<ContractView>;
  list(input: {
    partnerId?: string;
    venueId?: string;
  }): Promise<ContractView[]>;
  getActiveContract(input: {
    partnerId: string;
    venueId: string;
    at?: Date;
  }): Promise<ContractView>;
  getCancellationTerms(input: {
    partnerId: string;
    venueId: string;
    at?: Date;
  }): Promise<{
    contractId: string;
    termsVersion: number;
    cancellationTerms: ContractView['cancellationTerms'];
    refundRules: ContractView['refundRules'];
    resaleCutoffMinutes: number;
  }>;
  isBookingModeAllowed(input: {
    partnerId: string;
    venueId: string;
    bookingMode: Exclude<ContractBookingMode, 'BOTH'>;
    at?: Date;
  }): Promise<boolean>;
}

export function createContractService(input: {
  repository: ContractRepository;
  database: DatabaseConnection;
  venueCancellationPolicy?: (venueId:ObjectId)=>Promise<{cancellationAllowed:boolean;defaultRefundBps:number;ownerCancellationNoticeMinutes:number;refundRules:Array<{minMinutesBeforeStart:number;refundBps:number}>;agreementVersion:number}|null>;
  now?: () => Date;
}): ContractService {
  const now = input.now ?? (() => new Date());

  async function active(values: {
    partnerId: string;
    venueId: string;
    at?: Date;
  }): Promise<PartnerVenueContractDocument> {
    const contract = await input.repository.findEffective(
      toObjectId(values.partnerId),
      toObjectId(values.venueId),
      values.at ?? now(),
    );
    if (!contract) {
      throw new AppError({
        code: 'ACTIVE_CONTRACT_NOT_FOUND',
        message: 'No effective Partner-Venue contract was found',
        statusCode: 404,
      });
    }
    return contract;
  }

  return {
    async saveVersion(values) {
      const partnerId = toObjectId(values.partnerId);
      const venueId = toObjectId(values.venueId);
      const adminId = toObjectId(values.adminId);
      const venuePolicy = input.venueCancellationPolicy ? await input.venueCancellationPolicy(venueId) : null;
      if (input.venueCancellationPolicy && !venuePolicy) throw new AppError({code:'VENUE_CANCELLATION_POLICY_REQUIRED',message:'The Venue Owner must accept a cancellation policy before a Partner contract can be created',statusCode:409});
      const terms = normalizeTerms(values);
      if (venuePolicy && values.cancellationTerms && (
        values.cancellationTerms.cancellationAllowed !== venuePolicy.cancellationAllowed ||
        values.cancellationTerms.defaultRefundBps !== venuePolicy.defaultRefundBps ||
        (values.refundRules ?? []).some((rule,index)=>rule.minMinutesBeforeStart!==venuePolicy.refundRules[index]?.minMinutesBeforeStart||rule.refundBps!==venuePolicy.refundRules[index]?.refundBps)
      )) throw new AppError({code:'CONTRACT_CANCELLATION_POLICY_CONFLICT',message:'Partner-Venue cancellation terms must match the Venue Owner accepted policy',statusCode:409});
      const [partner, venue] = await Promise.all([
        input.repository.findPartner(partnerId),
        input.repository.findVenue(venueId),
      ]);
      if (!partner || partner.status !== 'ACTIVE') {
        throw new AppError({
          code: 'CONTRACT_PARTNER_NOT_ELIGIBLE',
          message: 'Partner must be ACTIVE',
          statusCode: 409,
        });
      }
      if (!venue || venue.status !== 'ACTIVE') {
        throw new AppError({
          code: 'CONTRACT_VENUE_NOT_ELIGIBLE',
          message: 'Venue must be ACTIVE',
          statusCode: 409,
        });
      }

      let created: PartnerVenueContractDocument | undefined;
      await input.database.withTransaction(async ({ session }) => {
        const latest = await input.repository.findLatest(
          partnerId,
          venueId,
          session,
        );
        if (latest && terms.effectiveFrom <= latest.effective_from) {
          throw new AppError({
            code: 'CONTRACT_EFFECTIVE_DATE_CONFLICT',
            message: 'A new contract version must start after the latest version',
            statusCode: 409,
          });
        }
        if (
          latest &&
          !(await input.repository.supersede({
            id: latest._id,
            effectiveTo: terms.effectiveFrom,
            session,
          }))
        ) {
          throw new AppError({
            code: 'CONTRACT_VERSION_CONFLICT',
            message: 'The active contract changed during version creation',
            statusCode: 409,
          });
        }

        const timestamp = now();
        created = {
          _id: new ObjectId(),
          partner_id: partnerId,
          venue_id: venueId,
          status: 'ACTIVE',
          settlement_cycle: values.settlementCycle,
          settlement_lag_days: values.settlementLagDays,
          commission_rate_bps: values.commissionRateBps,
          tax_rate_bps: values.taxRateBps,
          allowed_booking_modes: values.allowedBookingModes,
          cancellation_terms: venuePolicy ? { cancellation_allowed:venuePolicy.cancellationAllowed,default_refund_bps:venuePolicy.defaultRefundBps,release_inventory:true } : terms.cancellationTerms,
          resale_cutoff_minutes: venuePolicy?.ownerCancellationNoticeMinutes ?? values.resaleCutoffMinutes ?? 0,
          refund_rules: { rules: venuePolicy ? venuePolicy.refundRules.map(rule=>({min_minutes_before_start:rule.minMinutesBeforeStart,refund_bps:rule.refundBps,release_inventory:true})) : terms.refundRules },
          terms_version: (latest?.terms_version ?? 0) + 1,
          effective_from: terms.effectiveFrom,
          effective_to: null,
          audit_history: [{
            event_type: 'CONTRACT_VERSION_CREATED',
            actor_type: 'ADMIN',
            actor_id: adminId,
            correlation_id: new ObjectId().toHexString(),
            changes: { terms_version: (latest?.terms_version ?? 0) + 1, cancellation_policy_source: venuePolicy ? 'VENUE_OWNER_AGREEMENT' : 'LEGACY_INPUT', venue_agreement_version: venuePolicy?.agreementVersion ?? null },
            occurred_at: timestamp,
          }],
          created_at: timestamp,
          updated_at: timestamp,
        };
        await input.repository.insert(created, session);
      });
      if (!created) {
        throw new Error('Contract transaction completed without a result');
      }
      return toView(created);
    },

    async get(id) {
      const contract = await input.repository.findById(toObjectId(id));
      if (!contract) throw contractNotFound();
      return toView(contract);
    },
    async list(values) {
      return (await input.repository.list({
        ...(values.partnerId ? { partnerId: toObjectId(values.partnerId) } : {}),
        ...(values.venueId ? { venueId: toObjectId(values.venueId) } : {}),
      })).map(toView);
    },
    async getActiveContract(values) {
      return toView(await active(values));
    },
    async getCancellationTerms(values) {
      const contract = toView(await active(values));
      return {
        contractId: contract.id,
        termsVersion: contract.termsVersion,
        cancellationTerms: contract.cancellationTerms,
        refundRules: contract.refundRules,
        resaleCutoffMinutes: contract.resaleCutoffMinutes,
      };
    },
    async isBookingModeAllowed(values) {
      const mode = (await active(values)).allowed_booking_modes;
      return mode === 'BOTH' || mode === values.bookingMode;
    },
  };
}

function normalizeTerms(values: SaveContractInput): {
  effectiveFrom: Date;
  cancellationTerms: CancellationTermsDocument;
  refundRules: RefundRuleDocument[];
} {
  validateBps(values.commissionRateBps, 'Commission');
  validateBps(values.taxRateBps, 'Tax');
  if (values.commissionRateBps + values.taxRateBps > 10_000) {
    throw invalidTerms('Commission and tax must total at most 100 percent');
  }
  if (!['T_PLUS_N', 'WEEKLY', 'MONTHLY'].includes(values.settlementCycle)) {
    throw invalidTerms('Settlement cycle is invalid');
  }
  if (!Number.isInteger(values.settlementLagDays) || values.settlementLagDays < 0) {
    throw invalidTerms('Settlement lag must be a non-negative integer');
  }
  if (!['OPEN_TIME', 'FIXED_SLOT', 'BOTH'].includes(values.allowedBookingModes)) {
    throw invalidTerms('Allowed booking mode is invalid');
  }
  if (values.resaleCutoffMinutes !== undefined && (!Number.isInteger(values.resaleCutoffMinutes) || values.resaleCutoffMinutes < 0)) {
    throw invalidTerms('Resale cutoff must be a non-negative integer');
  }
  const effectiveFrom = new Date(values.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw invalidTerms('Effective date must be a valid ISO-8601 timestamp');
  }
  const legacyTerms=values.cancellationTerms;
  const cancellationTerms: CancellationTermsDocument = {
    cancellation_allowed: legacyTerms?.cancellationAllowed ?? false,
    default_refund_bps: validateBps(
      legacyTerms?.defaultRefundBps ?? 0,
      'Default refund',
    ),
    release_inventory: legacyTerms?.releaseInventory ?? false,
  };
  const thresholds = new Set<number>();
  if ((values.refundRules?.length ?? 0) > 50) {
    throw invalidTerms('A contract can contain at most 50 refund rules');
  }
  const refundRules = (values.refundRules ?? []).map((rule) => {
    if (
      !Number.isInteger(rule.minMinutesBeforeStart) ||
      rule.minMinutesBeforeStart < 0 ||
      thresholds.has(rule.minMinutesBeforeStart)
    ) {
      throw invalidTerms('Refund-rule thresholds must be unique non-negative integers');
    }
    thresholds.add(rule.minMinutesBeforeStart);
    return {
      min_minutes_before_start: rule.minMinutesBeforeStart,
      refund_bps: validateBps(rule.refundBps, 'Refund rule'),
      release_inventory: rule.releaseInventory,
    };
  }).sort((a, b) => b.min_minutes_before_start - a.min_minutes_before_start);
  if (
    !cancellationTerms.cancellation_allowed &&
    (cancellationTerms.default_refund_bps !== 0 ||
      cancellationTerms.release_inventory ||
      refundRules.length > 0)
  ) {
    throw invalidTerms('Disabled cancellation cannot define refunds or inventory release');
  }
  return { effectiveFrom, cancellationTerms, refundRules };
}

function validateBps(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw invalidTerms(`${label} percent must be from 0 to 100`);
  }
  return value;
}

function toView(contract: PartnerVenueContractDocument): ContractView {
  return {
    id: contract._id.toHexString(),
    partnerId: contract.partner_id.toHexString(),
    venueId: contract.venue_id.toHexString(),
    status: contract.status,
    commissionRateBps: contract.commission_rate_bps,
    taxRateBps: contract.tax_rate_bps,
    settlementCycle: contract.settlement_cycle,
    settlementLagDays: contract.settlement_lag_days,
    allowedBookingModes: contract.allowed_booking_modes,
    cancellationTerms: {
      cancellationAllowed: contract.cancellation_terms.cancellation_allowed,
      defaultRefundBps: contract.cancellation_terms.default_refund_bps,
      releaseInventory: contract.cancellation_terms.release_inventory,
    },
    refundRules: contract.refund_rules.rules.map((rule) => ({
      minMinutesBeforeStart: rule.min_minutes_before_start,
      refundBps: rule.refund_bps,
      releaseInventory: rule.release_inventory,
    })),
    resaleCutoffMinutes: contract.resale_cutoff_minutes,
    termsVersion: contract.terms_version,
    effectiveFrom: contract.effective_from.toISOString(),
    effectiveTo: contract.effective_to?.toISOString() ?? null,
    createdAt: contract.created_at.toISOString(),
    updatedAt: contract.updated_at.toISOString(),
  };
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

function invalidTerms(message: string): AppError {
  return new AppError({
    code: 'INVALID_CONTRACT_TERMS',
    message,
    statusCode: 400,
  });
}

function contractNotFound(): AppError {
  return new AppError({
    code: 'CONTRACT_NOT_FOUND',
    message: 'Partner-Venue contract was not found',
    statusCode: 404,
  });
}
