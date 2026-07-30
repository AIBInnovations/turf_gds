import type { ObjectId } from 'mongodb';

export type FinancialEnvironment = 'SANDBOX' | 'PRODUCTION';
export type SettlementCycle = 'T_PLUS_N' | 'WEEKLY' | 'MONTHLY';
export type SettlementStatus =
  | 'DRAFT'
  | 'PENDING_FUNDS'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REVERSED';
export type ReconciliationStatus =
  | 'PENDING'
  | 'MATCHED'
  | 'MISMATCH'
  | 'RESOLVED';

export interface FinancialAuditDocument {
  event_type: string;
  actor_type: 'ADMIN' | 'SYSTEM';
  actor_id: ObjectId | null;
  correlation_id: string;
  changes: Record<string, unknown>;
  occurred_at: Date;
}

export interface SettlementDocument {
  _id: ObjectId;
  partner_id: ObjectId;
  environment: FinancialEnvironment;
  period_start: Date;
  period_end: Date;
  cycle: SettlementCycle;
  due_at: Date;
  status: SettlementStatus;
  gross_amount_minor: number;
  commission_amount_minor: number;
  tax_amount_minor: number;
  refund_amount_minor: number;
  net_amount_minor: number;
  currency: 'INR';
  audit_history: FinancialAuditDocument[];
  created_at: Date;
  completed_at: Date | null;
}

export interface ReconciliationAttemptDocument {
  action: 'RECORDED' | 'RESOLVED';
  reported_amount_minor: number;
  expected_amount_minor: number;
  bank_reference: string | null;
  evidence_uri: string | null;
  notes: string | null;
  actor_id: ObjectId;
  occurred_at: Date;
}

export interface ReconciliationDocument {
  _id: ObjectId;
  settlement_id: ObjectId;
  environment: FinancialEnvironment;
  reconciled_by: ObjectId | null;
  reported_amount_minor: number;
  bank_reference: string | null;
  evidence_uri: string | null;
  status: ReconciliationStatus;
  reconciled_at: Date | null;
  notes: string | null;
  attempt_history: ReconciliationAttemptDocument[];
  audit_history: FinancialAuditDocument[];
  created_at: Date;
}

export type PayoutStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'REVERSED';

export interface PayoutDocument {
  _id: ObjectId;
  settlement_id: ObjectId;
  venue_id: ObjectId;
  payout_account_id: ObjectId;
  environment: FinancialEnvironment;
  amount_minor: number;
  currency: 'INR';
  status: PayoutStatus;
  idempotency_key: string;
  bank_reference: string | null;
  failure_reason: string | null;
  initiated_at: Date | null;
  paid_at: Date | null;
  audit_history: FinancialAuditDocument[];
  created_at: Date;
  updated_at: Date;
}

export interface InvoiceDocument {
  _id: ObjectId;
  settlement_id: ObjectId;
  environment: FinancialEnvironment;
  invoice_number: string;
  type: 'TAX_INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  subtotal_minor: number;
  tax_amount_minor: number;
  total_minor: number;
  currency: 'INR';
  status: 'DRAFT' | 'ISSUED' | 'VOID';
  document_uri: string | null;
  issued_at: Date | null;
  created_at: Date;
}
