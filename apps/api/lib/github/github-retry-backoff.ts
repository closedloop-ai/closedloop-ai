/**
 * Exponential backoff for a GitHub read that failed for a reason time can fix.
 *
 * Owned here rather than by any one sweep: the PR reconciler and the observed-
 * repository verifier both draw from the same credential pool and both need the
 * same restraint after a transient failure, so a second curve would let one of
 * them hammer a rate-limited token while the other waited.
 *
 * The count is what makes it exponential — pass ONLY failures the caller means
 * to back off from. A refusal that is evidence about reach (a 403/404) or about
 * the org's credentials (no token could be drawn) belongs to its own counter,
 * not to this one.
 */

export const BACKOFF_BASE_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function computeNextRetryAt(
  consecutiveFailureCount: number,
  now: Date
): Date {
  const count = consecutiveFailureCount >= 1 ? consecutiveFailureCount : 1;
  const exponent = Math.min(count - 1, 49);
  const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  return new Date(now.getTime() + delayMs);
}
