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
import { createCommunicationsRepository } from './shared/communications/communications.repository.js';
import { createCommunicationsService } from './shared/communications/communications.service.js';
import { createOwnerEventPublisher } from './shared/communications/owner-event-publisher.js';
import type { CommunicationsService } from './shared/communications/communications.service.js';
import {
  createFirebasePushDelivery,
  type PushDelivery,
} from './shared/communications/push-delivery.js';
import {
  createSecureWebhookTransport,
  type WebhookTransport,
} from './shared/communications/webhook-transport.js';
import { initializeFinancialClosePersistence } from './modules/financial-close/financial-close.persistence.js';
import { createFinancialCloseRepository } from './modules/financial-close/financial-close.repository.js';
import { createFinancialCloseService } from './modules/financial-close/financial-close.service.js';
import { initializeLedgerPersistence } from './modules/ledger/ledger.persistence.js';
import { createLedgerRepository } from './modules/ledger/ledger.repository.js';
import { createLedgerService } from './modules/ledger/ledger.service.js';
import { createContractRepository } from './modules/contracts/contract.repository.js';
import { createContractService } from './modules/contracts/contract.service.js';
import { createAdminOnboardingService } from './modules/admin/onboarding/onboarding.service.js';
import { createAdminVenueService } from './modules/venue/admin-venue.service.js';
import {
  createAdminEpic08Service,
  type AdminEpic08Service,
} from './modules/admin/epic08/admin-epic08.service.js';
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
import { createPartnerPayoutAccountService } from './modules/identity/partner/partner-payout-account.service.js';
import { createPartnerPortalService } from './modules/identity/partner/partner-portal.service.js';
import { initializeIdentityPersistence } from './modules/identity/persistence.js';
import { initializeVenuePersistence } from './modules/venue/profile/venue.persistence.js';
import { createCourtOwnerService } from './modules/venue/courts/court-owner.service.js';
import { createCourtRepository } from './modules/venue/courts/court.repository.js';
import { createVenueRepository } from './modules/venue/profile/venue.repository.js';
import { createVenueOwnerService } from './modules/venue/profile/venue-owner.service.js';
import { createVenueService } from './modules/venue/profile/venue.service.js';
import { createInventoryRepository } from './modules/venue/inventory/inventory.repository.js';
import { createInventoryService } from './modules/venue/inventory/inventory.service.js';
import { createPayoutAccountRepository } from './modules/venue/payout-accounts/payout-account.repository.js';
import { createPayoutAccountService } from './modules/venue/payout-accounts/payout-account.service.js';
import { createVenueContentRepository } from './modules/venue/content/venue-content.repository.js';
import { createVenueContentService } from './modules/venue/content/venue-content.service.js';
import { createOwnerDashboardService } from './modules/venue/dashboard/owner-dashboard.service.js';
import { createOnboardingAgreementService } from './modules/venue/onboarding-agreement/onboarding-agreement.service.js';
import cloudinaryPlugin from './plugins/cloudinary.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import mongodbPlugin from './plugins/mongodb.js';
import redisPlugin from './plugins/redis.js';
import apiV1Routes from './routes/api-v1.js';
import healthRoutes from './routes/health.js';
import type { DatabaseConnection } from './shared/database/database-connection.js';
import type { MediaStorage } from './shared/media/cloudinary-media-storage.js';
import { createPartnerRateLimiter } from './shared/rate-limit/partner-rate-limiter.js';
import { initializeAuditPersistence } from './shared/audit/audit.persistence.js';
import { createInventorySyncService } from './modules/inventory-sync/inventory-sync.service.js';
import { initializeTreasuryPersistence } from './modules/treasury/treasury.persistence.js';
import { createRazorpayProvider } from './modules/treasury/razorpay.provider.js';
import { createTreasuryService } from './modules/treasury/treasury.service.js';
import openapiRoutes from './routes/openapi.js';
import observabilityPlugin from './plugins/observability.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  database?: DatabaseConnection;
  mediaStorage?: MediaStorage;
  identityService?: IdentityService;
  pushDelivery?: PushDelivery;
  webhookTransport?: WebhookTransport;
  communicationsService?: CommunicationsService;
  adminEpic08Service?: AdminEpic08Service;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const redisConfig = config.redis ?? {
    connectTimeoutMs: 1_000,
    keyPrefix: 'turf-gds',
  };
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.x-api-key',
                'req.headers.x-signature',
                'req.headers.cookie',
                'request.headers.authorization',
                'request.headers.x-api-key',
                'request.headers.x-signature',
                '*.password',
                '*.passwordHash',
                '*.password_hash',
                '*.signingSecret',
                '*.signing_secret',
                '*.signing_secret_hash',
                '*.vaultAccountToken',
                '*.vault_account_token',
                '*.accountNumber',
                '*.account_number',
                '*.cardNumber',
                '*.card_number',
                '*.pan',
                '*.cvv',
                '*.cvc',
                '*.privateKey',
              ],
              censor: '[REDACTED]',
            },
          },
  });

  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin);
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
  await app.register(redisPlugin, { config: redisConfig });
  await app.register(healthRoutes, {
    cacheTtlMs: config.readinessCacheTtlMs,
  });
  app.addHook('onSend',async(_request,reply,payload)=>{reply.header('x-content-type-options','nosniff').header('x-frame-options','DENY').header('referrer-policy','no-referrer').header('cache-control',reply.getHeader('cache-control')??'no-store');return payload;});

  if (!options.database && config.runMigrationsOnStartup !== false) {
    await initializeIdentityPersistence(app.database.db);
    await initializeVenuePersistence(app.database.db);
    await initializeContractPersistence(app.database.db);
    await initializeBookingPersistence(app.database.db);
    await initializeLedgerPersistence(app.database.db);
    await initializeFinancialClosePersistence(app.database.db);
    await initializeOutboxPersistence(app.database.db);
    await initializeAuditPersistence(app.database.db);
    await initializeTreasuryPersistence(app.database.db);
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
  const ownerEvents = createOwnerEventPublisher(app.database, createOutboxRepository(app.database));
  const venueOwnerService = createVenueOwnerService({
    repository: createVenueRepository(app.database),
    ownerAccessService,
    mediaStorage: app.mediaStorage,
    events: ownerEvents,
  });
  const courtOwnerService = createCourtOwnerService({
    repository: createCourtRepository(app.database),
    venueRepository: createVenueRepository(app.database),
    ownerAccessService,
    mediaStorage: app.mediaStorage,
    events: ownerEvents,
  });
  const inventoryService = createInventoryService({
    repository: createInventoryRepository(app.database),
    venueRepository: createVenueRepository(app.database),
    courtRepository: createCourtRepository(app.database),
    ownerAccessService,
    database: app.database,
    events: ownerEvents,
  });
  const payoutAccountService = createPayoutAccountService({
    repository: createPayoutAccountRepository(app.database),
    ownerAccessService,
    mediaStorage: app.mediaStorage,
  });
  const venueContentService = createVenueContentService({
    repository: createVenueContentRepository(app.database),
    ownerAccessService,
    events: ownerEvents,
  });
  const ownerDashboardService = createOwnerDashboardService({ database: app.database, ownerAccessService });
  const onboardingAgreementService = createOnboardingAgreementService({ database: app.database, ownerAccessService, outboxRepository: createOutboxRepository(app.database) });
  const adminAuthService = createAdminAuthService({
    repository: createAdminAuthRepository(app.database),
    authConfig: config.auth,
  });
  const kycService = createKycService({
    repository: createKycRepository(app.database),
    mediaStorage: app.mediaStorage,
    config: config.kyc,
    database: app.database,
    outboxRepository: createOutboxRepository(app.database),
  });
  const adminOnboardingService = createAdminOnboardingService({
    identityService,
    kycService,
    venueService,
    database: app.database,
    agreementService: onboardingAgreementService,
  });
  const partnerAccessRepository = createPartnerAccessRepository(app.database);
  const partnerAccessService = createPartnerAccessService({
    repository: partnerAccessRepository,
    kycService,
    authConfig: config.auth,
    rateLimiter: createPartnerRateLimiter({
      redis: app.redis,
      fallback: {
        async consumeRateLimitWindow(values) {
          if (!partnerAccessRepository.consumeRateLimitWindow) {
            return { count: 1 };
          }
          return partnerAccessRepository.consumeRateLimitWindow(values);
        },
      },
      keyPrefix: redisConfig.keyPrefix,
    }),
  });
  const ownerBookingService = createOwnerBookingService({
    repository: createOwnerBookingRepository(app.database),
    ownerAccessService,
    database: app.database,
    outboxRepository: createOutboxRepository(app.database),
  });
  const ledgerService = createLedgerService(
    createLedgerRepository(app.database),
  );
  const bookingLifecycleService = createBookingLifecycleService({
    repository: createBookingLifecycleRepository(app.database),
    ledgerService,
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
    venueCancellationPolicy: async (venueId) => {
      const value=await app.database.db.collection<{version:number;status:string;cancellation_policy:{cancellation_allowed:boolean;default_refund_bps:number;owner_cancellation_notice_minutes:number;refund_rules:Array<{min_minutes_before_start:number;refund_bps:number}>}}>('\u0076enue_onboarding_agreements').find({venue_id:venueId,status:'ACCEPTED'}).sort({version:-1}).limit(1).next();
      return value?{cancellationAllowed:value.cancellation_policy.cancellation_allowed,defaultRefundBps:value.cancellation_policy.default_refund_bps,ownerCancellationNoticeMinutes:value.cancellation_policy.owner_cancellation_notice_minutes,refundRules:value.cancellation_policy.refund_rules.map(r=>({minMinutesBeforeStart:r.min_minutes_before_start,refundBps:r.refund_bps})),agreementVersion:value.version}:null;
    },
  });
  const financialCloseService = createFinancialCloseService({
    repository: createFinancialCloseRepository(app.database),
    ledgerService,
    outboxRepository: createOutboxRepository(app.database),
    ownerAccessService,
    database: app.database,
  });
  const treasuryService = createTreasuryService({
    database: app.database,
    provider: createRazorpayProvider(config.razorpay ?? { enabled: false, baseUrl: 'https://api.razorpay.com' }),
    financialClose: financialCloseService,
  });
  const communicationsService =
    options.communicationsService ??
    createCommunicationsService({
      repository: createCommunicationsRepository(app.database),
      webhookTransport:
        options.webhookTransport ?? createSecureWebhookTransport(),
      pushDelivery:
        options.pushDelivery ?? createFirebasePushDelivery(config.fcm),
      authConfig: config.auth,
      config: config.communications,
    });
  const adminEpic08Service =
    options.adminEpic08Service ??
    createAdminEpic08Service({
      database: app.database,
      venues: createAdminVenueService({
        database: app.database,
        identityService,
        venueService,
      }),
      minimumCoverageDays:
        config.adminOperations?.inventoryMinimumCoverageDays ?? 7,
    });

  await app.register(apiV1Routes, {
    prefix: '/api/v1',
    identityService,
    ownerAccessService,
    adminAuthService,
    adminOnboardingService,
    kycService,
    partnerAccessService,
    partnerPayoutAccountService: createPartnerPayoutAccountService(app.database.db, app.mediaStorage),
    partnerPortalService: createPartnerPortalService(app.database.db),
    venueOwnerService,
    courtOwnerService,
    inventoryService,
    venueContentService,
    ownerDashboardService,
    onboardingAgreementService,
    payoutAccountService,
    ownerBookingService,
    bookingLifecycleService,
    contractService,
    financialCloseService,
    communicationsService,
    adminEpic08Service,
    inventorySyncService: createInventorySyncService(app.database, config.auth.partnerCredentialMasterSecret),
    treasuryService,
  });
  await app.register(openapiRoutes,{prefix:'/api/v1'});

  return app;
}
