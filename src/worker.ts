/**
 * Background worker process.
 *
 * Runs every recurring job the platform needs: outbox delivery, expired-hold
 * recovery and provider payout reconciliation. These used to run on a
 * `setInterval` inside the API, which meant every replica ran them
 * concurrently. Start exactly one of these alongside the API (`npm run
 * worker:start`); the jobs themselves still lease their work, so an overlapping
 * deploy is safe.
 */
import { hostname } from 'node:os';

import { loadConfig } from './config/env.js';
import { initializePersistence } from './composition/persistence.js';
import { createBookingLifecycleRepository } from './modules/booking/booking-lifecycle.repository.js';
import { createBookingLifecycleService } from './modules/booking/booking-lifecycle.service.js';
import { createFinancialCloseRepository } from './modules/financial-close/financial-close.repository.js';
import { createFinancialCloseService } from './modules/financial-close/financial-close.service.js';
import { createLedgerRepository } from './modules/ledger/ledger.repository.js';
import { createLedgerService } from './modules/ledger/ledger.service.js';
import { createOwnerAccessRepository } from './modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from './modules/identity/owner/owner-access.service.js';
import { createIdentityRepository } from './modules/identity/owner/owner-auth.repository.js';
import { createIdentityService } from './modules/identity/owner/owner-auth.service.js';
import { createRazorpayProvider } from './modules/treasury/razorpay.provider.js';
import { createTreasuryService } from './modules/treasury/treasury.service.js';
import { createVenueRepository } from './modules/venue/profile/venue.repository.js';
import { createVenueService } from './modules/venue/profile/venue.service.js';
import { createCommunicationsRepository } from './shared/communications/communications.repository.js';
import { createCommunicationsService } from './shared/communications/communications.service.js';
import { createOutboxRepository } from './shared/communications/outbox.repository.js';
import { createFirebasePushDelivery } from './shared/communications/push-delivery.js';
import { createSecureWebhookTransport } from './shared/communications/webhook-transport.js';
import { MongoDatabaseConnection } from './shared/database/database-connection.js';
import {
  createJobRunner,
  type JobDefinition,
} from './shared/scheduler/job-runner.js';
import { createJobHeartbeatSink } from './shared/scheduler/scheduler.persistence.js';
import {
  HOLD_RECOVERY_INTERVAL_MS,
  PAYOUT_RECONCILIATION_INTERVAL_MS,
} from './shared/scheduler/job-names.js';

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  values: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...values,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

const config = loadConfig();
const database = new MongoDatabaseConnection(config.mongodb);
const workerId =
  process.env.WORKER_ID?.trim() ||
  process.env.COMMUNICATIONS_WORKER_ID?.trim() ||
  `${hostname()}:${process.pid}`;

await database.connect();
await initializePersistence(database.db);

const communications = createCommunicationsService({
  repository: createCommunicationsRepository(database),
  webhookTransport: createSecureWebhookTransport(),
  pushDelivery: createFirebasePushDelivery(config.fcm),
  authConfig: config.auth,
  config: config.communications,
});

const ledgerService = createLedgerService(createLedgerRepository(database));
const bookingLifecycle = createBookingLifecycleService({
  repository: createBookingLifecycleRepository(database),
  ledgerService,
  outboxRepository: createOutboxRepository(database),
  database,
});

const venueService = createVenueService({
  repository: createVenueRepository(database),
});
const ownerAccessService = createOwnerAccessService({
  identityService: createIdentityService({
    repository: createIdentityRepository(database),
    venueService,
    database,
    authConfig: config.auth,
  }),
  repository: createOwnerAccessRepository(database),
});
const treasuryService = createTreasuryService({
  database,
  provider: createRazorpayProvider(
    config.razorpay ?? { enabled: false, baseUrl: 'https://api.razorpay.com' },
  ),
  financialClose: createFinancialCloseService({
    repository: createFinancialCloseRepository(database),
    ledgerService,
    outboxRepository: createOutboxRepository(database),
    ownerAccessService,
    database,
  }),
  workerId,
  log,
});

const jobs: JobDefinition[] = [
  {
    name: 'communications-outbox',
    intervalMs: config.communications.pollIntervalMs,
    async run() {
      const processed = await communications.drain(
        workerId,
        config.communications.batchSize,
      );
      return { processed };
    },
  },
  {
    name: 'booking-hold-recovery',
    intervalMs: HOLD_RECOVERY_INTERVAL_MS,
    async run() {
      const result = await bookingLifecycle.recoverExpiredHolds();
      return {
        fixedReleased: result.fixedReleased,
        openReleased: result.openReleased,
        batches: result.batches,
        scanned: result.scanned,
        exhausted: result.exhausted ? 1 : 0,
      };
    },
  },
  {
    name: 'treasury-payout-reconciliation',
    intervalMs: PAYOUT_RECONCILIATION_INTERVAL_MS,
    async run() {
      await treasuryService.reconcilePendingPayouts();
    },
  },
];

const enabled = process.env.WORKER_JOBS?.trim()
  ? new Set(process.env.WORKER_JOBS.split(',').map((value) => value.trim()))
  : null;
const selected = enabled ? jobs.filter((job) => enabled.has(job.name)) : jobs;
if (selected.length === 0) {
  log('error', 'WORKER_JOBS selected no known jobs', {
    requested: process.env.WORKER_JOBS ?? '',
  });
  process.exit(1);
}

const runner = createJobRunner({
  jobs: selected,
  log,
  workerId,
  heartbeat: createJobHeartbeatSink(database.db),
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'Worker shutting down', { signal });
  // Wait for in-flight jobs before closing the connection, or a transaction
  // can be torn down mid-commit.
  await runner.stop();
  await database.close();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

runner.start();
