import { AppError } from '../../../shared/errors/app-error.js';
import type { DatabaseConnection } from '../../../shared/database/database-connection.js';
import type { KycService } from '../../identity/kyc/kyc.service.js';
import type { IdentityService } from '../../identity/owner/owner-auth.service.js';
import type { VenueService } from '../../venue/venue.service.js';

export interface AdminOnboardingService {
  approveVenueOnboarding(input: {
    ownerId: string;
    venueId: string;
    adminId: string;
    correlationId: string;
  }): Promise<void>;
}

export function createAdminOnboardingService(input: {
  identityService: IdentityService;
  kycService: KycService;
  venueService: VenueService;
  database: DatabaseConnection;
}): AdminOnboardingService {
  async function approveVenueOnboarding(values: {
    ownerId: string;
    venueId: string;
    adminId: string;
    correlationId: string;
  }): Promise<void> {
    await input.database.withTransaction(async ({ session }) => {
      const hasVerifiedBusinessKyc = await input.kycService.isVerified(
        'VENUE_OWNER',
        values.ownerId,
        'BUSINESS',
        session,
      );

      if (!hasVerifiedBusinessKyc) {
        throw new AppError({
          code: 'OWNER_KYC_REQUIRED',
          message: 'Verified BUSINESS KYC is required',
          statusCode: 409,
        });
      }

      await input.identityService.approveVenueOwner(values, session);
      await input.venueService.approveVenue(values, session);
    });
  }

  return { approveVenueOnboarding };
}
