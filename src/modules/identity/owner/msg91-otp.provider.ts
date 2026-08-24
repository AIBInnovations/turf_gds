import { AppError } from '../../../shared/errors/app-error.js';

export interface Msg91ProviderConfig {
  enabled: boolean;
  authKey?: string;
  baseUrl: string;
}

export interface OtpProvider {
  /**
   * Confirms an access token issued by MSG91's client-side widget flow was genuinely produced by
   * MSG91 for a real OTP verification, and returns the phone number MSG91 itself attests to —
   * never the phone number the caller claims. Callers must compare this against the claimed
   * phoneE164 themselves; a valid token for one phone must never authenticate a different one.
   */
  verifyAccessToken(input: {
    accessToken: string;
  }): Promise<{ verifiedPhoneDigits: string }>;
}

export function createMsg91OtpProvider(
  config: Msg91ProviderConfig,
): OtpProvider {
  return {
    async verifyAccessToken({ accessToken }) {
      if (!config.enabled || !config.authKey) {
        throw unavailable('MSG91 OTP verification is not configured');
      }

      const response = await fetch(
        `${config.baseUrl}/api/v5/widget/verifyAccessToken`,
        {
          method: 'POST',
          headers: {
            authkey: config.authKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ 'access-token': accessToken }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      const value = (await response.json().catch(() => ({}))) as {
        type?: string;
        message?: string;
      };

      if (!response.ok || value.type !== 'success' || !value.message) {
        throw new AppError({
          code: 'OTP_PROVIDER_ERROR',
          message: 'MSG91 access-token verification failed',
          statusCode: response.status === 401 || response.status === 400 ? 401 : 502,
          details: { providerStatus: response.status },
        });
      }

      return { verifiedPhoneDigits: value.message.replace(/\D/g, '') };
    },
  };
}

function unavailable(message: string) {
  return new AppError({
    code: 'OTP_PROVIDER_NOT_CONFIGURED',
    message,
    statusCode: 503,
  });
}
