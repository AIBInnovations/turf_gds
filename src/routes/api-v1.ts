import type { FastifyPluginAsync } from 'fastify';

import ownerBookingRoutes from '../modules/booking/owner-booking.routes.js';
import type { OwnerBookingService } from '../modules/booking/owner-booking.service.js';
import bookingLifecycleRoutes from '../modules/booking/booking-lifecycle.routes.js';
import type { BookingLifecycleService } from '../modules/booking/booking-lifecycle.service.js';
import contractRoutes from '../modules/contracts/contract.routes.js';
import type { ContractService } from '../modules/contracts/contract.service.js';
import financialCloseRoutes from '../modules/financial-close/financial-close.routes.js';
import ownerFinanceRoutes from '../modules/financial-close/owner-finance.routes.js';
import type { FinancialCloseService } from '../modules/financial-close/financial-close.service.js';
import adminOnboardingRoutes from '../modules/admin/onboarding/onboarding.routes.js';
import type { AdminOnboardingService } from '../modules/admin/onboarding/onboarding.service.js';
import kycRoutes from '../modules/identity/kyc/kyc.routes.js';
import type { KycService } from '../modules/identity/kyc/kyc.service.js';
import identityRoutes from '../modules/identity/owner/owner-auth.routes.js';
import type { IdentityService } from '../modules/identity/owner/owner-auth.service.js';
import ownerAccessRoutes from '../modules/identity/owner/owner-access.routes.js';
import type { OwnerAccessService } from '../modules/identity/owner/owner-access.service.js';
import partnerAccessRoutes from '../modules/identity/partner/partner-access.routes.js';
import type { PartnerAccessService } from '../modules/identity/partner/partner-access.service.js';
import partnerPortalRoutes from '../modules/identity/partner/partner-portal.routes.js';
import type { PartnerPortalService } from '../modules/identity/partner/partner-portal.service.js';
import partnerPayoutAccountRoutes from '../modules/identity/partner/partner-payout-account.routes.js';
import type { PartnerPayoutAccountService } from '../modules/identity/partner/partner-payout-account.service.js';
import adminAuthRoutes from '../modules/identity/platform/auth.routes.js';
import type { AdminAuthService } from '../modules/identity/platform/auth.service.js';
import courtOwnerRoutes from '../modules/venue/courts/court-owner.routes.js';
import type { CourtOwnerService } from '../modules/venue/courts/court-owner.service.js';
import venueOwnerRoutes from '../modules/venue/profile/venue-owner.routes.js';
import type { VenueOwnerService } from '../modules/venue/profile/venue-owner.service.js';
import inventoryRoutes from '../modules/venue/inventory/inventory.routes.js';
import payoutAccountAdminRoutes from '../modules/venue/payout-accounts/payout-account-admin.routes.js';
import payoutAccountOwnerRoutes from '../modules/venue/payout-accounts/payout-account-owner.routes.js';
import type { PayoutAccountService } from '../modules/venue/payout-accounts/payout-account.service.js';
import type { InventoryService } from '../modules/venue/inventory/inventory.service.js';
import venueContentRoutes from '../modules/venue/content/venue-content.routes.js';
import type { VenueContentService } from '../modules/venue/content/venue-content.service.js';
import ownerDashboardRoutes from '../modules/venue/dashboard/owner-dashboard.routes.js';
import type { OwnerDashboardService } from '../modules/venue/dashboard/owner-dashboard.service.js';
import onboardingAgreementRoutes from '../modules/venue/onboarding-agreement/onboarding-agreement.routes.js';
import type { OnboardingAgreementService } from '../modules/venue/onboarding-agreement/onboarding-agreement.service.js';
import adminCommunicationsRoutes from '../shared/communications/admin-communications.routes.js';
import ownerCommunicationsRoutes from '../shared/communications/owner-communications.routes.js';
import ownerDeviceRoutes from '../shared/communications/owner-device.routes.js';
import type { CommunicationsService } from '../shared/communications/communications.service.js';
import adminEpic08Routes from '../modules/admin/epic08/admin-epic08.routes.js';
import type { AdminEpic08Service } from '../modules/admin/epic08/admin-epic08.service.js';
import inventorySyncRoutes from '../modules/inventory-sync/inventory-sync.routes.js';
import type { InventorySyncService } from '../modules/inventory-sync/inventory-sync.service.js';
import treasuryRoutes from '../modules/treasury/treasury.routes.js';
import type { TreasuryService } from '../modules/treasury/treasury.service.js';

