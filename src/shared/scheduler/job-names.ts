/**
 * Job cadences, shared between the worker that runs them and the readiness
 * probe that decides whether they have gone stale.
 */
export const HOLD_RECOVERY_INTERVAL_MS = 60_000;
export const PAYOUT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

export const BACKGROUND_JOB_EXPECTATIONS = [
  { job: 'booking-hold-recovery', intervalMs: HOLD_RECOVERY_INTERVAL_MS },
  {
    job: 'treasury-payout-reconciliation',
    intervalMs: PAYOUT_RECONCILIATION_INTERVAL_MS,
  },
] as const;
