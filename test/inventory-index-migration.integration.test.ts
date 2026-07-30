import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'dotenv/config';

import { initializeInventoryPersistence } from '../src/modules/venue/inventory/inventory.persistence.js';
import { MongoDatabaseConnection } from '../src/shared/database/database-connection.js';

test('Inventory startup replaces a legacy named Pricing index without dropping data', async (context) => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    context.skip('MONGODB_URI is not configured');
    return;
  }
  const databaseName = `turf_gds_inventory_migration_it_${process.pid}_${Date.now()}`;
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
    await database.db.createCollection('pricing_rules');
    await database.db.collection('pricing_rules').insertOne({
      marker: 'must-survive-index-migration',
    });
    await database.db.collection('pricing_rules').createIndex(
      { court_id: 1, status: 1, priority: -1 },
      { name: 'ix_pricing_court_status_priority' },
    );

    await initializeInventoryPersistence(database.db);

    const migrated = (
      await database.db.collection('pricing_rules').indexes()
    ).find(({ name }) => name === 'ix_pricing_court_status_priority');
    assert.deepEqual(migrated?.key, {
      court_id: 1,
      active: 1,
      priority: -1,
    });
    assert.equal(
      await database.db.collection('pricing_rules').countDocuments({
        marker: 'must-survive-index-migration',
      }),
      1,
    );
  } finally {
    if (databaseName.startsWith('turf_gds_inventory_migration_it_')) {
      await database.db.dropDatabase().catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
});
