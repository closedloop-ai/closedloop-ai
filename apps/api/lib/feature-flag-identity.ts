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
  return (
    (await evaluateFeatureFlagForAnyIdentity(
      featureFlagKey,
      identity,
      logKey
    )) === true
  );
}

/**
 * ISS-4556: the same multi-identity rollout check as
 * {@link isFeatureFlagEnabledForAnyIdentity}, but reporting UNAVAILABLE
 * (`null`) distinctly from an evaluated `false`.
 *
 * The boolean wrapper above collapses the two, which is the right default for a
 * one-shot gate: an unreachable flag service must not open a dark-launched
 * feature. It is the wrong answer for a caller that needs several reads in one
 * page load to agree, because a transient outage on ONE of them silently
 * rewrites that read's cohort while its siblings keep the evaluated value. Such
 * a caller needs to see "could not evaluate" so it can hold its previous
 * decision instead of flipping.
 *
 * ISS-4556: UNAVAILABLE is now genuinely REACHABLE for the failure mode it was
 * built for. `isFeatureFlagEnabledForDistinctId` no longer folds posthog-node's
 * `undefined` — which is what a failed or unresolvable evaluation resolves to,
 * since it does not reject — into a definite `false`, so a PostHog outage reports
 * `null` here instead of masquerading as an evaluated OFF.
 *
 * @returns `true`/`false` when PostHog actually answered for at least one of the
 *   principal's distinct ids, `null` when no evaluation was possible (no
 *   analytics client configured, the client reported the flag unevaluated, or
 *   every evaluation threw).
 */
export async function evaluateFeatureFlagForAnyIdentity(
  featureFlagKey: string,
  identity: FeatureFlagIdentity,
  logKey: string
): Promise<boolean | null> {
  let evaluated = false;
  for (const distinctId of resolveDistinctIdsForIdentity(identity)) {
    // ISS-4556: the try/catch is PER ID, not wrapped around the loop. Wrapping
    // the loop meant a throw on a LATER id discarded a definite `false` already
    // returned for an EARLIER one and reported UNAVAILABLE instead — and
    // UNAVAILABLE tells the caller to hold its previous decision, so a viewer
    // whose flag was genuinely just turned OFF would keep being served the stale
    // ON. A per-id catch keeps every answer PostHog did give.
    let result: boolean | null = null;
    try {
      result = await isFeatureFlagEnabledForDistinctId(
        featureFlagKey,
        distinctId
      );
    } catch (error) {
      log.warn(logKey, {
        featureFlagKey,
        error: parseError(error),
      });
      continue;
    }
    if (result === true) {
      return true;
    }
    // `null` means no analytics client answered for this id; only a real
    // `false` counts as an evaluation that came back negative.
    evaluated = evaluated || result !== null;
  }
  return evaluated ? false : null;
}
