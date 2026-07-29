import type { FastifyPluginAsync } from 'fastify';

import ownerBookingRoutes from '../modules/booking/owner-booking.routes.js';
import type { OwnerBookingService } from '../modules/booking/owner-booking.service.js';
import bookingLifecycleRoutes from '../modules/booking/booking-lifecycle.routes.js';
import type { BookingLifecycleService } from '../modules/booking/booking-lifecycle.service.js';
import contractRoutes from '../modules/contracts/contract.routes.js';
import type { ContractService } from '../modules/contracts/contract.service.js';
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
import adminAuthRoutes from '../modules/identity/platform/auth.routes.js';
import type { AdminAuthService } from '../modules/identity/platform/auth.service.js';
import courtOwnerRoutes from '../modules/venue/court-owner.routes.js';
import type { CourtOwnerService } from '../modules/venue/court-owner.service.js';
import venueOwnerRoutes from '../modules/venue/venue-owner.routes.js';
import type { VenueOwnerService } from '../modules/venue/venue-owner.service.js';
import venueOperationsRoutes from '../modules/venue/venue-operations.routes.js';
import type { VenueOperationsService } from '../modules/venue/venue-operations.service.js';

export interface ApiV1RoutesOptions {
  identityService: IdentityService;
  ownerAccessService: OwnerAccessService;
  adminAuthService: AdminAuthService;
  adminOnboardingService: AdminOnboardingService;
  kycService: KycService;
  partnerAccessService: PartnerAccessService;
  venueOwnerService: VenueOwnerService;
  courtOwnerService: CourtOwnerService;
  venueOperationsService: VenueOperationsService;
  ownerBookingService: OwnerBookingService;
  bookingLifecycleService: BookingLifecycleService;
  contractService: ContractService;
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
  await fastify.register(venueOperationsRoutes, {
    prefix: '/owner/venues',
    service: options.venueOperationsService,
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
  await fastify.register(kycRoutes, {
    prefix: '/kyc',
    service: options.kycService,
    ownerAccessService: options.ownerAccessService,
    adminAuthService: options.adminAuthService,
  });
  await fastify.register(partnerAccessRoutes, {
    prefix: '/partners',
    service: options.partnerAccessService,
    adminAuthService: options.adminAuthService,
  });
};

export default apiV1Routes;
