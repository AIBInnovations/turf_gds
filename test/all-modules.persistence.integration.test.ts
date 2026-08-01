import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';
import { MongoServerError } from 'mongodb';

import { initializeBookingPersistence } from '../src/modules/booking/booking.persistence.js';
import { initializeOutboxPersistence } from '../src/shared/communications/outbox.persistence.js';
import { initializeContractPersistence } from '../src/modules/contracts/contract.persistence.js';
import { initializeFinancialClosePersistence } from '../src/modules/financial-close/financial-close.persistence.js';
import { initializeIdentityPersistence } from '../src/modules/identity/persistence.js';
import { initializeLedgerPersistence } from '../src/modules/ledger/ledger.persistence.js';
import { initializeInventoryPersistence } from '../src/modules/venue/inventory/inventory.persistence.js';
import { initializeVenuePersistence } from '../src/modules/venue/profile/venue.persistence.js';
import { initializeAuditPersistence } from '../src/shared/audit/audit.persistence.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';

const expectedCollections = [
  'admin_users',
  'api_idempotency_records',
  'api_usage_daily',
  'audit_events',
  'booking_cancellations',
  'booking_payments',
  'bookings',
  'courts',
  'invoices',
  'kyc_documents',
  'kyc_verifications',
  'ledger_entries',
  'outbox_events',
  'partner_api_keys',
  'partner_venue_contracts',
  'partners',
  'payouts',
  'pricing_rules',
  'reconciliations',
  'settlements',
  'slots',
  'venue_owner_memberships',
  'venue_onboarding_agreements',
  'venue_owners',
  'venue_contents',
  'venue_payout_accounts',
  'venue_role_permissions',
  'venues',
  'webhook_endpoints',
].sort();

test('all production collections initialize with strict validators, including flexible Venue content', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }

  const databaseName = `turf_gds_all_modules_it_${process.pid}_${Date.now()}`;
  const database = new MongoDatabaseConnection({
    uri,
    database: databaseName,
    serverSelectionTimeoutMs: 2_000,
    maxPoolSize: 2,
  });

  try {
    try {
      await database.connect();
    } catch {
      context.skip('MongoDB integration server is unavailable');
      return;
    }

    await initializeIdentityPersistence(database.db);
    await initializeVenuePersistence(database.db);
    await initializeInventoryPersistence(database.db);
    await initializeContractPersistence(database.db);
    await initializeBookingPersistence(database.db);
    await initializeLedgerPersistence(database.db);
    await initializeFinancialClosePersistence(database.db);
    await initializeOutboxPersistence(database.db);
    await initializeAuditPersistence(database.db);

    const names = (
      await database.db.listCollections({}, { nameOnly: true }).toArray()
    ).map(({ name }) => name).sort();
    assert.deepEqual(names, expectedCollections);
    assert.equal(names.includes('venue_contents'), true);

    for (const collection of [
      'ledger_entries',
      'settlements',
      'reconciliations',
      'payouts',
      'invoices',
      'outbox_events',
      'audit_events',
      'booking_payments',
      'venue_contents',
      'venue_onboarding_agreements',
    ]) {
      await assert.rejects(
        database.db.collection(collection).insertOne({ invalid: true }),
        (error: unknown) =>
          error instanceof MongoServerError && error.code === 121,
        `${collection} must reject documents outside its Eraser schema`,
      );
    }

    const requiredIndexes: Array<[string, string]> = [
      ['ledger_entries', 'ix_ledger_correlation'],
      ['ledger_entries', 'ix_ledger_payout'],
      ['ledger_entries', 'ix_ledger_unsettled_batch'],
      ['settlements', 'uq_settlement_period'],
      ['reconciliations', 'uq_reconciliation_bank_reference'],
      ['payouts', 'uq_payout_idempotency'],
      ['payouts', 'uq_payout_settlement_venue'],
      ['invoices', 'uq_invoice_number'],
      ['invoices', 'uq_invoice_settlement_type'],
      ['outbox_events', 'uq_outbox_event_identity'],
      ['audit_events', 'uq_audit_event_identity'],
      ['booking_payments', 'uq_booking_payment_booking'],
      ['venue_contents', 'uq_venue_content_locale'],
      ['venue_onboarding_agreements', 'uq_onboarding_agreement_version'],
    ];
    for (const [collection, indexName] of requiredIndexes) {
      const indexes = await database.db.collection(collection).indexes();
      assert.ok(
        indexes.some(({ name }) => name === indexName),
        `${collection} must have ${indexName}`,
      );
    }
  } finally {
    if (databaseName.startsWith('turf_gds_all_modules_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
