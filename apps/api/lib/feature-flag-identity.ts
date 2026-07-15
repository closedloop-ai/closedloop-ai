import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/**
 * Request principal for a server-side, per-user feature-flag check. Both the
 * Clerk user id and the internal user id are evaluated because a rollout may be
 * targeted at either distinct-id namespace.
 */
export type FeatureFlagIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

/**
 * Distinct, de-duplicated PostHog distinct ids for a request principal, in
 * `clerkUserId`-then-`userId` order with empty values dropped.
 */
export function resolveDistinctIdsForIdentity(
  identity: FeatureFlagIdentity
): string[] {
  return [
    ...new Set(
      [identity.clerkUserId, identity.userId].filter((value): value is string =>
        Boolean(value)
      )
    ),
  ];
}

/**
 * Fail-closed, multi-identity rollout check. Returns true only when an explicit
 * `true` comes back from the exact PostHog key for at least one of the
 * principal's distinct ids; unavailable, false, null, or a thrown evaluation
 * all resolve to false so a dark-launched feature stays unreachable outside the
 * flag.
 *
 * @param logKey - Structured-log event name emitted when flag evaluation throws.
 */
export async function isFeatureFlagEnabledForAnyIdentity(
  featureFlagKey: string,
  identity: FeatureFlagIdentity,
  logKey: string
): Promise<boolean> {
  try {
    for (const distinctId of resolveDistinctIdsForIdentity(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(
          featureFlagKey,
          distinctId
        )) === true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn(logKey, {
      featureFlagKey,
      error: parseError(error),
    });
    return false;
  }
}
