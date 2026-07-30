import { hostname } from 'node:os';

import { loadConfig } from './config/env.js';
import { initializeIdentityPersistence } from './modules/identity/persistence.js';
import { createCommunicationsRepository } from './shared/communications/communications.repository.js';
import { createCommunicationsService } from './shared/communications/communications.service.js';
import { initializeOutboxPersistence } from './shared/communications/outbox.persistence.js';
import { createFirebasePushDelivery } from './shared/communications/push-delivery.js';
import { createSecureWebhookTransport } from './shared/communications/webhook-transport.js';
import { MongoDatabaseConnection } from './shared/database/database-connection.js';

const config = loadConfig();
const database = new MongoDatabaseConnection(config.mongodb);
const workerId =
  process.env.COMMUNICATIONS_WORKER_ID?.trim() ||
  `${hostname()}:${process.pid}`;
let stopping = false;
let timer: NodeJS.Timeout | undefined;

await database.connect();
await initializeIdentityPersistence(database.db);
await initializeOutboxPersistence(database.db);

const service = createCommunicationsService({
  repository: createCommunicationsRepository(database),
  webhookTransport: createSecureWebhookTransport(),
  pushDelivery: createFirebasePushDelivery(config.fcm),
  authConfig: config.auth,
  config: config.communications,
});

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    const processed = await service.drain(
      workerId,
      config.communications.batchSize,
    );
    if (processed > 0) {
      log('info', 'Communications batch processed', { processed });
    }
  } catch (error) {
    log('error', 'Communications worker iteration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!stopping) {
      timer = setTimeout(() => {
        void tick();
      }, config.communications.pollIntervalMs);
    }
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  log('info', 'Communications worker shutting down', { signal });
  await database.close();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

log('info', 'Communications worker started', { workerId });
await tick();

function log(
  level: 'info' | 'error',
  message: string,
  values: Record<string, unknown>,
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
