import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rawBody from 'fastify-raw-body';

import { loadConfig, type AppConfig } from './config/env.js';
import { initializeBookingPersistence } from './modules/booking/booking.persistence.js';
import { createOwnerBookingRepository } from './modules/booking/owner-booking.repository.js';
import { createOwnerBookingService } from './modules/booking/owner-booking.service.js';
import { createBookingLifecycleRepository } from './modules/booking/booking-lifecycle.repository.js';
import { createBookingLifecycleService } from './modules/booking/booking-lifecycle.service.js';
import { initializeContractPersistence } from './modules/contracts/contract.persistence.js';
import { initializeOutboxPersistence } from './shared/communications/outbox.persistence.js';
import { createOutboxRepository } from './shared/communications/outbox.repository.js';
import { initializeFinancialClosePersistence } from './modules/financial-close/financial-close.persistence.js';
import { initializeLedgerPersistence } from './modules/ledger/ledger.persistence.js';
import { createLedgerRepository } from './modules/ledger/ledger.repository.js';
import { createContractRepository } from './modules/contracts/contract.repository.js';
import { createContractService } from './modules/contracts/contract.service.js';
import { createAdminOnboardingService } from './modules/admin/onboarding/onboarding.service.js';
import { createAdminAuthRepository } from './modules/identity/platform/auth.repository.js';
import { createAdminAuthService } from './modules/identity/platform/auth.service.js';
import { createKycRepository } from './modules/identity/kyc/kyc.repository.js';
import { createKycService } from './modules/identity/kyc/kyc.service.js';
import { createIdentityRepository } from './modules/identity/owner/owner-auth.repository.js';
import {
  createIdentityService,
  type IdentityService,
} from './modules/identity/owner/owner-auth.service.js';
import { createOwnerAccessRepository } from './modules/identity/owner/owner-access.repository.js';
import { createOwnerAccessService } from './modules/identity/owner/owner-access.service.js';
import { createPartnerAccessRepository } from './modules/identity/partner/partner-access.repository.js';
import { createPartnerAccessService } from './modules/identity/partner/partner-access.service.js';
import { initializeIdentityPersistence } from './modules/identity/persistence.js';
import { initializeVenuePersistence } from './modules/venue/venue.persistence.js';
import { createCourtOwnerService } from './modules/venue/court-owner.service.js';
import { createCourtRepository } from './modules/venue/court.repository.js';
import { createVenueRepository } from './modules/venue/venue.repository.js';
import { createVenueOwnerService } from './modules/venue/venue-owner.service.js';
import { createVenueService } from './modules/venue/venue.service.js';
import { createVenueOperationsRepository } from './modules/venue/venue-operations.repository.js';
import { createVenueOperationsService } from './modules/venue/venue-operations.service.js';
import cloudinaryPlugin from './plugins/cloudinary.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import mongodbPlugin from './plugins/mongodb.js';
import apiV1Routes from './routes/api-v1.js';
import healthRoutes from './routes/health.js';
import type { DatabaseConnection } from './shared/database/database-connection.js';
import type { MediaStorage } from './shared/media/cloudinary-media-storage.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  database?: DatabaseConnection;
  mediaStorage?: MediaStorage;
  identityService?: IdentityService;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
          },
  });

  await app.register(errorHandlerPlugin);
  await app.register(multipart, {
    limits: {
      fileSize: config.kyc.maxFileBytes,
      files: 1,
      fields: 5,
    },
  });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(cloudinaryPlugin, {
    config: config.cloudinary,
    ...(options.mediaStorage
      ? { storage: options.mediaStorage }
      : {}),
  });
  await app.register(mongodbPlugin, {
    config: config.mongodb,
    ...(options.database ? { connection: options.database } : {}),
  });
  await app.register(healthRoutes, {
    cacheTtlMs: config.readinessCacheTtlMs,
  });

  if (!options.database) {
    await initializeIdentityPersistence(app.database.db);
    await initializeVenuePersistence(app.database.db);
    await initializeContractPersistence(app.database.db);
    await initializeBookingPersistence(app.database.db);
    await initializeLedgerPersistence(app.database.db);
    await initializeFinancialClosePersistence(app.database.db);
    await initializeOutboxPersistence(app.database.db);
  }

  const venueService = createVenueService({
    repository: createVenueRepository(app.database),
  });
  const identityService =
    options.identityService ??
    createIdentityService({
      repository: createIdentityRepository(app.database),
      venueService,
      database: app.database,
      authConfig: config.auth,
    });
  const ownerAccessService = createOwnerAccessService({
    identityService,
    repository: createOwnerAccessRepository(app.database),
  });
  const venueOwnerService = createVenueOwnerService({
    repository: createVenueRepository(app.database),
    ownerAccessService,
    mediaStorage: app.mediaStorage,
  });
  const courtOwnerService = createCourtOwnerService({
    repository: createCourtRepository(app.database),
    venueRepository: createVenueRepository(app.database),
    ownerAccessService,
    mediaStorage: app.mediaStorage,
  });
  const venueOperationsService = createVenueOperationsService({
    repository: createVenueOperationsRepository(app.database),
    venueRepository: createVenueRepository(app.database),
    courtRepository: createCourtRepository(app.database),
    ownerAccessService,
    database: app.database,
  });
  const adminAuthService = createAdminAuthService({
    repository: createAdminAuthRepository(app.database),
    authConfig: config.auth,
  });
  const kycService = createKycService({
    repository: createKycRepository(app.database),
    mediaStorage: app.mediaStorage,
    config: config.kyc,
  });
  const adminOnboardingService = createAdminOnboardingService({
    identityService,
    kycService,
    venueService,
    database: app.database,
  });
  const partnerAccessService = createPartnerAccessService({
    repository: createPartnerAccessRepository(app.database),
    kycService,
    authConfig: config.auth,
  });
  const ownerBookingService = createOwnerBookingService({
    repository: createOwnerBookingRepository(app.database),
    ownerAccessService,
  });
  const bookingLifecycleService = createBookingLifecycleService({
    repository: createBookingLifecycleRepository(app.database),
    ledgerRepository: createLedgerRepository(app.database),
    outboxRepository: createOutboxRepository(app.database),
    database: app.database,
  });
  const holdRecoveryTimer = setInterval(() => {
    void bookingLifecycleService.recoverExpiredHolds().catch((error: unknown) => {
      app.log.error({ err: error }, 'Failed to recover expired Booking holds');
    });
  }, 60_000);
  holdRecoveryTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(holdRecoveryTimer);
  });
  const contractService = createContractService({
    repository: createContractRepository(app.database),
    database: app.database,
  });

  await app.register(apiV1Routes, {
    prefix: '/api/v1',
    identityService,
    ownerAccessService,
    adminAuthService,
    adminOnboardingService,
    kycService,
    partnerAccessService,
    venueOwnerService,
    courtOwnerService,
    venueOperationsService,
    ownerBookingService,
    bookingLifecycleService,
    contractService,
  });

  return app;
}
