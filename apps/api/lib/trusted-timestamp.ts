/** Shared tolerance for producer clocks that lead a trusted server instant. */
export const MAX_TRUSTED_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Accept the exact skew boundary and reject only values beyond it. */
export function isWithinTrustedFutureBoundary(
  value: Date,
  trustedInstant: Date
): boolean {
  return (
    Number.isFinite(value.getTime()) &&
    value.getTime() <= trustedInstant.getTime() + MAX_TRUSTED_FUTURE_SKEW_MS
  );
}
