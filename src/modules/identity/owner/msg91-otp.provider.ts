import { AppError } from '../../../shared/errors/app-error.js';

export interface Msg91ProviderConfig {
  enabled: boolean;
  authKey?: string;
  baseUrl: string;
}

/** Pino-compatible. Optional so tests can construct a provider without one. */
export interface OtpLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Phone numbers are personal data, so logs carry a masked form: enough to correlate a failing
 * sign-in with a real person when someone reports one, not enough to be a leak on its own.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
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
  logger?: OtpLogger,
): OtpProvider {
  return {
    async verifyAccessToken({ accessToken }) {
      if (!config.enabled || !config.authKey) {
        // The single most common cause of "OTP login does nothing" in a deployment: the code
        // shipped but MSG91_ENABLED / MSG91_AUTH_KEY were never set on the host. Logged at error
        // because nothing about the request can succeed and the fix is an operator action.
        logger?.error(
          { enabled: config.enabled, hasAuthKey: Boolean(config.authKey) },
          'MSG91 not configured — set MSG91_ENABLED=true and MSG91_AUTH_KEY. Every OTP sign-in will fail until then.',
        );
        throw unavailable('MSG91 OTP verification is not configured');
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch(
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
      } catch (error) {
        // Transport-level: DNS, TLS, or the 15s timeout. Distinct from MSG91 rejecting the token,
        // and worth separating in logs because the remedy is completely different.
        logger?.error(
          { err: error, baseUrl: config.baseUrl, elapsedMs: Date.now() - startedAt },
          'MSG91 verifyAccessToken could not be reached',
        );
        throw new AppError({
          code: 'OTP_PROVIDER_ERROR',
          message: 'Could not reach the OTP provider',
          statusCode: 502,
        });
      }

      const value = (await response.json().catch(() => ({}))) as {
        type?: string;
        message?: string;
      };

      if (!response.ok || value.type !== 'success' || !value.message) {
        /**
         * MSG91 answers a rejected token with HTTP 200 and a non-success body, so the HTTP
         * status alone cannot tell "this token is no good" from "MSG91 is having a bad day".
         * A reachable MSG91 that refuses the token is the caller's problem — an expired or
         * replayed verification — and must surface as 401 so the client can say "that
         * verification failed, request a new code" rather than showing a gateway error for
         * what is a routine, user-recoverable outcome. Only an unreachable or erroring MSG91
         * is a 502.
         */
        const providerReachable = response.ok;
        logger?.warn(
          {
            providerStatus: response.status,
            providerType: value.type ?? null,
            // `message` carries the verified number on success and an error string on failure;
            // logging it raw would leak a phone number, so it is only surfaced when it is text.
            providerMessage:
              value.type === 'success' ? maskPhone(value.message ?? '') : (value.message ?? null),
            elapsedMs: Date.now() - startedAt,
            outcome: providerReachable ? 'token-rejected' : 'provider-error',
          },
          providerReachable
            ? 'MSG91 rejected the access token'
            : 'MSG91 returned an error response',
        );
        throw new AppError({
          code: providerReachable ? 'OTP_VERIFICATION_FAILED' : 'OTP_PROVIDER_ERROR',
          message: providerReachable
            ? 'That verification could not be confirmed. Request a new code and try again.'
            : 'The OTP provider could not verify this right now',
          statusCode: providerReachable ? 401 : 502,
          details: { providerStatus: response.status },
        });
      }

      const verifiedPhoneDigits = value.message.replace(/\D/g, '');
      logger?.info(
        { verifiedPhone: maskPhone(verifiedPhoneDigits), elapsedMs: Date.now() - startedAt },
        'MSG91 verified an access token',
      );
      return { verifiedPhoneDigits };
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
