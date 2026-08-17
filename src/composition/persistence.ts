import type { Db } from 'mongodb';

import { initializeIdentityPersistence } from '../modules/identity/persistence.js';
import { initializeVenuePersistence } from '../modules/venue/profile/venue.persistence.js';
import { initializeContractPersistence } from '../modules/contracts/contract.persistence.js';
import { initializeBookingPersistence } from '../modules/booking/booking.persistence.js';
import { initializeLedgerPersistence } from '../modules/ledger/ledger.persistence.js';
import { initializeFinancialClosePersistence } from '../modules/financial-close/financial-close.persistence.js';
import { initializeOutboxPersistence } from '../shared/communications/outbox.persistence.js';
import { initializeAuditPersistence } from '../shared/audit/audit.persistence.js';
import { initializeTreasuryPersistence } from '../modules/treasury/treasury.persistence.js';
import { initializeSchedulerPersistence } from '../shared/scheduler/scheduler.persistence.js';
import { initializeIpRateLimitPersistence } from '../shared/rate-limit/ip-rate-limit.repository.js';

/**
 * The single ordered list of collection migrations.
 *
 * The API process, the worker process and `npm run db:init` all call this. It
 * exists because the list was previously maintained in two places that had
 * already drifted — and inventory persistence is only reachable transitively
 * through venue persistence, which is easy to miss when copying the list.
 */
export async function initializePersistence(db: Db): Promise<void> {
  await initializeIdentityPersistence(db);
  // Also initializes inventory, payout accounts, content and agreements.
  await initializeVenuePersistence(db);
  await initializeContractPersistence(db);
  await initializeBookingPersistence(db);
  await initializeLedgerPersistence(db);
  await initializeFinancialClosePersistence(db);
  await initializeOutboxPersistence(db);
  await initializeAuditPersistence(db);
  await initializeTreasuryPersistence(db);
  await initializeSchedulerPersistence(db);
  await initializeIpRateLimitPersistence(db);
}
