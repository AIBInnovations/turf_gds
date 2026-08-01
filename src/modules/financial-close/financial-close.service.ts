import { MongoServerError, ObjectId, type ClientSession } from 'mongodb';

import type { OutboxRepository } from '../../shared/communications/outbox.repository.js';
import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import type { BookingDocument } from '../booking/booking.types.js';
import type {
  LedgerEntryDocument,
} from '../ledger/ledger.repository.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { FinancialCloseRepository } from './financial-close.repository.js';
import type {
  FinancialEnvironment,
  InvoiceDocument,
  PayoutDocument,
  PayoutStatus,
  ReconciliationDocument,
  SettlementDocument,
  SettlementStatus,
} from './financial-close.types.js';

export interface GenerateSettlementInput {
  adminId: string;
  partnerId: string;
  environment: FinancialEnvironment;
  periodStart: string;
  periodEnd: string;
  correlationId: string;
}

export interface RecordReconciliationInput {
  adminId: string;
  settlementId: string;
  reportedAmountMinor: number;
  bankReference: string;
  evidenceUri?: string;
  notes?: string;
  correlationId: string;
}

export interface PageView {
  items: Record<string, unknown>[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface FinancialCloseService {
  generate(input: GenerateSettlementInput): Promise<Record<string, unknown>>;
  submit(input: MutationInput): Promise<Record<string, unknown>>;
  reconcile(input: RecordReconciliationInput): Promise<Record<string, unknown>>;
  resolve(input: MutationInput & {
    evidenceUri: string;
    notes: string;
  }): Promise<Record<string, unknown>>;
  complete(input: MutationInput): Promise<Record<string, unknown>>;
  get(settlementId: string): Promise<Record<string, unknown>>;
  list(input: {
    partnerId?: string;
    environment?: FinancialEnvironment;
    status?: SettlementStatus;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<PageView>;
  initiatePayout(input: {
    adminId: string;
    settlementId: string;
    venueId: string;
    payoutAccountId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<Record<string, unknown>>;
  recordPayoutResult(input: {
    adminId: string;
    payoutId: string;
    status: 'PAID' | 'FAILED';
    bankReference?: string;
    failureReason?: string;
    correlationId: string;
  }): Promise<Record<string, unknown>>;
  listOwnerSettlements(input: OwnerListInput & {
    status?: SettlementStatus;
  }): Promise<PageView>;
  getOwnerSettlement(input: OwnerScope & {
    settlementId: string;
  }): Promise<Record<string, unknown>>;
  listOwnerPayouts(input: OwnerListInput & {
    status?: PayoutStatus;
  }): Promise<PageView>;
  getOwnerPayout(input: OwnerScope & {
    payoutId: string;
  }): Promise<Record<string, unknown>>;
  recordAdjustment?(input: AdjustmentInput): Promise<Record<string, unknown>>;
  createInvoice?(input: MutationInput): Promise<Record<string, unknown>>;
  listInvoices?(input: {
    settlementId?: string;
    environment?: FinancialEnvironment;
    status?: InvoiceDocument['status'];
    page?: number;
    limit?: number;
  }): Promise<PageView>;
  getInvoice?(invoiceId: string): Promise<Record<string, unknown>>;
  issueInvoice?(input: {
    adminId: string;
    invoiceId: string;
    correlationId: string;
  }): Promise<Record<string, unknown>>;
  voidInvoice?(input: {
    adminId: string;
    invoiceId: string;
    correlationId: string;
  }): Promise<Record<string, unknown>>;
}

interface AdjustmentInput {
  adminId: string;
  settlementId: string;
  bookingId: string;
  lines: Array<{
    direction: 'DEBIT' | 'CREDIT';
    amountMinor: number;
    component: 'GROSS' | 'COMMISSION' | 'TAX' | 'VENUE_NET';
  }>;
  reason: string;
  evidenceUri: string;
  effectiveAt?: string;
  correlationId: string;
}

interface MutationInput {
  adminId: string;
  settlementId: string;
  correlationId: string;
}

interface OwnerScope {
  actorOwnerId: string;
  venueId: string;
}

interface OwnerListInput extends OwnerScope {
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export function createFinancialCloseService(input: {
  repository: FinancialCloseRepository;
  ledgerService: LedgerService;
  outboxRepository: OutboxRepository;
  ownerAccessService: OwnerAccessService;
  database: DatabaseConnection;
  now?: () => Date;
}): FinancialCloseService {
  const now = input.now ?? (() => new Date());

  return {
    async generate(values) {
      const adminId = oid(values.adminId);
      const partnerId = oid(values.partnerId);
      const periodStart = instant(values.periodStart, 'periodStart');
      const periodEnd = instant(values.periodEnd, 'periodEnd');
      if (periodStart >= periodEnd) {
        throw invalid(
          'INVALID_SETTLEMENT_PERIOD',
          'periodStart must be before periodEnd',
        );
      }
      let created: SettlementDocument | undefined;
      try {
        await input.database.withTransaction(async ({ session }) => {
          if (
            await input.repository.findSettlementPeriod({
              partnerId,
              environment: values.environment,
              periodStart,
              periodEnd,
              session,
            })
          ) {
            throw conflict(
              'SETTLEMENT_ALREADY_EXISTS',
              'A settlement already exists for this partner and period',
            );
          }
          const entries = await input.ledgerService.listUnsettled({
            partnerId,
            environment: values.environment,
            periodStart,
            periodEnd,
            session,
          });
          if (entries.length === 0) {
            throw conflict(
              'NO_UNSETTLED_LEDGER_ENTRIES',
              'No unsettled Ledger entries exist for this batch',
            );
          }
          const originals = await hydrateReversalOriginals(entries, session);
          const contractIds = uniqueIds(
            entries.map(({ contract_id }) => contract_id),
          );
          const contracts = await input.repository.findContracts(
            contractIds,
            session,
          );
          if (
            contracts.length !== contractIds.length ||
            contracts.some(({ partner_id }) => !partner_id.equals(partnerId))
          ) {
            throw conflict(
              'SETTLEMENT_CONTRACT_MISMATCH',
              'Ledger Contracts must exist and belong to the settlement Partner',
            );
          }
          const cycles = new Set(
            contracts.map(({ settlement_cycle }) => settlement_cycle),
          );
          if (cycles.size !== 1) {
            throw conflict(
              'SETTLEMENT_CYCLE_CONFLICT',
              'All entries in a settlement batch must use one settlement cycle',
            );
          }
          const totals = aggregate(entries, originals);
          assertAggregate(totals);
          const timestamp = now();
          const maxLagDays = Math.max(
            ...contracts.map(({ settlement_lag_days }) => settlement_lag_days),
          );
          created = {
            _id: new ObjectId(),
            partner_id: partnerId,
            environment: values.environment,
            period_start: periodStart,
            period_end: periodEnd,
            cycle: [...cycles][0]!,
            due_at: new Date(
              periodEnd.getTime() + maxLagDays * 24 * 60 * 60 * 1_000,
            ),
            status: 'DRAFT',
            ...totals,
            currency: 'INR',
            audit_history: [{
              event_type: 'SETTLEMENT_DRAFT_CREATED',
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: values.correlationId,
              changes: { ledger_entry_count: entries.length },
              occurred_at: timestamp,
            }],
            created_at: timestamp,
            completed_at: null,
          };
          await input.repository.insertSettlement(created, session);
          if (
            !(await input.ledgerService.allocateToSettlement({
              entryIds: entries.map(({ _id }) => _id),
              settlementId: created._id,
              session,
            }))
          ) {
            throw conflict(
              'LEDGER_ALLOCATION_CONFLICT',
              'One or more Ledger entries were allocated concurrently',
            );
          }
          await enqueueFinancialEvent(
            created._id,
            created.partner_id,
            null,
            created.environment,
            'SETTLEMENT_DRAFT_CREATED',
            1,
            values.correlationId,
            {
              settlement_id: created._id.toHexString(),
              status: created.status,
              period_start: created.period_start.toISOString(),
              period_end: created.period_end.toISOString(),
              net_amount_minor: created.net_amount_minor,
              currency: created.currency,
            },
            timestamp,
            session,
          );
          for (const venueId of uniqueIds(entries.map(({ venue_id }) => venue_id))) {
            await input.outboxRepository.enqueue({aggregateType:'SETTLEMENT',aggregateId:created._id,partnerId:null,venueId,environment:created.environment,eventType:'SETTLEMENT_DRAFT_CREATED',eventVersion:1,correlationId:`${values.correlationId}:venue:${venueId.toHexString()}`,payload:{settlement_id:created._id.toHexString(),venue_id:venueId.toHexString(),status:created.status,period_start:created.period_start.toISOString(),period_end:created.period_end.toISOString(),currency:created.currency},now:timestamp,session});
          }
        });
      } catch (error) {
        if (duplicate(error)) {
          throw conflict(
            'SETTLEMENT_ALREADY_EXISTS',
            'A settlement already exists for this partner and period',
          );
        }
        throw error;
      }
      if (!created) throw new Error('Settlement transaction returned no result');
      return settlementView(created);
    },

    async submit(values) {
      return transition({
        ...values,
        from: 'DRAFT',
        to: 'PENDING_FUNDS',
        errorCode: 'SETTLEMENT_NOT_DRAFT',
      });
    },

    async reconcile(values) {
      if (
        !Number.isSafeInteger(values.reportedAmountMinor) ||
        values.reportedAmountMinor < 0
      ) {
        throw invalid(
          'INVALID_REPORTED_AMOUNT',
          'reportedAmountMinor must be a non-negative safe integer',
        );
      }
      const bankReference = required(values.bankReference, 'bankReference');
      const adminId = oid(values.adminId);
      const settlementId = oid(values.settlementId);
      const evidenceUri = optional(values.evidenceUri);
      const notes = optional(values.notes);
      let result:
        | { settlement: SettlementDocument; reconciliation: ReconciliationDocument }
        | undefined;
      try {
        await input.database.withTransaction(async ({ session }) => {
          const settlement = await input.repository.findSettlement(
            settlementId,
            session,
          );
          if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
          if (settlement.status !== 'PENDING_FUNDS') {
            throw conflict(
              'SETTLEMENT_NOT_AWAITING_FUNDS',
              'Settlement must be PENDING_FUNDS before reconciliation',
            );
          }
          const matched =
            values.reportedAmountMinor === settlement.net_amount_minor;
          if (!matched && !notes) {
            throw invalid(
              'RECONCILIATION_NOTES_REQUIRED',
              'notes are required when the reported amount does not match',
            );
          }
          const timestamp = now();
          const status = matched ? 'MATCHED' as const : 'MISMATCH' as const;
          const reconciliation: ReconciliationDocument = {
            _id: new ObjectId(),
            settlement_id: settlementId,
            environment: settlement.environment,
            reconciled_by: matched ? adminId : null,
            reported_amount_minor: values.reportedAmountMinor,
            bank_reference: bankReference,
            evidence_uri: evidenceUri,
            status,
            reconciled_at: matched ? timestamp : null,
            notes,
            attempt_history: [{
              action: 'RECORDED',
              reported_amount_minor: values.reportedAmountMinor,
              expected_amount_minor: settlement.net_amount_minor,
              bank_reference: bankReference,
              evidence_uri: evidenceUri,
              notes,
              actor_id: adminId,
              occurred_at: timestamp,
            }],
            audit_history: [{
              event_type: `RECONCILIATION_${status}`,
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: values.correlationId,
              changes: {
                expected_amount_minor: settlement.net_amount_minor,
                reported_amount_minor: values.reportedAmountMinor,
              },
              occurred_at: timestamp,
            }],
            created_at: timestamp,
          };
          await input.repository.insertReconciliation(reconciliation, session);
          const transitioned = await input.repository.transitionSettlement({
            id: settlementId,
            from: 'PENDING_FUNDS',
            to: matched ? 'RECONCILED' : 'RECONCILING',
            adminId,
            correlationId: values.correlationId,
            now: timestamp,
            session,
          });
          if (!transitioned) throw stateConflict();
          result = { settlement: transitioned, reconciliation };
        });
      } catch (error) {
        if (duplicate(error)) {
          throw conflict(
            'RECONCILIATION_BANK_REFERENCE_DUPLICATE',
            'This bank reference is already recorded for the settlement',
          );
        }
        throw error;
      }
      if (!result) throw new Error('Reconciliation transaction returned no result');
      return reconciliationView(result.settlement, result.reconciliation);
    },

    async resolve(values) {
      const adminId = oid(values.adminId);
      const settlementId = oid(values.settlementId);
      const notes = required(values.notes, 'notes');
      const evidenceUri = required(values.evidenceUri, 'evidenceUri');
      let result:
        | { settlement: SettlementDocument; reconciliation: ReconciliationDocument }
        | undefined;
      await input.database.withTransaction(async ({ session }) => {
        const settlement = await input.repository.findSettlement(
          settlementId,
          session,
        );
        if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
        if (settlement.status !== 'RECONCILING') throw stateConflict();
        const existing = await input.repository.findReconciliation(
          settlementId,
          session,
        );
        if (!existing || existing.status !== 'MISMATCH') {
          throw conflict(
            'RECONCILIATION_NOT_MISMATCHED',
            'Only a mismatched reconciliation can be resolved',
          );
        }
        const timestamp = now();
        const reconciled = await input.repository.resolveReconciliation({
          settlementId,
          adminId,
          evidenceUri,
          notes,
          attempt: {
            action: 'RESOLVED',
            reported_amount_minor: existing.reported_amount_minor,
            expected_amount_minor: settlement.net_amount_minor,
            bank_reference: existing.bank_reference,
            evidence_uri: evidenceUri,
            notes,
            actor_id: adminId,
            occurred_at: timestamp,
          },
          correlationId: values.correlationId,
          now: timestamp,
          session,
        });
        if (!reconciled) throw stateConflict();
        const transitioned = await input.repository.transitionSettlement({
          id: settlementId,
          from: 'RECONCILING',
          to: 'RECONCILED',
          adminId,
          correlationId: values.correlationId,
          now: timestamp,
          session,
        });
        if (!transitioned) throw stateConflict();
        result = { settlement: transitioned, reconciliation: reconciled };
      });
      if (!result) throw new Error('Resolution transaction returned no result');
      return reconciliationView(result.settlement, result.reconciliation);
    },

    async complete(values) {
      const settlementId = oid(values.settlementId);
      const adminId = oid(values.adminId);
      let completed: SettlementDocument | undefined;
      await input.database.withTransaction(async ({ session }) => {
        const settlement = await input.repository.findSettlement(
          settlementId,
          session,
        );
        if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
        if (settlement.status !== 'RECONCILED') throw stateConflict();
        const reconciliation = await input.repository.findReconciliation(
          settlementId,
          session,
        );
        if (
          !reconciliation ||
          !['MATCHED', 'RESOLVED'].includes(reconciliation.status)
        ) {
          throw conflict(
            'RECONCILIATION_NOT_APPROVED',
            'A matched or resolved reconciliation is required',
          );
        }
        const timestamp = now();
        completed =
          (await input.repository.transitionSettlement({
            id: settlementId,
            from: 'RECONCILED',
            to: 'COMPLETED',
            adminId,
            correlationId: values.correlationId,
            now: timestamp,
            completedAt: timestamp,
            session,
          })) ?? undefined;
        if (!completed) throw stateConflict();
        await enqueueFinancialEvent(
          completed._id,
          completed.partner_id,
          null,
          completed.environment,
          'SETTLEMENT_COMPLETED',
          2,
          values.correlationId,
          {
            settlement_id: completed._id.toHexString(),
            status: completed.status,
            period_start: completed.period_start.toISOString(),
            period_end: completed.period_end.toISOString(),
            net_amount_minor: completed.net_amount_minor,
            currency: completed.currency,
          },
          timestamp,
          session,
        );
        const financialDb = input.database.db;
        if (financialDb) {
          const venueIds = await financialDb.collection<LedgerEntryDocument>('ledger_entries').distinct('venue_id',{settlement_id:completed._id},{session}) as ObjectId[];
          for (const venueId of venueIds) {
            await input.outboxRepository.enqueue({aggregateType:'SETTLEMENT',aggregateId:completed._id,partnerId:null,venueId,environment:completed.environment,eventType:'SETTLEMENT_COMPLETED',eventVersion:2,correlationId:`${values.correlationId}:venue:${venueId.toHexString()}`,payload:{settlement_id:completed._id.toHexString(),venue_id:venueId.toHexString(),status:completed.status,period_start:completed.period_start.toISOString(),period_end:completed.period_end.toISOString(),currency:completed.currency},now:timestamp,session});
          }
        }
      });
      if (!completed) throw new Error('Completion transaction returned no result');
      return settlementView(completed);
    },

    async get(settlementId) {
      const id = oid(settlementId);
      const settlement = await input.repository.findSettlement(id);
      if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
      const reconciliation = await input.repository.findReconciliation(id);
      return {
        ...settlementView(settlement),
        reconciliation: reconciliation
          ? reconciliationOnlyView(reconciliation)
          : null,
      };
    },

    async list(values) {
      const pagination = page(values.page, values.limit);
      const result = await input.repository.listSettlements({
        ...(values.partnerId ? { partnerId: oid(values.partnerId) } : {}),
        ...(values.environment ? { environment: values.environment } : {}),
        ...(values.status ? { status: values.status } : {}),
        ...(values.from ? { from: instant(values.from, 'from') } : {}),
        ...(values.to ? { to: instant(values.to, 'to') } : {}),
        ...pagination,
      });
      return pageView(result.items.map(settlementView), result.total, pagination);
    },

    async initiatePayout(values) {
      const settlementId = oid(values.settlementId);
      const venueId = oid(values.venueId);
      const payoutAccountId = oid(values.payoutAccountId);
      const adminId = oid(values.adminId);
      const key = required(values.idempotencyKey, 'idempotencyKey');
      let result: PayoutDocument | undefined;
      try {
        await input.database.withTransaction(async ({ session }) => {
          const replay = await input.repository.findPayoutByIdempotency(
            key,
            session,
          );
          if (replay) {
            if (
              replay.settlement_id.equals(settlementId) &&
              replay.venue_id.equals(venueId) &&
              replay.payout_account_id.equals(payoutAccountId)
            ) {
              result = replay;
              return;
            }
            throw conflict(
              'PAYOUT_IDEMPOTENCY_KEY_REUSED',
              'Payout idempotency key was used for another request',
            );
          }
          if (
            await input.repository.findPayoutForSettlementVenue(
              settlementId,
              venueId,
              session,
            )
          ) {
            throw conflict(
              'PAYOUT_ALREADY_EXISTS',
              'A payout already exists for this Settlement and Venue',
            );
          }
          const [settlement, venue, owner, account, entries] =
            await Promise.all([
              input.repository.findSettlement(settlementId, session),
              input.repository.findVenue(venueId, session),
              input.repository.findCanonicalOwner(venueId, session),
              input.repository.findPayoutAccount(
                payoutAccountId,
                venueId,
                session,
              ),
              input.ledgerService.listForSettlementVenue({
                settlementId,
                venueId,
                session,
              }),
            ]);
          if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
          if (settlement.status !== 'COMPLETED') {
            throw conflict(
              'SETTLEMENT_NOT_COMPLETED',
              'Settlement must be COMPLETED before payout',
            );
          }
          if (
            !venue ||
            venue.status !== 'ACTIVE' ||
            venue.environment !== settlement.environment
          ) {
            throw conflict(
              'PAYOUT_VENUE_NOT_ELIGIBLE',
              'Venue must be ACTIVE and match the Settlement environment',
            );
          }
          if (!owner) {
            throw conflict(
              'PAYOUT_CANONICAL_OWNER_MISSING',
              'Venue has no active canonical OWNER membership',
            );
          }
          const kyc = await input.repository.findCurrentBusinessKyc(
            owner.owner_id,
            session,
          );
          const timestamp = now();
          if (
            !kyc ||
            kyc.status !== 'VERIFIED' ||
            (kyc.expires_at !== null && kyc.expires_at <= timestamp)
          ) {
            throw conflict(
              'PAYOUT_KYC_NOT_VERIFIED',
              'Canonical Venue Owner BUSINESS KYC must be current and verified',
            );
          }
          if (!account || account.status !== 'VERIFIED') {
            throw conflict(
              'PAYOUT_ACCOUNT_NOT_VERIFIED',
              'A verified Venue payout account is required',
            );
          }
          if (
            entries.some(
              (entry) =>
                !entry.partner_id.equals(settlement.partner_id) ||
                entry.environment !== settlement.environment ||
                entry.currency !== settlement.currency,
            )
          ) {
            throw conflict(
              'PAYOUT_LEDGER_SCOPE_MISMATCH',
              'Venue Ledger entries must match the Settlement Partner, environment, and currency',
            );
          }
          const eligible = entries.filter(({ payout_id }) => payout_id === null);
          if (eligible.length === 0) {
            throw conflict(
              'NO_PAYABLE_LEDGER_ENTRIES',
              'No unallocated Venue Ledger entries exist for this Settlement',
            );
          }
          const originals = await hydrateReversalOriginals(eligible, session);
          const totals = aggregate(eligible, originals);
          assertAggregate(totals);
          if (totals.net_amount_minor <= 0) {
            throw conflict(
              'PAYOUT_AMOUNT_NOT_POSITIVE',
              'Venue payout amount must be positive',
            );
          }
          const payout: PayoutDocument = {
            _id: new ObjectId(),
            settlement_id: settlementId,
            venue_id: venueId,
            payout_account_id: payoutAccountId,
            environment: settlement.environment,
            amount_minor: totals.net_amount_minor,
            currency: 'INR',
            status: 'PENDING',
            idempotency_key: key,
            bank_reference: null,
            failure_reason: null,
            initiated_at: timestamp,
            paid_at: null,
            audit_history: [{
              event_type: 'PAYOUT_PENDING',
              actor_type: 'ADMIN',
              actor_id: adminId,
              correlation_id: values.correlationId,
              changes: {
                settlement_id: settlementId.toHexString(),
                venue_id: venueId.toHexString(),
                amount_minor: totals.net_amount_minor,
              },
              occurred_at: timestamp,
            }],
            created_at: timestamp,
            updated_at: timestamp,
          };
          await input.repository.insertPayout(payout, session);
          if (
            !(await input.ledgerService.allocateToPayout({
              entryIds: eligible.map(({ _id }) => _id),
              settlementId,
              venueId,
              payoutId: payout._id,
              session,
            }))
          ) {
            throw conflict(
              'PAYOUT_LEDGER_ALLOCATION_CONFLICT',
              'Venue Ledger entries changed during payout initiation',
            );
          }
          await enqueueFinancialEvent(
            payout._id,
            settlement.partner_id,
            venueId,
            payout.environment,
            'PAYOUT_PENDING',
            1,
            values.correlationId,
            {
              payout_id: payout._id.toHexString(),
              settlement_id: settlementId.toHexString(),
              venue_id: venueId.toHexString(),
              amount_minor: payout.amount_minor,
              currency: payout.currency,
              status: payout.status,
            },
            timestamp,
            session,
          );
          result = payout;
        });
      } catch (error) {
        if (duplicate(error)) {
          throw conflict(
            'PAYOUT_DUPLICATE',
            'Payout idempotency, allocation, or provider reference conflicts',
          );
        }
        throw error;
      }
      if (!result) throw new Error('Payout transaction returned no result');
      return payoutView(result);
    },

    async recordPayoutResult(values) {
      const bankReference =
        values.status === 'PAID'
          ? required(values.bankReference ?? '', 'bankReference')
          : null;
      const failureReason =
        values.status === 'FAILED'
          ? required(values.failureReason ?? '', 'failureReason')
          : null;
      if (
        (values.status === 'PAID' && values.failureReason?.trim()) ||
        (values.status === 'FAILED' && values.bankReference?.trim())
      ) {
        throw invalid(
          'INVALID_PAYOUT_RESULT',
          'PAID accepts only bankReference and FAILED accepts only failureReason',
        );
      }
      let payout: PayoutDocument | undefined;
      try {
        await input.database.withTransaction(async ({ session }) => {
          const timestamp = now();
          payout =
            (await input.repository.recordPayoutResult({
              id: oid(values.payoutId),
              status: values.status,
              bankReference,
              failureReason,
              adminId: oid(values.adminId),
              correlationId: values.correlationId,
              now: timestamp,
              session,
            })) ?? undefined;
          if (!payout) {
            throw conflict(
              'PAYOUT_NOT_PENDING',
              'Only a PENDING payout can receive a manual result',
            );
          }
          const settlement = await input.repository.findSettlement(
            payout.settlement_id,
            session,
          );
          if (!settlement) {
            throw conflict(
              'PAYOUT_SETTLEMENT_MISSING',
              'Payout references a missing Settlement',
            );
          }
          await enqueueFinancialEvent(
            payout._id,
            settlement.partner_id,
            payout.venue_id,
            payout.environment,
            `PAYOUT_${payout.status}`,
            2,
            values.correlationId,
            {
              payout_id: payout._id.toHexString(),
              settlement_id: payout.settlement_id.toHexString(),
              venue_id: payout.venue_id.toHexString(),
              status: payout.status,
              amount_minor: payout.amount_minor,
              currency: payout.currency,
              bank_reference: payout.bank_reference,
              failure_reason: payout.failure_reason,
            },
            timestamp,
            session,
          );
        });
      } catch (error) {
        if (duplicate(error)) {
          throw conflict(
            'PAYOUT_BANK_REFERENCE_DUPLICATE',
            'This bank reference is already used in the environment',
          );
        }
        throw error;
      }
      if (!payout) throw new Error('Payout result transaction returned no result');
      return payoutView(payout);
    },

    async listOwnerSettlements(values) {
      await requireFinance(values);
      const pagination = page(values.page, values.limit);
      const venueId = oid(values.venueId);
      const from = values.from ? instant(values.from, 'from') : undefined;
      const to = values.to ? instant(values.to, 'to') : undefined;
      validateRange(from, to);
      const ids = await input.ledgerService.listSettlementIdsForVenue({
        venueId,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
      const result = await input.repository.listSettlements({
        ids,
        ...(values.status ? { status: values.status } : {}),
        ...pagination,
      });
      const items = await Promise.all(
        result.items.map((settlement) =>
          ownerSettlementView(settlement, venueId, false),
        ),
      );
      return pageView(items, result.total, pagination);
    },

    async getOwnerSettlement(values) {
      await requireFinance(values);
      const settlement = await input.repository.findSettlement(
        oid(values.settlementId),
      );
      if (!settlement) throw notFound('SETTLEMENT_NOT_FOUND');
      return ownerSettlementView(settlement, oid(values.venueId), true);
    },

    async listOwnerPayouts(values) {
      await requireFinance(values);
      const pagination = page(values.page, values.limit);
      const from = values.from ? instant(values.from, 'from') : undefined;
      const to = values.to ? instant(values.to, 'to') : undefined;
      validateRange(from, to);
      const result = await input.repository.listPayouts({
        venueId: oid(values.venueId),
        ...(values.status ? { status: values.status } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...pagination,
      });
      const items = await Promise.all(
        result.items.map((payout) => ownerPayoutView(payout, false)),
      );
      return pageView(items, result.total, pagination);
    },

    async getOwnerPayout(values) {
      await requireFinance(values);
      const payout = await input.repository.findPayout(
        oid(values.payoutId),
        oid(values.venueId),
      );
      if (!payout) throw notFound('PAYOUT_NOT_FOUND');
      return ownerPayoutView(payout, true);
    },

    async recordAdjustment(values) {
      const settlementId = oid(values.settlementId);
      const bookingId = oid(values.bookingId);
      const timestamp = values.effectiveAt
        ? instant(values.effectiveAt, 'effectiveAt')
        : now();
      let entries: LedgerEntryDocument[] = [];
      await input.database.withTransaction(async ({ session }) => {
        const settlement = await input.repository.findSettlement(
          settlementId,
          session,
        );
        if (!settlement || settlement.status !== 'COMPLETED') {
          throw conflict(
            'SETTLEMENT_NOT_COMPLETED',
            'Adjustments require a completed Settlement',
          );
        }
        if (
          !settlement.completed_at ||
          timestamp < settlement.completed_at ||
          timestamp > now()
        ) {
          throw invalid(
            'INVALID_ADJUSTMENT_EFFECTIVE_AT',
            'Adjustment time must be between Settlement completion and now',
          );
        }
        const booking = await input.database.db.collection<BookingDocument>(
          'bookings',
        ).findOne(
          {
            _id: bookingId,
            partner_id: settlement.partner_id,
            environment: settlement.environment,
          },
          { session },
        );
        if (!booking) throw notFound('BOOKING_NOT_FOUND');
        const allocated = await input.database.db.collection<LedgerEntryDocument>(
          'ledger_entries',
        ).findOne(
          {
            booking_id: bookingId,
            settlement_id: settlementId,
            partner_id: settlement.partner_id,
            environment: settlement.environment,
          },
          { session },
        );
        if (!allocated) {
          throw conflict(
            'BOOKING_NOT_IN_SETTLEMENT',
            'Booking is not allocated to the requested Settlement',
          );
        }
        entries = await input.ledgerService.postAdjustment({
          booking: {
            bookingId: booking._id,
            partnerId: booking.partner_id ?? null,
            venueId: booking.venue_id,
            contractId: booking.contract_id ?? null,
            environment: booking.environment,
          },
          lines: values.lines,
          reason: values.reason,
          evidenceUri: values.evidenceUri,
          actorId: oid(values.adminId),
          effectiveAt: timestamp,
          correlationId: values.correlationId,
          session,
        });
      });
      return {
        settlementId: values.settlementId,
        bookingId: values.bookingId,
        entryIds: entries.map(({ _id }) => _id.toHexString()),
        effectiveAt: timestamp.toISOString(),
      };
    },

    async createInvoice(values) {
      const settlementId = oid(values.settlementId);
      let invoice: InvoiceDocument | undefined;
      try {
        await input.database.withTransaction(async ({ session }) => {
          const collection = input.database.db.collection<InvoiceDocument>(
            'invoices',
          );
          const existing = await collection.findOne(
            { settlement_id: settlementId, type: 'TAX_INVOICE' },
            { session },
          );
          if (existing) {
            invoice = existing;
            return;
          }
          const settlement = await input.repository.findSettlement(
            settlementId,
            session,
          );
          if (!settlement || settlement.status !== 'COMPLETED') {
            throw conflict(
              'SETTLEMENT_NOT_COMPLETED',
              'Invoices require a completed Settlement',
            );
          }
          const createdAt = now();
          const id = new ObjectId();
          invoice = {
            _id: id,
            settlement_id: settlement._id,
            environment: settlement.environment,
            invoice_number: invoiceNumber(
              id,
              settlement.environment,
              createdAt,
            ),
            type: 'TAX_INVOICE',
            subtotal_minor: settlement.commission_amount_minor,
            tax_amount_minor: settlement.tax_amount_minor,
            total_minor:
              settlement.commission_amount_minor + settlement.tax_amount_minor,
            currency: 'INR',
            status: 'DRAFT',
            document_uri: null,
            issued_at: null,
            created_at: createdAt,
          };
          await collection.insertOne(invoice, { session });
        });
      } catch (error) {
        if (!duplicate(error)) throw error;
        invoice = await input.database.db.collection<InvoiceDocument>('invoices')
          .findOne({ settlement_id: settlementId, type: 'TAX_INVOICE' }) ??
          undefined;
      }
      if (!invoice) throw new Error('Invoice transaction returned no result');
      return invoiceView(invoice);
    },

    async listInvoices(values) {
      const pagination = page(values.page, values.limit);
      const filter = {
        ...(values.settlementId
          ? { settlement_id: oid(values.settlementId) }
          : {}),
        ...(values.environment ? { environment: values.environment } : {}),
        ...(values.status ? { status: values.status } : {}),
      };
      const collection = input.database.db.collection<InvoiceDocument>(
        'invoices',
      );
      const [items, total] = await Promise.all([
        collection.find(filter).sort({ created_at: -1, _id: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit).toArray(),
        collection.countDocuments(filter),
      ]);
      return pageView(items.map(invoiceView), total, pagination);
    },

    async getInvoice(invoiceId) {
      const invoice = await input.database.db.collection<InvoiceDocument>(
        'invoices',
      ).findOne({ _id: oid(invoiceId) });
      if (!invoice) throw notFound('INVOICE_NOT_FOUND');
      return invoiceView(invoice);
    },

    async issueInvoice(values) {
      return transitionInvoice(
        input.database,
        oid(values.invoiceId),
        ['DRAFT'],
        'ISSUED',
        now(),
      );
    },

    async voidInvoice(values) {
      return transitionInvoice(
        input.database,
        oid(values.invoiceId),
        ['DRAFT', 'ISSUED'],
        'VOID',
        now(),
      );
    },
  };

  async function hydrateReversalOriginals(
    entries: LedgerEntryDocument[],
    session?: ClientSession,
  ): Promise<LedgerEntryDocument[]> {
    const present = new Set(entries.map(({ _id }) => _id.toHexString()));
    const ids = uniqueIds(
      entries
        .map(({ reverses_entry_id }) => reverses_entry_id)
        .filter(
          (id): id is ObjectId =>
            id !== null && !present.has(id.toHexString()),
        ),
    );
    const originals = await input.ledgerService.findByIds(ids, session);
    const byId = new Map(
      originals.map((entry) => [entry._id.toHexString(), entry]),
    );
    for (const reversal of entries.filter(
      (entry) =>
        entry.reverses_entry_id !== null &&
        !present.has(entry.reverses_entry_id.toHexString()),
    )) {
      const original = byId.get(reversal.reverses_entry_id!.toHexString());
      if (
        !original ||
        !original.booking_id.equals(reversal.booking_id) ||
        !original.partner_id.equals(reversal.partner_id) ||
        !original.venue_id.equals(reversal.venue_id) ||
        original.environment !== reversal.environment
      ) {
        throw conflict(
          'LEDGER_REVERSAL_REFERENCE_INVALID',
          'A reversal must reference an original Ledger entry in the same booking and financial scope',
        );
      }
    }
    return originals;
  }

  async function transition(values: MutationInput & {
    from: SettlementStatus;
    to: SettlementStatus;
    errorCode: string;
  }): Promise<Record<string, unknown>> {
    const timestamp = now();
    let settlement: SettlementDocument | undefined;
    await input.database.withTransaction(async ({ session }) => {
      settlement =
        (await input.repository.transitionSettlement({
          id: oid(values.settlementId),
          from: values.from,
          to: values.to,
          adminId: oid(values.adminId),
          correlationId: values.correlationId,
          now: timestamp,
          session,
        })) ?? undefined;
      if (!settlement) {
        throw conflict(
          values.errorCode,
          `Settlement must be ${values.from} before this transition`,
        );
      }
    });
    if (!settlement) throw new Error('State transition returned no result');
    return settlementView(settlement);
  }

  async function requireFinance(values: OwnerScope): Promise<void> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'VIEW_FINANCE',
    );
  }

  async function ownerSettlementView(
    settlement: SettlementDocument,
    venueId: ObjectId,
    includeAllocations: boolean,
  ): Promise<Record<string, unknown>> {
    const entries = await input.ledgerService.listForSettlementVenue({
      settlementId: settlement._id,
      venueId,
    });
    if (entries.length === 0) throw notFound('SETTLEMENT_NOT_FOUND');
    const originals = await hydrateReversalOriginals(entries);
    const totals = aggregate(entries, originals);
    return {
      ...settlementView(settlement),
      venueId: venueId.toHexString(),
      venueTotals: amountView(totals),
      ...(includeAllocations
        ? { bookingAllocations: await bookingAllocations(entries) }
        : {}),
    };
  }

  async function ownerPayoutView(
    payout: PayoutDocument,
    includeAllocations: boolean,
  ): Promise<Record<string, unknown>> {
    const [settlement, account, allEntries] = await Promise.all([
      input.repository.findSettlement(payout.settlement_id),
      input.repository.findPayoutAccount(
        payout.payout_account_id,
        payout.venue_id,
      ),
      input.ledgerService.listForSettlementVenue({
        settlementId: payout.settlement_id,
        venueId: payout.venue_id,
      }),
    ]);
    if (!settlement || !account) {
      throw conflict(
        'PAYOUT_REFERENCE_INTEGRITY_ERROR',
        'Payout references missing financial data',
      );
    }
    const entries = allEntries.filter(
      ({ payout_id }) => payout_id?.equals(payout._id) ?? false,
    );
    return {
      ...payoutView(payout),
      settlement: settlementView(settlement),
      payoutAccount: {
        id: account._id.toHexString(),
        accountHolderName: account.account_holder_name,
        accountLast4: account.account_last4,
        bankName: account.bank_name,
      },
      ...(includeAllocations
        ? { bookingAllocations: await bookingAllocations(entries) }
        : {}),
    };
  }

  async function bookingAllocations(
    entries: LedgerEntryDocument[],
  ): Promise<Record<string, unknown>[]> {
    const bookingIds = uniqueIds(entries.map(({ booking_id }) => booking_id));
    const bookings = new Map(
      (await input.repository.findBookings(bookingIds)).map((booking) => [
        booking._id.toHexString(),
        booking,
      ]),
    );
    return bookingIds.map((bookingId) => {
      const booking = bookings.get(bookingId.toHexString());
      const values = entries.filter(({ booking_id }) =>
        booking_id.equals(bookingId),
      );
      return {
        bookingId: bookingId.toHexString(),
        externalBookingReference:
          booking?.external_booking_reference ?? null,
        startsAt: booking?.starts_at.toISOString() ?? null,
        status: booking?.status ?? null,
        entries: values.map((entry) => ({
          ledgerEntryId: entry._id.toHexString(),
          entryType: entry.entry_type,
          direction: entry.direction,
          amountMinor: entry.amount_minor,
          effectiveAt: entry.effective_at.toISOString(),
        })),
      };
    });
  }

  async function enqueueFinancialEvent(
    aggregateId: ObjectId,
    partnerId: ObjectId,
    venueId: ObjectId | null,
    environment: FinancialEnvironment,
    eventType: string,
    eventVersion: number,
    correlationId: string,
    payload: Record<string, unknown>,
    timestamp: Date,
    session: ClientSession,
  ): Promise<void> {
    await input.outboxRepository.enqueue({
      aggregateType: eventType.startsWith('PAYOUT')
        ? 'PAYOUT'
        : 'SETTLEMENT',
      aggregateId,
      partnerId,
      venueId,
      environment,
      eventType,
      eventVersion,
      correlationId,
      payload,
      now: timestamp,
      session,
    });
  }
}

interface Totals {
  gross_amount_minor: number;
  commission_amount_minor: number;
  tax_amount_minor: number;
  refund_amount_minor: number;
  net_amount_minor: number;
}

function aggregate(
  entries: LedgerEntryDocument[],
  hydratedOriginals: LedgerEntryDocument[] = [],
): Totals {
  const originals = new Map(
    [...entries, ...hydratedOriginals]
      .filter(({ reverses_entry_id }) => reverses_entry_id === null)
      .map((entry) => [entry._id.toHexString(), entry]),
  );
  let gross = 0;
  let commission = 0;
  let tax = 0;
  let refund = 0;
  let net = 0;
  for (const entry of entries) {
    const component = componentOf(entry, originals);
    const sign = entry.direction === 'CREDIT' ? 1 : -1;
    if (entry.entry_type === 'REFUND') {
      refund += entry.amount_minor;
      continue;
    }
    if (entry.entry_type === 'REVERSAL') {
      if (component === 'GROSS') refund += entry.amount_minor;
      if (component === 'COMMISSION') commission += sign * entry.amount_minor;
      if (component === 'TAX') tax += sign * entry.amount_minor;
      if (component === 'VENUE_NET') net += sign * entry.amount_minor;
      continue;
    }
    if (entry.entry_type === 'ADJUSTMENT') {
      if (component === 'GROSS') gross += -sign * entry.amount_minor;
      if (component === 'COMMISSION') commission += sign * entry.amount_minor;
      if (component === 'TAX') tax += sign * entry.amount_minor;
      if (component === 'VENUE_NET') net += sign * entry.amount_minor;
      continue;
    }
    if (component === 'GROSS') gross += entry.amount_minor;
    if (component === 'COMMISSION') commission += entry.amount_minor;
    if (component === 'TAX') tax += entry.amount_minor;
    if (component === 'VENUE_NET') net += entry.amount_minor;
  }
  return {
    gross_amount_minor: gross,
    commission_amount_minor: commission,
    tax_amount_minor: tax,
    refund_amount_minor: refund,
    net_amount_minor: net,
  };
}

function componentOf(
  entry: LedgerEntryDocument,
  originals: Map<string, LedgerEntryDocument>,
): string | undefined {
  const own =
    typeof entry.metadata?.component === 'string'
      ? entry.metadata.component
      : typeof entry.metadata?.original_component === 'string'
        ? entry.metadata.original_component
        : undefined;
  if (own) return own;
  const original = entry.reverses_entry_id
    ? originals.get(entry.reverses_entry_id.toHexString())
    : undefined;
  return original && typeof original.metadata?.component === 'string'
    ? original.metadata.component
    : undefined;
}

function assertAggregate(totals: Totals): void {
  for (const value of Object.values(totals)) {
    if (!Number.isSafeInteger(value)) {
      throw conflict(
        'SETTLEMENT_AMOUNT_OVERFLOW',
        'Settlement totals exceed safe integer precision',
      );
    }
  }
  if (
    totals.gross_amount_minor -
      totals.refund_amount_minor -
      totals.commission_amount_minor -
      totals.tax_amount_minor !==
    totals.net_amount_minor
  ) {
    throw conflict(
      'LEDGER_AGGREGATE_IMBALANCE',
      'Ledger components do not produce the expected net amount',
    );
  }
}

function settlementView(value: SettlementDocument): Record<string, unknown> {
  return {
    settlementId: value._id.toHexString(),
    partnerId: value.partner_id.toHexString(),
    environment: value.environment,
    periodStart: value.period_start.toISOString(),
    periodEnd: value.period_end.toISOString(),
    cycle: value.cycle,
    dueAt: value.due_at.toISOString(),
    status: value.status,
    ...amountView(value),
    currency: value.currency,
    completedAt: value.completed_at?.toISOString() ?? null,
    createdAt: value.created_at.toISOString(),
  };
}

function amountView(value: Totals): Record<string, number> {
  return {
    grossAmountMinor: value.gross_amount_minor,
    commissionAmountMinor: value.commission_amount_minor,
    taxAmountMinor: value.tax_amount_minor,
    refundAmountMinor: value.refund_amount_minor,
    netAmountMinor: value.net_amount_minor,
  };
}

function payoutView(value: PayoutDocument): Record<string, unknown> {
  return {
    payoutId: value._id.toHexString(),
    settlementId: value.settlement_id.toHexString(),
    venueId: value.venue_id.toHexString(),
    payoutAccountId: value.payout_account_id.toHexString(),
    environment: value.environment,
    amountMinor: value.amount_minor,
    currency: value.currency,
    status: value.status,
    bankReference: value.bank_reference,
    failureReason: value.failure_reason,
    initiatedAt: value.initiated_at?.toISOString() ?? null,
    paidAt: value.paid_at?.toISOString() ?? null,
    createdAt: value.created_at.toISOString(),
    updatedAt: value.updated_at.toISOString(),
  };
}

function invoiceView(value: InvoiceDocument): Record<string, unknown> {
  return {
    invoiceId: value._id.toHexString(),
    settlementId: value.settlement_id.toHexString(),
    environment: value.environment,
    invoiceNumber: value.invoice_number,
    type: value.type,
    subtotalMinor: value.subtotal_minor,
    taxAmountMinor: value.tax_amount_minor,
    totalMinor: value.total_minor,
    currency: value.currency,
    status: value.status,
    documentUri: value.document_uri,
    issuedAt: value.issued_at?.toISOString() ?? null,
    createdAt: value.created_at.toISOString(),
  };
}

function invoiceNumber(
  id: ObjectId,
  environment: FinancialEnvironment,
  createdAt: Date,
): string {
  const date = createdAt.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = id.toHexString().slice(-12).toUpperCase();
  return `GDS-${environment === 'SANDBOX' ? 'SBX' : 'PRD'}-${date}-${suffix}`;
}

async function transitionInvoice(
  database: DatabaseConnection,
  id: ObjectId,
  from: InvoiceDocument['status'][],
  to: 'ISSUED' | 'VOID',
  now: Date,
): Promise<Record<string, unknown>> {
  const value = await database.db.collection<InvoiceDocument>('invoices')
    .findOneAndUpdate(
      { _id: id, status: { $in: from } },
      {
        $set: {
          status: to,
          ...(to === 'ISSUED' ? { issued_at: now } : {}),
        },
      },
      { returnDocument: 'after' },
    );
  if (!value) throw stateConflict();
  return invoiceView(value);
}

function reconciliationView(
  settlement: SettlementDocument,
  reconciliation: ReconciliationDocument,
): Record<string, unknown> {
  return {
    ...settlementView(settlement),
    reconciliation: reconciliationOnlyView(reconciliation),
  };
}

function reconciliationOnlyView(
  value: ReconciliationDocument,
): Record<string, unknown> {
  return {
    reconciliationId: value._id.toHexString(),
    status: value.status,
    reportedAmountMinor: value.reported_amount_minor,
    bankReference: value.bank_reference,
    evidenceUri: value.evidence_uri,
    notes: value.notes,
    reconciledBy: value.reconciled_by?.toHexString() ?? null,
    reconciledAt: value.reconciled_at?.toISOString() ?? null,
    attemptHistory: value.attempt_history.map((attempt) => ({
      action: attempt.action,
      reportedAmountMinor: attempt.reported_amount_minor,
      expectedAmountMinor: attempt.expected_amount_minor,
      bankReference: attempt.bank_reference,
      evidenceUri: attempt.evidence_uri,
      notes: attempt.notes,
      actorId: attempt.actor_id.toHexString(),
      occurredAt: attempt.occurred_at.toISOString(),
    })),
  };
}

function page(value?: number, limitValue?: number): {
  page: number;
  limit: number;
} {
  const current = value ?? 1;
  const limit = limitValue ?? 20;
  if (
    !Number.isInteger(current) ||
    current < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw invalid(
      'INVALID_PAGINATION',
      'page must be positive and limit must be from 1 to 100',
    );
  }
  return { page: current, limit };
}

function pageView(
  items: Record<string, unknown>[],
  total: number,
  values: { page: number; limit: number },
): PageView {
  return {
    items,
    pagination: {
      ...values,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / values.limit),
    },
  };
}

function validateRange(from?: Date, to?: Date): void {
  if (from && to && from >= to) {
    throw invalid('INVALID_DATE_RANGE', 'from must be before to');
  }
}

function uniqueIds(ids: ObjectId[]): ObjectId[] {
  return [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw invalid('INVALID_ID', 'A supplied identifier is invalid');
  }
  return new ObjectId(value);
}

function instant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid('INVALID_DATE', `${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function optional(value?: string): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw invalid('INVALID_INPUT', `${field} is required`);
  return normalized;
}

function duplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function invalid(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}

function conflict(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 409 });
}

function notFound(code: string): AppError {
  return new AppError({
    code,
    message: code.startsWith('PAYOUT')
      ? 'Payout was not found'
      : code.startsWith('INVOICE')
        ? 'Invoice was not found'
        : code.startsWith('BOOKING')
          ? 'Booking was not found'
          : 'Settlement was not found',
    statusCode: 404,
  });
}

function stateConflict(): AppError {
  return conflict(
    'FINANCIAL_CLOSE_STATE_CONFLICT',
    'Financial Close state changed or does not allow this operation',
  );
}