export interface ApiV1RoutesOptions {
  identityService: IdentityService;
  ownerAccessService: OwnerAccessService;
  adminAuthService: AdminAuthService;
  adminOnboardingService: AdminOnboardingService;
  kycService: KycService;
  partnerAccessService: PartnerAccessService;
  partnerPortalService: PartnerPortalService;
  partnerPayoutAccountService: PartnerPayoutAccountService;
  venueOwnerService: VenueOwnerService;
  courtOwnerService: CourtOwnerService;
  inventoryService: InventoryService;
  venueContentService: VenueContentService;
  ownerDashboardService: OwnerDashboardService;
  onboardingAgreementService: OnboardingAgreementService;
  payoutAccountService: PayoutAccountService;
  ownerBookingService: OwnerBookingService;
  bookingLifecycleService: BookingLifecycleService;
  contractService: ContractService;
  financialCloseService: FinancialCloseService;
  communicationsService: CommunicationsService;
  adminEpic08Service: AdminEpic08Service;
  inventorySyncService: InventorySyncService;
  treasuryService: TreasuryService;
}

const apiV1Routes: FastifyPluginAsync<ApiV1RoutesOptions> = async (
  fastify,
  options,
) => {
  fastify.get('/', async () => ({
    service: 'turf-gds-api',
    apiVersion: 'v1',
  }));

  await fastify.register(identityRoutes, {
    prefix: '/auth/venue-owners',
    service: options.identityService,
  });
  await fastify.register(ownerAccessRoutes, {
    prefix: '/auth/venue-owners',
    service: options.ownerAccessService,
  });
  await fastify.register(ownerDeviceRoutes, {
    prefix: '/auth/venue-owners',
    service: options.communicationsService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(ownerCommunicationsRoutes, {
    prefix: '/owner',
    service: options.communicationsService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(venueOwnerRoutes, {
    prefix: '/owner/venues',
    service: options.venueOwnerService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(courtOwnerRoutes, {
    prefix: '/owner/venues',
    service: options.courtOwnerService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(inventoryRoutes, {
    prefix: '/owner/venues',
    service: options.inventoryService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(venueContentRoutes, {
    prefix: '/owner/venues',
    service: options.venueContentService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(ownerDashboardRoutes, {
    prefix: '/owner/venues',
    service: options.ownerDashboardService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(onboardingAgreementRoutes, {
    service: options.onboardingAgreementService,
    ownerAccessService: options.ownerAccessService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(payoutAccountOwnerRoutes, {
    prefix: '/owner/venues',
    service: options.payoutAccountService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(ownerBookingRoutes, {
    prefix: '/owner/venues',
    service: options.ownerBookingService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(bookingLifecycleRoutes, {
    prefix: '/bookings',
    service: options.bookingLifecycleService,
    partnerAccessService: options.partnerAccessService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(adminAuthRoutes, {
    prefix: '/auth/admin',
    service: options.adminAuthService,
  });
  await fastify.register(adminOnboardingRoutes, {
    prefix: '/admin/onboarding',
    service: options.adminOnboardingService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(contractRoutes, {
    prefix: '/admin/contracts',
    service: options.contractService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(financialCloseRoutes, {
    prefix: '/admin/financial-close',
    service: options.financialCloseService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(ownerFinanceRoutes, {
    prefix: '/owner/venues',
    service: options.financialCloseService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(payoutAccountAdminRoutes, {
    prefix: '/admin/venues',
    service: options.payoutAccountService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(kycRoutes, {
    prefix: '/kyc',
    service: options.kycService,
    ownerAccessService: options.ownerAccessService,
    adminAuthService: options.adminAuthService,
    partnerAccessService: options.partnerAccessService,
  });
  await fastify.register(partnerAccessRoutes, {
    prefix: '/partners',
    service: options.partnerAccessService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(partnerPayoutAccountRoutes, {
    prefix: '/partners',
    service: options.partnerPayoutAccountService,
    partnerAccessService: options.partnerAccessService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(partnerPortalRoutes, {
    service: options.partnerPortalService,
    partnerAccessService: options.partnerAccessService,
  });
  await fastify.register(adminCommunicationsRoutes, {
    prefix: '/admin/communications',
    service: options.communicationsService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(adminEpic08Routes, {
    prefix: '/admin',
    service: options.adminEpic08Service,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(inventorySyncRoutes, {
    service: options.inventorySyncService,
    adminAuthService: options.adminAuthService,
    ownerAccessService: options.ownerAccessService,
  });
  await fastify.register(treasuryRoutes, {
    service: options.treasuryService,
    partnerAccessService: options.partnerAccessService,
    adminAuthService: options.adminAuthService,
  });
};

export default apiV1Routes;
